import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createAgentServer } from '../src/server.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { startFakeLLM } from './support/fake-llm.js';

const TOKEN = 't';
/** @type {Awaited<ReturnType<typeof startFakeLLM>>} */
let llm;
/** @type {import('node:http').Server} */
let server;
let agentUrl = '';
/** @type {Map<number, any>} */
const contexts = new Map();

const fakeBackend = /** @type {any} */ ({
  async turnContext(/** @type {number} */ id) {
    const ctx = contexts.get(id);
    if (!ctx) throw new Error('404');
    return ctx;
  },
});

const registry = new ToolRegistry()
  .register({
    name: 'add', description: '加法', parameters: { type: 'object', properties: {} },
    execute: ({ a, b }) => String(a + b),
  })
  .register({
    name: 'wait', description: '', parameters: { type: 'object', properties: {} },
    execute: (_args, { signal }) => new Promise((_, reject) => signal.addEventListener('abort',
      () => reject(signal.reason))),
  })
  .register({
    name: 'secret', description: '只有 skill 要才给', parameters: { type: 'object', properties: {} },
    exposure: 'on-demand',
    execute: () => '密文',
  });

before(async () => {
  llm = await startFakeLLM();
  server = createAgentServer({
    config: { host: '127.0.0.1', port: 0, backendUrl: '', internalToken: TOKEN },
    deps: { backend: fakeBackend, registry },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  agentUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await llm.close();
});

let nextTurn = 1;
function newTurn(overrides = {}) {
  const id = nextTurn++;
  contexts.set(id, {
    session_id: 1,
    turn_id: id,
    model: { base_url: llm.url, model: 'fake', api_key: 'k', thinking: 'default',
      reasoning_effort: '', max_steps: 4, history_budget_tokens: 10000 },
    system_prompt: '',
    tool_switches: {},
    history: [],
    user_message: { role: 'user', content: '1+2?' },
    ...overrides,
  });
  return id;
}

/** @param {number} turnId */
async function runTurn(turnId, { onEvent = (/** @type {any} */ _e) => {} } = {}) {
  const res = await fetch(`${agentUrl}/turns`, {
    method: 'POST',
    headers: { 'X-Wren-Internal-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 1, turn_id: turnId }),
  });
  assert.equal(res.status, 200);
  const events = [];
  let buf = '';
  for await (const chunk of /** @type {any} */ (res.body)) {
    buf += Buffer.from(chunk).toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const e = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      events.push(e);
      onEvent(e);
    }
  }
  return events;
}

const messages = (events) => events.filter((e) => e.type === 'message').map((e) => e.message);

test('tool call round-trip passes reasoning_content back', async () => {
  llm.push(
    { reasoning: '要算', tool_calls: [{ name: 'add', arguments: { a: 1, b: 2 } }] },
    { reasoning: '有结果了', text: '等于 3' },
  );
  const events = await runTurn(newTurn());
  assert.deepEqual(events.at(-1), { type: 'turn_end', status: 'done' });
  assert.deepEqual(messages(events).map((m) => m.role), ['assistant', 'tool', 'assistant']);
  assert.equal(messages(events)[1].content, '3');

  const second = llm.requests.at(-1);
  assert.equal(second.messages[0].role, 'system');
  assert.equal(second.messages.at(-2).reasoning_content, '要算');
  assert.equal(second.messages.at(-1).role, 'tool');
  assert.equal('name' in second.messages.at(-1), false);
});

test('tool list is fixed per turn and honors switches', async () => {
  llm.push({ text: 'ok' });
  const events = await runTurn(newTurn({ tool_switches: { wait: false } }));
  assert.deepEqual(events.find((e) => e.type === 'turn_info').tools, ['add']);
  assert.deepEqual(llm.requests.at(-1).tools.map((t) => t.function.name), ['add']);
});

test('a skill brings its allowed tools into the turn', async () => {
  llm.push({ text: 'ok' });
  const events = await runTurn(newTurn({
    active_skills: [{
      name: 'research', description: '', body: '', files: [], reason: 'invoked',
      allowed_tools: ['secret', 'not_registered'],
    }],
  }));
  assert.deepEqual(events.find((e) => e.type === 'turn_info').tools, ['add', 'wait', 'secret']);
  assert.deepEqual(llm.requests.at(-1).tools.map((t) => t.function.name),
    ['add', 'wait', 'secret']);
  // 工具清单是接口参数，模型未必会翻；提示里要明说已经开放，且不能说没注册的那个
  const system = llm.requests.at(-1).messages[0].content;
  assert.match(system, /本回合已经开放：secret/);
  assert.doesNotMatch(system, /not_registered/);
});

test('tools from a skill are gone once it is not active', async () => {
  llm.push({ text: 'ok' });
  await runTurn(newTurn());
  assert.deepEqual(llm.requests.at(-1).tools.map((t) => t.function.name), ['add', 'wait']);
});

test('history from backend is sent with reasoning_content normalized', async () => {
  llm.push({ text: 'ok' });
  await runTurn(newTurn({
    history: [{ turn_id: 0, status: 'stopped', messages: [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: '半截' },
    ] }],
  }));
  const sent = llm.requests.at(-1).messages;
  assert.deepEqual(sent.slice(1, 3), [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: '半截', reasoning_content: '' },
  ]);
});

test('step limit forbids further tool calls on the last step', async () => {
  const loop = { tool_calls: [{ name: 'add', arguments: { a: 1, b: 1 } }] };
  llm.push(loop, (req) => (req.tool_choice === 'none' ? { text: '停' } : loop));
  const turnId = newTurn();
  contexts.get(turnId).model.max_steps = 2;
  const events = await runTurn(turnId);
  assert.equal(llm.requests.at(-1).tool_choice, 'none');
  assert.equal(events.at(-1).status, 'done');
});

test('abort during streaming keeps partial text and ends stopped', async () => {
  llm.push({ text: '这是一段会被打断的回答', delayMs: 30, hang: true });
  const turnId = newTurn();
  let aborted = false;
  const events = await runTurn(turnId, {
    onEvent: (e) => {
      if (e.type === 'text_delta' && !aborted) {
        aborted = true;
        fetch(`${agentUrl}/turns/${turnId}/abort`, { method: 'POST',
          headers: { 'X-Wren-Internal-Token': TOKEN } });
      }
    },
  });
  assert.equal(events.at(-1).status, 'stopped');
  const saved = messages(events);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].content.length > 0);
});

test('abort during a tool call ends stopped', async () => {
  llm.push({ tool_calls: [{ name: 'wait', arguments: {} }] });
  const turnId = newTurn();
  const events = await runTurn(turnId, {
    onEvent: (e) => {
      if (e.type === 'tool_start') {
        fetch(`${agentUrl}/turns/${turnId}/abort`, { method: 'POST',
          headers: { 'X-Wren-Internal-Token': TOKEN } });
      }
    },
  });
  assert.equal(events.at(-1).status, 'stopped');
});

test('model error ends turn failed with message', async () => {
  llm.push({ status: 401 });
  const events = await runTurn(newTurn());
  assert.equal(events.at(-1).status, 'failed');
  assert.match(events.at(-1).error, /401/);
});

test('retryable error before any output is retried', async () => {
  llm.push({ status: 503 }, { text: '恢复了' });
  const events = await runTurn(newTurn());
  assert.equal(events.at(-1).status, 'done');
  assert.equal(messages(events)[0].content, '恢复了');
});

test('requests without token are rejected', async () => {
  const res = await fetch(`${agentUrl}/tools`);
  assert.equal(res.status, 401);
});
