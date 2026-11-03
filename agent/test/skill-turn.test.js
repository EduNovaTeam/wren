import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SECTIONS } from '../src/context.js';
import { loadCatalog } from '../src/skills/catalog.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { runTurn } from '../src/turn.js';
import { activateSkill, readSkillResource } from '../src/tools/skills.js';
import { tempDir, writeSkill } from './support/skills.js';

const schema = { type: 'object', properties: {} };
let callSeq = 0;

const text = (content) => ({ message: { role: 'assistant', content } });
const call = (name, args = {}) => ({
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: `call_${++callSeq}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  },
});

function makeRegistry(counter) {
  return new ToolRegistry()
    .register({
      name: 'current_time', description: '', parameters: schema,
      execute: () => {
        counter.time = (counter.time ?? 0) + 1;
        counter.onTime?.();
        return 'now';
      },
    })
    .register({
      name: 'fetch_url', description: '', parameters: schema, exposure: 'on-demand',
      execute: () => { counter.fetch += 1; return '网页正文'; },
    })
    .register(activateSkill)
    .register(readSkillResource);
}

function scripted(replies) {
  const requests = [];
  const complete = async (req) => {
    requests.push(req);
    const next = replies[Math.min(requests.length - 1, replies.length - 1)];
    const reply = typeof next === 'function' ? next(req) : next;
    return { message: reply.message, finishReason: 'stop', usage: null };
  };
  complete.requests = requests;
  return complete;
}

function fakeBackend(initial = {}) {
  return {
    state: { skill_switches: {}, tool_switches: {}, active_skills: [], ...initial },
    calls: [],
    gets: 0,
    failGetAfter: null,
    async request(method, path, body) {
      this.calls.push({ method, path, body });
      if (method === 'GET' && path.endsWith('/skills/state')) {
        this.gets += 1;
        if (this.failGetAfter !== null && this.gets > this.failGetAfter) {
          throw new Error('状态接口不可用');
        }
        return JSON.parse(JSON.stringify(this.state));
      }
      if (method === 'PUT' && path.includes('/skills/')) {
        const name = decodeURIComponent(path.split('/').pop());
        if (!this.state.active_skills.some((row) => row.name === name)) {
          this.state.active_skills.push({ name, source: body.source, activated_at: 't' });
        }
        return { name, source: body.source };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    session_id: 1,
    turn_id: 2,
    model: {
      base_url: 'http://x', model: 'fake', api_key: 'k', thinking: 'default',
      reasoning_effort: '', max_steps: 5, history_budget_tokens: 10_000,
    },
    system_prompt: '',
    tool_switches: {},
    skill_switches: {},
    active_skills: [],
    history: [],
    user_message: { role: 'user', content: '帮我写周报' },
    ...overrides,
  };
}

async function run(ctx, { skillDir, backend, complete, counter = { fetch: 0 } }) {
  const events = [];
  const deps = {
    registry: makeRegistry(counter),
    sections: DEFAULT_SECTIONS,
    backend,
    complete,
    skillOptions: {
      builtinDir: skillDir,
      userDir: undefined,
      bodyBudgetTokens: 4000,
      indexBudgetTokens: 1200,
      totalBodyBudgetTokens: 12_000,
    },
  };
  await runTurn(ctx, deps, (event) => events.push(event), new AbortController().signal);
  return events;
}

const systemOf = (req) => req.messages[0].content;
const toolMsgOf = (req, id) => req.messages.find((m) => m.tool_call_id === id);

async function weeklySkillDir() {
  const dir = await tempDir();
  await writeSkill(dir, 'weekly-report', {
    fields: { description: '写周报', 'allowed-tools': 'fetch_url' },
    body: 'BODY-MARKER 先读 references/template.md。',
    files: { 'references/template.md': '# 周报模板\n' },
  });
  return dir;
}

test('activation opens tools on the next request and avoids duplicating the body', async () => {
  const skillDir = await weeklySkillDir();
  const backend = fakeBackend();
  const counter = { fetch: 0 };
  const complete = scripted([
    call('activate_skill', { name: 'weekly-report' }),
    text('写好了'),
  ]);
  const events = await run(makeCtx(), { skillDir, backend, complete, counter });

  const [first, second] = complete.requests;
  assert.deepEqual(
    first.tools.map((t) => t.function.name),
    ['current_time', 'activate_skill', 'read_skill_resource'],
  );
  assert.ok(!systemOf(first).includes('BODY-MARKER'));
  assert.deepEqual(first.messages.at(-1), { role: 'user', content: '帮我写周报' });

  // 激活后，下一次请求才出现按需工具；正文作为工具结果返回，系统提示不重复承载。
  assert.match(toolMsgOf(second, 'call_1').content, /BODY-MARKER/);
  assert.ok(!systemOf(second).includes('BODY-MARKER'));
  assert.ok(second.tools.some((t) => t.function.name === 'fetch_url'));
  assert.deepEqual(backend.state.active_skills.map((row) => row.name), ['weekly-report']);
  assert.equal(events.at(-1).status, 'done');
  assert.ok(events.some((e) => e.type === 'skill_activated' && e.trigger === 'tool'));
  assert.equal(counter.fetch, 0);
});

test('a tool call in the same response cannot use the just-activated permission', async () => {
  const skillDir = await weeklySkillDir();
  const backend = fakeBackend();
  const counter = { fetch: 0 };
  // 同一个响应里两个调用：先激活，再试图用新开放的工具。
  const reply = call('activate_skill', { name: 'weekly-report' });
  reply.message.tool_calls.push(
    call('fetch_url', { url: 'https://example.com' }).message.tool_calls[0],
  );
  const complete = scripted([reply, text('结束')]);
  const events = await run(makeCtx(), { skillDir, backend, complete, counter });

  assert.equal(counter.fetch, 0);
  const toolMessages = events.filter((e) => e.type === 'message' && e.message.role === 'tool')
    .map((e) => e.message);
  assert.match(toolMessages[1].content, /不可用/);
  assert.ok(complete.requests[1].tools.some((t) => t.function.name === 'fetch_url'));
});

test('/skill-name at the start activates before the first request', async () => {
  const skillDir = await weeklySkillDir();
  const backend = fakeBackend();
  const complete = scripted([text('好的')]);
  const events = await run(makeCtx({ user_message: { role: 'user', content: '/weekly-report 整理这周工作' } }), {
    skillDir, backend, complete,
  });

  assert.match(systemOf(complete.requests[0]), /BODY-MARKER/);
  assert.ok(complete.requests[0].tools.some((t) => t.function.name === 'fetch_url'));
  assert.equal(complete.requests[0].messages.at(-1).content, '/weekly-report 整理这周工作');
  assert.ok(events.some((e) => e.type === 'skill_activated' && e.trigger === 'command'));
  assert.deepEqual(backend.state.active_skills.map((row) => row.name), ['weekly-report']);
  assert.equal(events.at(-1).status, 'done');
});

test('unknown or disabled /skill-name fails the turn with a clear error', async () => {
  const skillDir = await weeklySkillDir();

  const unknown = scripted([text('不该发生')]);
  const events = await run(makeCtx({ user_message: { role: 'user', content: '/missing hi' } }), {
    skillDir, backend: fakeBackend(), complete: unknown,
  });
  assert.equal(events.at(-1).status, 'failed');
  assert.match(events.at(-1).error, /不存在/);
  assert.equal(unknown.requests.length, 0);

  const disabled = scripted([text('不该发生')]);
  const events2 = await run(
    makeCtx({
      user_message: { role: 'user', content: '/weekly-report hi' },
      skill_switches: { 'weekly-report': false },
    }),
    { skillDir, backend: fakeBackend(), complete: disabled },
  );
  assert.equal(events2.at(-1).status, 'failed');
  assert.match(events2.at(-1).error, /已停用/);
  assert.equal(disabled.requests.length, 0);

  const invalidDir = await tempDir();
  await writeSkill(invalidDir, 'broken', {
    fields: { description: '依赖缺失', 'allowed-tools': 'missing_tool' },
  });
  const invalid = scripted([text('不该发生')]);
  const events3 = await run(
    makeCtx({ user_message: { role: 'user', content: '/broken hi' } }),
    { skillDir: invalidDir, backend: fakeBackend(), complete: invalid },
  );
  assert.equal(events3.at(-1).status, 'failed');
  assert.match(events3.at(-1).error, /missing_tool/);
  assert.equal(invalid.requests.length, 0);
});

test('invalid skills do not break activation of valid ones', async () => {
  const dir = await tempDir();
  await writeSkill(dir, 'broken', {
    fields: { description: '缺工具', 'allowed-tools': 'run_sql' },
    body: 'BROKEN',
  });
  await writeSkill(dir, 'good', { fields: { description: '好的' }, body: 'GOOD' });
  const backend = fakeBackend();
  const reply = call('activate_skill', { name: 'broken' });
  reply.message.tool_calls.push(call('activate_skill', { name: 'good' }).message.tool_calls[0]);
  const complete = scripted([reply, text('结束')]);
  const events = await run(makeCtx(), { skillDir: dir, backend, complete });
  const tools = events.filter((e) => e.type === 'message' && e.message.role === 'tool')
    .map((e) => e.message.content);

  assert.match(tools[0], /不可用/);
  assert.match(tools[0], /run_sql/);
  assert.doesNotMatch(tools[0], /BROKEN/);
  assert.match(tools[1], /GOOD/);
  assert.deepEqual(backend.state.active_skills.map((row) => row.name), ['good']);
});

test('repeated activation is idempotent within a turn', async () => {
  const dir = await tempDir();
  await writeSkill(dir, 'weekly', { fields: { description: '周报' } });
  const backend = fakeBackend();
  const complete = scripted([
    call('activate_skill', { name: 'weekly' }),
    call('activate_skill', { name: 'weekly' }),
    text('好的'),
  ]);
  const events = await run(makeCtx(), { skillDir: dir, backend, complete });
  const toolMessages = events.filter((e) => e.type === 'message' && e.message.role === 'tool')
    .map((e) => e.message.content);
  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[1], /已启用/);
  assert.equal(backend.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('disabling a tool after the request but before execution revokes the call', async () => {
  const dir = await tempDir();
  await writeSkill(dir, 'web', {
    fields: { description: '网页', 'allowed-tools': 'fetch_url' },
  });
  const backend = fakeBackend();
  const counter = { fetch: 0 };
  const complete = scripted([
    (req) => {
      void req;
      backend.state.tool_switches = { fetch_url: false };
      return call('fetch_url', { url: 'https://example.com' });
    },
    text('结束'),
  ]);
  const events = await run(
    makeCtx({ active_skills: [{ name: 'web' }] }),
    { skillDir: dir, backend, complete, counter },
  );
  const results = events.filter((e) => e.type === 'message' && e.message.role === 'tool')
    .map((e) => e.message.content);
  assert.equal(counter.fetch, 0);
  assert.match(results[0], /不可用/);
  assert.ok(!complete.requests[1].tools.some((t) => t.function.name === 'fetch_url'));
});

test('the body is not injected twice when the activation turn is still in history', async () => {
  const dir = await weeklySkillDir();
  const backend = fakeBackend({ active_skills: [{ name: 'weekly-report', source: 'builtin' }] });
  const complete = scripted([text('继续')]);
  const body = 'BODY-MARKER 先读 references/template.md。';
  const history = [{
    turn_id: 1,
    status: 'done',
    messages: [
      { role: 'user', content: '写周报' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: '',
        tool_calls: [{
          id: 'call_a',
          type: 'function',
          function: { name: 'activate_skill', arguments: '{"name":"weekly-report"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_a', name: 'activate_skill', content: `已启用：${body}` },
      { role: 'assistant', content: '完成', reasoning_content: '' },
    ],
  }];
  const events = await run(makeCtx({ history }), { skillDir: dir, backend, complete });
  const req = complete.requests[0];
  assert.ok(!systemOf(req).includes('BODY-MARKER'));
  // 正文在历史里，工具权限仍然按已激活 Skill 开放。
  assert.ok(req.tools.some((t) => t.function.name === 'fetch_url'));
  assert.equal(events.at(-1).status, 'done');
});

test('disabling a skill after the request but before execution revokes its tool', async () => {
  const dir = await tempDir();
  await writeSkill(dir, 'web', {
    fields: { description: '网页', 'allowed-tools': 'fetch_url' },
  });
  const backend = fakeBackend({ active_skills: [{ name: 'web' }] });
  const counter = { fetch: 0 };
  const complete = scripted([
    () => {
      backend.state.skill_switches = { web: false };
      return call('fetch_url', { url: 'https://example.com' });
    },
    text('结束'),
  ]);
  const events = await run(
    makeCtx({ active_skills: [{ name: 'web' }] }),
    { skillDir: dir, backend, complete, counter },
  );
  const results = events.filter((e) => e.type === 'message' && e.message.role === 'tool')
    .map((e) => e.message.content);
  assert.equal(counter.fetch, 0);
  assert.match(results[0], /不可用/);
  assert.ok(!complete.requests[1].tools.some((t) => t.function.name === 'fetch_url'));
  assert.ok(events.some((e) => e.type === 'skill_unavailable' && e.name === 'web'));
});

test('revoking a tool between two calls of one response is enforced', async () => {
  const backend = fakeBackend();
  const counter = {
    fetch: 0,
    onTime: () => {
      backend.state.tool_switches = { current_time: false };
    },
  };
  const reply = call('current_time');
  reply.message.tool_calls.push(call('current_time').message.tool_calls[0]);
  const complete = scripted([reply, text('结束')]);
  const events = await run(
    makeCtx(),
    { skillDir: await tempDir(), backend, complete, counter },
  );
  const results = events.filter((e) => e.type === 'message' && e.message.role === 'tool')
    .map((e) => e.message.content);
  assert.equal(counter.time, 1);
  assert.match(results[1], /不可用/);
  assert.ok(!complete.requests[1].tools.some((t) => t.function.name === 'current_time'));
});

test('an unreadable permission state blocks tool execution', async () => {
  const backend = fakeBackend();
  const counter = { fetch: 0, time: 0 };
  const complete = scripted([
    () => {
      // 请求前读取成功；执行前开始失败。
      backend.failGetAfter = backend.gets;
      return call('current_time');
    },
    text('结束'),
  ]);
  const events = await run(
    makeCtx(),
    { skillDir: await tempDir(), backend, complete, counter },
  );
  const results = events.filter((e) => e.type === 'message' && e.message.role === 'tool')
    .map((e) => e.message.content);
  assert.equal(counter.time, 0);
  assert.match(results[0], /无法确认.*权限/);
  assert.match(results[0], /已拒绝执行/);
  assert.equal(events.at(-1).status, 'done');
});

test('an activated skill keeps working when history is truncated', async () => {
  const dir = await weeklySkillDir();
  const backend = fakeBackend({ active_skills: [{ name: 'weekly-report', source: 'builtin' }] });
  const complete = scripted([text('继续')]);
  const bigHistory = [{
    turn_id: 1,
    status: 'done',
    messages: [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答'.repeat(100) },
    ],
  }];
  const events = await run(
    makeCtx({ history: bigHistory, model: { ...makeCtx().model, history_budget_tokens: 1 } }),
    { skillDir: dir, backend, complete },
  );
  const req = complete.requests[0];
  assert.match(systemOf(req), /BODY-MARKER/);
  assert.ok(req.tools.some((t) => t.function.name === 'fetch_url'));
  assert.equal(req.messages.filter((m) => m.role === 'user').length, 1);
  const info = events.find((e) => e.type === 'turn_info');
  assert.equal(info.dropped_turns, 1);
});
