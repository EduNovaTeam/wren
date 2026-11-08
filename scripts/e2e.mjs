#!/usr/bin/env node
/**
 * 端到端冒烟：真实启动后端与 agent，模型换成 fake LLM，跑笔记回合与技能流程并核对落库结果。
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeLLM } from '../agent/test/support/fake-llm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const dataDir = mkdtempSync(join(tmpdir(), 'wren-e2e-'));
const children = [];

async function main() {
  writeUserSkill();

  const llm = await startFakeLLM({
    replies: [
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
    WREN_SKILLS_DIR: join(dataDir, 'skills'),
    WREN_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
    WREN_AGENT_URL: `http://127.0.0.1:${agentPort}`,
    PYTHONUNBUFFERED: '1',
  };
  start('backend', python(), ['-m', 'wren'], join(root, 'backend'), env);
  start('agent', process.execPath, ['src/server.js'], join(root, 'agent'), env);

  try {
    const base = `http://127.0.0.1:${backendPort}`;
    await waitFor(`${base}/api/health`);
    await waitFor(`http://127.0.0.1:${agentPort}/health`);

    await call('PUT', `${base}/api/settings/model`, { base_url: llm.url, api_key: 'fake-key', model: 'fake' });
    await scenarioNotes(base, llm);
    console.log('场景 1 笔记 ok');
    const { explicit, auto } = await scenarioSkills(base, llm);
    console.log('场景 2-4 技能 ok');
    await scenarioToggle(base, explicit, auto);
    console.log('场景 5 开关 ok');
    await scenarioStop(base, llm);
    console.log('场景 6 中止 ok');
  } finally {
    await llm.close();
  }
  console.log('e2e ok');
}

function writeUserSkill() {
  const dir = join(dataDir, 'skills', 'weekly-report');
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    'name: weekly-report',
    'description: 生成测试周报',
    'allowed-tools: fetch_url run_sql',
    '---',
    'E2E-USER-SKILL 请先读取 references/template.md，再写周报。',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'references', 'template.md'), 'E2E-TEMPLATE 本周总结/下周计划\n');
}

/** 场景 1：保存笔记、reasoning 完整落库与 SSE 事件；基线的技能元数据可见但无正文。 */
async function scenarioNotes(base, llm) {
  const session = await call('POST', `${base}/api/sessions`);
  const { turn_id: turnId } = await call('POST', `${base}/api/sessions/${session.id}/turns`,
    { content: '帮我记一下：冒烟测试' });

  const events = await readSse(`${base}/api/turns/${turnId}/events`);
  const types = events.map((e) => e.type);
  const end = events.at(-1);
  check(end?.type === 'turn_end' && end.status === 'done', `回合应以 done 结束，实际 ${JSON.stringify(end)}`);
  for (const t of ['turn_info', 'tool_start', 'tool_end', 'note_saved']) {
    check(types.includes(t), `事件流里缺少 ${t}：${types.join(',')}`);
  }

  const { turns } = await call('GET', `${base}/api/sessions/${session.id}/turns`);
  const messages = turns[0].messages;
  const roles = messages.map((m) => m.role).join(',');
  check(roles === 'user,assistant,tool,assistant', `落库消息应为 user,assistant,tool,assistant，实际 ${roles}`);
  const reasoning = messages.filter((m) => m.role === 'assistant').map((m) => m.reasoning_content ?? '').join('');
  check(reasoning.includes('用户要记笔记') && reasoning.includes('已保存'), 'assistant reasoning 应完整落库');
  const { notes } = await call('GET', `${base}/api/notes`);
  check(notes.length === 1 && notes[0].title === '冒烟测试', `笔记未写入：${JSON.stringify(notes)}`);

  const first = llm.requests[0];
  check(first, '应有一次基线模型请求');
  check(!toolNames(first).includes('fetch_url'), '基线第一模型请求不应暴露 fetch_url');
  const system = systemText(first);
  check(!system.includes('E2E-USER-SKILL'), '基线 system 不应含用户技能正文');
  check(!system.includes('# 错误码速查'), '基线 system 不应含内置大技能正文');

  const second = llm.requests[1];
  check(second.messages.some((m) => m.role === 'tool'), '第二次模型请求应包含工具结果');
  return session;
}

