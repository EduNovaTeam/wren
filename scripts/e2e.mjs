#!/usr/bin/env node
/**
 * 端到端冒烟：真实启动后端与 agent，模型换成 fake LLM，跑一个带工具调用的回合并核对落库结果。
 * 不需要 API key，CI 里也跑这个。
 *
 *   node scripts/e2e.mjs
 *
 * 需要后端依赖已安装（backend/.venv 或当前 Python 环境里有 wren-backend）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeLLM } from '../agent/test/support/fake-llm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const dataDir = mkdtempSync(join(tmpdir(), 'wren-e2e-'));
const userSkillsDir = join(dataDir, 'user-skills');
const children = [];
let base = '';
/** @type {Awaited<ReturnType<typeof startFakeLLM>> | null} */
let llm = null;

async function main() {
  // 用户目录里的 Skill：验证「可配置的用户来源」和来源标记。
  mkdirSync(join(userSkillsDir, 'user-note'), { recursive: true });
  writeFileSync(
    join(userSkillsDir, 'user-note', 'SKILL.md'),
    ['---', 'name: user-note', 'description: 用户目录里的示例 Skill。', '---', '', '# 用户 Skill', ''].join('\n'),
  );

  llm = await startFakeLLM({
    replies: [
      // /weekly-report 自动激活后，模型先读模板。
      { reasoning: '先读模板', tool_calls: [{ name: 'read_skill_resource',
        arguments: { name: 'weekly-report', path: 'references/template.md' } }] },
      { text: '这是按模板整理的周报。' },
      // 同一会话的第二回合：不再传 /命令，激活状态仍然生效。
      { text: '已补上两条。' },
      // /web-research 自动激活：声明了 fetch_url。
      { text: '请提供要查证的网址。' },
      // 笔记
      { reasoning: '用户要记笔记', text: '好的，', tool_calls: [{ name: 'save_note',
        arguments: { title: '冒烟测试', body: '这是一条端到端测试写入的笔记' } }] },
      { reasoning: '已保存', text: '已经记下了。' },
    ],
  });
  const [backendPort, agentPort] = [await freePort(), await freePort()];
  const env = {
    ...process.env,
    WREN_INTERNAL_TOKEN: 'e2e-token',
    WREN_BACKEND_PORT: String(backendPort),
    WREN_AGENT_PORT: String(agentPort),
    WREN_DATA_DIR: dataDir,
    WREN_SKILLS_DIR: userSkillsDir,
    PYTHONUNBUFFERED: '1',
  };
  start('backend', python(), ['-m', 'wren'], join(root, 'backend'), env);
  start('agent', process.execPath, ['src/server.js'], join(root, 'agent'), env);

  base = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${base}/api/health`);
  await waitFor(`http://127.0.0.1:${agentPort}/health`);

  await call('PUT', `${base}/api/settings/model`, { base_url: llm.url, api_key: 'fake-key', model: 'fake' });

  // ---- Skill：/命令激活、资源读取、跨回合生效 ---------------------------------
  const skillSession = await call('POST', `${base}/api/sessions`);
  const weekly = await runTurn(skillSession.id, '/weekly-report 本周完成了登录页联调');
  const weeklyTypes = weekly.events.map((e) => e.type);
  check(weekly.end?.status === 'done', `周报回合应以 done 结束：${JSON.stringify(weekly.end)}`);
  for (const t of ['skill_activated', 'tool_start', 'tool_end']) {
    check(weeklyTypes.includes(t), `周报事件流里缺少 ${t}：${weeklyTypes.join(',')}`);
  }
  const template = weekly.events.find(
    (e) => e.type === 'message' && e.message.role === 'tool' && e.message.name === 'read_skill_resource',
  );
  check(template?.message.content.includes('# 周报模板'), 'read_skill_resource 没有返回模板正文');
  check(llm.requests[0].messages[0].content.includes('按团队模板撰写个人周报'), '自动激活后正文应在系统提示里');
  check(
    llm.requests[0].tools.every((t) => t.function.name !== 'fetch_url'),
    '未声明 allowed-tools 的 Skill 不应开放 fetch_url',
  );

  const skillRows = (await call('GET', `${base}/api/sessions/${skillSession.id}/skills`)).skills;
  check(
    skillRows.length === 1 && skillRows[0].name === 'weekly-report' && skillRows[0].status === 'ok',
    `会话激活状态未保存：${JSON.stringify(skillRows)}`,
  );

  const secondTurn = await runTurn(skillSession.id, '再补两条');
  check(secondTurn.end?.status === 'done', '第二回合应正常结束');
  check(
    llm.requests[2].messages[0].content.includes('先读'),
    '第二回合应继续注入已激活 Skill 的正文',
  );

  const catalog = (await call('GET', `${base}/api/skills`)).skills;
  const byName = Object.fromEntries(catalog.map((s) => [s.name, s]));
  check(byName['weekly-report']?.enabled === true, '内置 Skill 应在列表里且默认启用');
  check(byName['metrics-query']?.valid === false, '依赖 run_sql 的 Skill 应显示不可用');
  check(byName['metrics-query']?.missing_tools.includes('run_sql'), '应列出缺失的工具');
  check(byName['user-note']?.source === 'user', '用户目录里的 Skill 来源应为 user');
  await call('PUT', `${base}/api/skills`, { 'weekly-report': false });
  const off = (await call('GET', `${base}/api/skills`)).skills.find((s) => s.name === 'weekly-report');
  check(off.enabled === false, '全局停用未生效');
  await call('PUT', `${base}/api/skills`, { 'weekly-report': true });

  // allowed-tools 打开按需工具：web-research 声明了 fetch_url。
  const webSession = await call('POST', `${base}/api/sessions`);
  const web = await runTurn(webSession.id, '/web-research 帮我查一下资料');
  check(web.end?.status === 'done', '网页调研回合应正常结束');
  const webNames = llm.requests[3].tools.map((t) => t.function.name);
  check(webNames.includes('fetch_url'), `激活后下一次请求应开放 fetch_url：${webNames.join(',')}`);

  // ---- 笔记 -------------------------------------------------------------------
  const session = await call('POST', `${base}/api/sessions`);
  const notesTurn = await runTurn(session.id, '帮我记一下：冒烟测试');
  const types = notesTurn.events.map((e) => e.type);
  check(notesTurn.end?.status === 'done', `笔记回合应以 done 结束：${JSON.stringify(notesTurn.end)}`);
  for (const t of ['turn_info', 'tool_start', 'tool_end', 'note_saved']) {
    check(types.includes(t), `事件流里缺少 ${t}：${types.join(',')}`);
  }

  const { turns } = await call('GET', `${base}/api/sessions/${session.id}/turns`);
  const roles = turns[0].messages.map((m) => m.role).join(',');
  check(roles === 'user,assistant,tool,assistant', `落库消息应为 user,assistant,tool,assistant，实际 ${roles}`);
  const { notes } = await call('GET', `${base}/api/notes`);
  check(notes.length === 1 && notes[0].title === '冒烟测试', `笔记未写入：${JSON.stringify(notes)}`);

  const second = llm.requests[5];
  check(second.messages.some((m) => m.role === 'tool'), '第二次模型请求应包含工具结果');

  await llm.close();
  llm = null;
  console.log(
    `e2e ok：Skill ${catalog.length} 个，事件 ${types.length} 个，消息 ${turns[0].messages.length} 条`,
  );
}

