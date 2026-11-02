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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeLLM } from '../agent/test/support/fake-llm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const dataDir = mkdtempSync(join(tmpdir(), 'wren-e2e-'));
const children = [];

async function main() {
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
    PYTHONUNBUFFERED: '1',
  };
  start('backend', python(), ['-m', 'wren'], join(root, 'backend'), env);
  start('agent', process.execPath, ['src/server.js'], join(root, 'agent'), env);

  const base = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${base}/api/health`);
  await waitFor(`http://127.0.0.1:${agentPort}/health`);

  await call('PUT', `${base}/api/settings/model`, { base_url: llm.url, api_key: 'fake-key', model: 'fake' });
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
  const roles = turns[0].messages.map((m) => m.role).join(',');
  check(roles === 'user,assistant,tool,assistant', `落库消息应为 user,assistant,tool,assistant，实际 ${roles}`);
  const { notes } = await call('GET', `${base}/api/notes`);
  check(notes.length === 1 && notes[0].title === '冒烟测试', `笔记未写入：${JSON.stringify(notes)}`);

  const second = llm.requests[1];
  check(second.messages.some((m) => m.role === 'tool'), '第二次模型请求应包含工具结果');

  // skill：agent 按需从 /internal/skills 取正文，验证两边的接口对得上
  const skill = await call('GET', `${base}/internal/skills/weekly-report`, undefined, {
    'X-Wren-Internal-Token': 'e2e-token',
  });
  check(skill.files.includes('references/template.md'), `skill 应带模板文件：${skill.files}`);
  llm.push(
    { reasoning: '按周报 skill 写', tool_calls: [{ name: 'use_skill', arguments: { name: 'weekly-report' } }] },
    { text: '已读取周报 skill。' },
  );
  const skillTurn = await call('POST', `${base}/api/sessions/${session.id}/turns`, { content: '帮我写周报' });
  const skillEvents = await readSse(`${base}/api/turns/${skillTurn.turn_id}/events`);
  check(skillEvents.at(-1)?.status === 'done', `第二个回合应以 done 结束：${JSON.stringify(skillEvents.at(-1))}`);
  const toolMessage = skillEvents.find((e) => e.type === 'message' && e.message.role === 'tool');
  check(toolMessage && toolMessage.message.content.includes('# 写周报'), 'skill 正文没有进入工具结果');

  // 用户用 /skill-name 点名：正文由后端随上下文下发，模型不必再调工具
  llm.push({ text: '好的，按周报 skill 的格式写。' });
  const invoked = await call('POST', `${base}/api/sessions/${session.id}/turns`, {
    content: '/weekly-report 本周做了 A',
  });
  const invokedEvents = await readSse(`${base}/api/turns/${invoked.turn_id}/events`);
  check(
    invokedEvents.at(-1)?.status === 'done',
    `点名 skill 的回合应以 done 结束：${JSON.stringify(invokedEvents.at(-1))}`,
  );
  const system = llm.requests.at(-1).messages[0];
  check(
    system.role === 'system' && system.content.includes('# 写周报'),
    `点名 skill 的正文没有进入系统提示：${String(system.content).slice(0, 200)}`,
  );

  await llm.close();
  console.log(`e2e ok：${types.length} 个事件，${turns[0].messages.length} 条消息`);
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

/** @param {string} method @param {string} url @param {unknown} [body] @param {Record<string,string>} [headers] */
async function call(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
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
    setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 300);
  });