/** 场景 2-4：显式技能、跨轮保持、auto 加载与工具权限。 */
async function scenarioSkills(base, llm) {
  // 场景 2：显式 /weekly-report
  const explicit = await call('POST', `${base}/api/sessions`);
  const startIndex = llm.requests.length;
  llm.push(
    { reasoning: '先读模板', text: '读模板。', tool_calls: [{ name: 'read_skill_resource',
      arguments: { skill: 'weekly-report', path: 'references/template.md' } }] },
    { reasoning: '模板已读', text: '周报完成' },
  );
  const { turn_id } = await call('POST', `${base}/api/sessions/${explicit.id}/turns`,
    { content: '/weekly-report 生成周报' });
  const events = await readSse(`${base}/api/turns/${turn_id}/events`);
  const end = events.at(-1);
  check(end?.type === 'turn_end' && end.status === 'done', `显式技能回合应 done，实际 ${JSON.stringify(end)}`);
  const activated = events.find((e) => e.type === 'skill_activated');
  check(activated, '应收到 skill_activated 事件');
  check(activated.name === 'weekly-report' && activated.source === 'user',
    `skill_activated 应为 user/weekly-report，实际 ${JSON.stringify(activated)}`);
  check(Array.isArray(activated.missing_tools) && activated.missing_tools.includes('run_sql'),
    `missing_tools 应含 run_sql，实际 ${JSON.stringify(activated.missing_tools)}`);

  const req = llm.requests[startIndex];
  check(req, '显式技能应有模型请求');
  check(systemText(req).includes('E2E-USER-SKILL'), '显式技能请求 system 应含用户技能正文');
  check(toolNames(req).includes('fetch_url'), '显式技能请求应暴露 fetch_url');
  check(!toolNames(req).includes('run_sql'), '未注册的 run_sql 不应出现在 schemas');
  check(req.messages.at(-1).content === '生成周报', '模型应收到去掉命令后的用户消息');
  const toolResult = llm.requests[startIndex + 1].messages
    .filter((m) => m.role === 'tool').map(msgText).join('\n');
  check(toolResult.includes('E2E-TEMPLATE'), '工具结果应含 E2E-TEMPLATE');

  const { turns } = await call('GET', `${base}/api/sessions/${explicit.id}/turns`);
  const userMsg = turns[0].messages.find((m) => m.role === 'user');
  check(userMsg && userMsg.content.includes('/weekly-report'), 'GET turns 应保留原始命令');

  const active = await call('GET', `${base}/api/sessions/${explicit.id}/skills`);
  check(active.skills?.some((s) => s.name === 'weekly-report'), '会话技能应包含 weekly-report');

  // 场景 3：同一会话下一轮，技能持续
  const idx3 = llm.requests.length;
  llm.push({ reasoning: '精简一下', text: '已精简的周报。' });
  const { turn_id: turnId3 } = await call('POST', `${base}/api/sessions/${explicit.id}/turns`,
    { content: '再精简一点' });
  const events3 = await readSse(`${base}/api/turns/${turnId3}/events`);
  const end3 = events3.at(-1);
  check(end3?.type === 'turn_end' && end3.status === 'done', `第三轮应 done，实际 ${JSON.stringify(end3)}`);
  const req3 = llm.requests[idx3];
  check(req3 && systemText(req3).includes('E2E-USER-SKILL'), '第三轮 system 应仍含技能正文');
  const active3 = await call('GET', `${base}/api/sessions/${explicit.id}/skills`);
  check(active3.skills?.some((s) => s.name === 'weekly-report'), '第三轮后会话技能仍应包含 weekly-report');

  // 场景 4：新会话 auto
  const auto = await call('POST', `${base}/api/sessions`);
  const beforeEmpty = await call('GET', `${base}/api/sessions/${auto.id}/skills`);
  check((beforeEmpty.skills ?? []).length === 0, '新会话技能应为空');
  const idx4 = llm.requests.length;
  llm.push(
    { reasoning: '自动加载并抓取', text: '准备加载。', tool_calls: [
      { name: 'load_skill', arguments: { name: 'weekly-report' } },
      { name: 'fetch_url', arguments: { url: 'https://example.com' } },
    ] },
    { reasoning: '读资源', text: '读取资源。', tool_calls: [
      { name: 'read_skill_resource', arguments: { skill: 'weekly-report', path: '../secret.txt' } },
      { name: 'read_skill_resource', arguments: { skill: 'weekly-report', path: 'references/template.md' } },
    ] },
    { reasoning: '完成', text: '自动周报完成' },
  );
  const { turn_id: autoTurn } = await call('POST', `${base}/api/sessions/${auto.id}/turns`,
    { content: '帮我做个周报' });
  const autoEvents = await readSse(`${base}/api/turns/${autoTurn}/events`);
  const autoEnd = autoEvents.at(-1);
  check(autoEnd?.type === 'turn_end' && autoEnd.status === 'done',
    `auto 回合应 done，实际 ${JSON.stringify(autoEnd)}`);

  const req4a = llm.requests[idx4];
  check(req4a, 'auto 第一请求存在');
  const sys4a = systemText(req4a);
  check(!sys4a.includes('E2E-USER-SKILL'), 'auto 第一请求 system 不应含技能正文');
  check(sys4a.includes('weekly-report'), 'auto 第一请求应可见技能元数据');
  const req4b = llm.requests[idx4 + 1];
  check(req4b, 'auto 第二请求存在');
  check(systemText(req4b).includes('E2E-USER-SKILL'), 'auto 第二请求 system 应含技能正文');
  check(toolNames(req4b).includes('fetch_url'), 'auto 第二请求应暴露 fetch_url');

  const req4c = llm.requests[idx4 + 2];
  check(req4c, 'auto 第三请求存在');
  const toolMsgs = req4c.messages.filter((m) => m.role === 'tool');
  const fetchCall = req4b.messages.flatMap((m) => m.tool_calls ?? [])
    .find((c) => c.function.name === 'fetch_url');
  const fetchResult = toolMsgs.find((m) => m.tool_call_id === fetchCall?.id);
  const batchResults = toolMsgs.map(msgText).join('\n');
  check(batchResults.includes('E2E-TEMPLATE'), '模板读取应成功');
  check(/secret|越界|outside|invalid|不允许|路径/i.test(batchResults), '路径越界应报错');
  check(fetchResult?.content.startsWith('错误：工具 fetch_url 不存在或当前不可用'),
    '同批 fetch_url 必须在执行前被拒绝');
  const escapedCall = req4c.messages.flatMap((m) => m.tool_calls ?? [])
    .find((c) => c.function.name === 'read_skill_resource' &&
      JSON.parse(c.function.arguments).path === '../secret.txt');
  check(toolMsgs.some((m) => m.tool_call_id === escapedCall?.id && m.content.startsWith('错误：')),
    '越界资源调用必须返回工具错误');
  const firstToolResults = req4b.messages.filter((m) => m.role === 'tool').map(msgText).join('\n');
  check(/错误|error|unknown|不可用|disabled|not/i.test(firstToolResults),
    `同批 fetch_url 工具结果应为错误，实际 ${firstToolResults.slice(0, 200)}`);

  const active4 = await call('GET', `${base}/api/sessions/${auto.id}/skills`);
  check(active4.skills?.some((s) => s.name === 'weekly-report'), 'auto 会话应激活 weekly-report');

  const empty = await call('POST', `${base}/api/sessions`);
  const emptySkills = await call('GET', `${base}/api/sessions/${empty.id}/skills`);
  check((emptySkills.skills ?? []).length === 0, '另一空新会话 active 应为空');

  return { explicit, auto };
}