/** 发起一个回合并读完事件流。 */
async function runTurn(sessionId, content) {
  const { turn_id: turnId } = await call('POST', `${base}/api/sessions/${sessionId}/turns`, { content });
  const events = await readSse(`${base}/api/turns/${turnId}/events`);
  return { events, end: events.at(-1) };
}

/** @param {boolean} cond @param {string} message */
function check(cond, message) {
  if (!cond) throw new Error(message);
}

function python() {
  const venv = isWin
    ? join(root, 'backend', '.venv', 'Scripts', 'python.exe')
    : join(root, 'backend', '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  return isWin ? 'python' : 'python3';
}

/**
 * @param {string} name @param {string} cmd @param {string[]} args @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
function start(name, cmd, args, cwd, env) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(d));
  child.stderr.on('data', (d) => log.push(d));
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[${name}] 退出 code=${code}\n${Buffer.concat(log).toString()}`);
    }
  });
  children.push({ name, child, log });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** @param {string} url */
async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error(`等待 ${url} 超时`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** @param {string} method @param {string} url @param {unknown} [body] */
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** @param {string} url */
async function readSse(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)));
}

main()
  .catch((err) => {
    console.error(`e2e 失败：${err.message}`);
    for (const { name, log } of children) {
      console.error(`----- ${name} 输出 -----\n${Buffer.concat(log).toString().slice(-4000)}`);
    }
    process.exitCode = 1;
  })
  .finally(() => {
    for (const { child } of children) child.kill();
    if (llm) llm.close();
    setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 300);
  });