/** 场景 5：关闭/开启每周报，两个会话 active 均清空。 */
async function scenarioToggle(base, explicit, auto) {
  await call('PUT', `${base}/api/settings/skills`, { 'weekly-report': false });
  for (const s of [explicit, auto]) {
    const res = await call('GET', `${base}/api/sessions/${s.id}/skills`);
    check((res.skills ?? []).length === 0, `关闭后会话 ${s.id} active 应清空`);
  }
  await call('PUT', `${base}/api/settings/skills`, { 'weekly-report': true });
  for (const s of [explicit, auto]) {
    const res = await call('GET', `${base}/api/sessions/${s.id}/skills`);
    check((res.skills ?? []).length === 0, `重新开启后会话 ${s.id} active 应仍为空`);
  }
}

/** 场景 6：流式读 SSE，在首个 text_delta 时中止，验证 stopped 与 partial 落库。 */
async function scenarioStop(base, llm) {
  const session = await call('POST', `${base}/api/sessions`);
  llm.push({ reasoning: '准备', text: '这段回答将被中止并保存', delayMs: 30, hang: true });
  const { turn_id } = await call('POST', `${base}/api/sessions/${session.id}/turns`,
    { content: '/weekly-report 写一段' });
  let sawDelta = false;
  const events = await readSse(`${base}/api/turns/${turn_id}/events`, async (event) => {
    if (!sawDelta && event.type === 'text_delta') {
      sawDelta = true;
      await call('POST', `${base}/api/turns/${turn_id}/stop`);
    }
  });
  check(sawDelta, '应在 turn_end 前收到 text_delta');
  const end = events.at(-1);
  check(end?.type === 'turn_end' && end.status === 'stopped', `回合应以 stopped 结束，实际 ${JSON.stringify(end)}`);

  const { turns } = await call('GET', `${base}/api/sessions/${session.id}/turns`);
  const partial = turns[0].messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content ?? '')
    .join('');
  check(partial.trim().length > 0, '应保存非空 partial assistant 内容');
  check('这段回答将被中止并保存'.startsWith(partial), `partial 应是原文的前缀，实际 ${partial}`);
  const active = await call('GET', `${base}/api/sessions/${session.id}/skills`);
  check(active.skills?.some((s) => s.name === 'weekly-report'), '中止后技能状态应仍正确');
}

/** @param {boolean} cond @param {string} message */
function check(cond, message) {
  if (!cond) throw new Error(message);
}

/** @param {any} req */
function toolNames(req) {
  return (req.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean);
}

/** @param {any} req */
function systemText(req) {
  return (req.messages ?? []).filter((m) => m.role === 'system').map(msgText).join('\n');
}

/** @param {any} msg */
function msgText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
  }
  return '';
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
  if (res.status === 204) return {};
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/**
 * 流式读取 SSE：逐帧解析，支持可选异步回调，UTF-8 跨块正确。
 * @param {string} url
 * @param {(event: any) => void|Promise<void>} [onEvent]
 */
async function readSse(url, onEvent) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const events = [];
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let ended = false;

  const handleFrame = async (frame) => {
    const lines = frame.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      const event = JSON.parse(data);
      events.push(event);
      if (event.type === 'turn_end') ended = true;
      if (onEvent) await onEvent(event);
    }
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      await handleFrame(frame);
      if (ended) return events;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await handleFrame(buffer);
  return events;
}

/** 递归删除前确认是本次创建的临时目录。 */
function cleanupDataDir() {
  const tmp = resolve(tmpdir());
  const target = resolve(dataDir);
  const rel = relative(tmp, target);
  const inside = rel && !rel.startsWith('..') && !isAbsolute(rel);
  const isOurs = target.startsWith(join(tmp, 'wren-e2e-')) ||
    (isWin && target.toLowerCase().startsWith(join(tmp, 'wren-e2e-').toLowerCase()));
  if (inside && isOurs) {
    rmSync(target, { recursive: true, force: true });
  }
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
    setTimeout(cleanupDataDir, 300);
  });
