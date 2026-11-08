/**
 * 技能发现模块与其在 runTurn 中的集成测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry, runTool } from '../src/tools/registry.js';
import { registerSkillDiscovery, renderSkillDiscovery } from '../src/skill-discovery.js';
import { runTurn } from '../src/turn.js';
import { DEFAULT_SECTIONS } from '../src/context.js';
import { startFakeLLM } from './support/fake-llm.js';

const SKILLS = [
  { name: 'weather', description: '查天气', source: 'builtin', valid: true, enabled: true },
  { name: 'broken', description: '坏技能', source: 'builtin', valid: false, enabled: true },
  { name: 'off', description: '关闭技能', source: 'builtin', valid: true, enabled: false },
];

/** 构建注册表与 active 状态。 */
function setup({ activateCalls = [] } = {}) {
  const registry = new ToolRegistry();
  const active = new Map();
  const activate = async (name) => {
    activateCalls.push(name);
    active.set(name, { name, body: `{正文:${name}}` });
    return { name, source: 'builtin', missing_tools: [] };
  };
  registerSkillDiscovery(registry, SKILLS, activate, () => [...active.keys()]);
  return { registry, active, activateCalls };
}

/** 构造一个消费 fake-llm 的请求转发后端。 */
function fakeBackend(llm, turnId, activateCalls = []) {
  return {
    async request(method, path, body) {
      if (method === 'POST' && /\/skills\/.+\/activate$/.test(path)) {
        const name = decodeURIComponent(path.split('/').at(-2));
        activateCalls.push(name);
        return { skill: { name, body: `{正文:${name}}`, source: 'builtin', allowed_tools: ['fetch_url'], valid: true } };
      }
      throw new Error(`意外请求 ${method} ${path}`);
    },
    turnId,
  };
}

/** 收集事件。 */
function collect() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

/** 构造 runTurn 所需 ctx。 */
function makeCtx({ registry, backend, llm, active, emit }) {
  return {
    session_id: 1,
    turn_id: 2,
    skills: { available: SKILLS, active },
    system_prompt: '', tool_switches: {}, history: [],
    user_message: { role: 'user', content: '帮我查询天气' },
    model: { base_url: llm.url, model: 'fake', api_key: 'k', thinking: 'disabled',
      reasoning_effort: '', max_steps: 4, history_budget_tokens: 10000 },
  };
}

// --- 模块测试 ---

test('registerSkillDiscovery 注册 on-demand 工具且拒绝坏参数', async () => {
  const { registry } = setup();
  const tool = registry.get('load_skill');
  assert.equal(tool.exposure, 'on-demand');
  assert.deepEqual(tool.parameters.required, ['name']);
});

test('load_skill 严格验证并返回简短元信息', async () => {
  const { registry, activateCalls } = setup();
  const tool = registry.get('load_skill');
  const ctx = { signal: new AbortController().signal };

  await assert.rejects(() => tool.execute({}, ctx), /name 必须是非空字符串/);
  await assert.rejects(() => tool.execute({ name: 'nope' }, ctx), /未知技能：nope/);
  await assert.rejects(() => tool.execute({ name: 'broken' }, ctx), /当前无效/);
  await assert.rejects(() => tool.execute({ name: 'off' }, ctx), /已禁用/);

  const out = await tool.execute({ name: 'weather' }, ctx);
  assert.deepEqual(out, { name: 'weather', source: 'builtin' });
  assert.deepEqual(activateCalls, ['weather']);
});

test('load_skill 对已激活技能不重复回调', async () => {
  const { registry } = setup();
  const active = new Map([['weather', {}]]);
  const reg = new ToolRegistry();
  const calls = [];
  registerSkillDiscovery(reg, SKILLS, async (n) => { calls.push(n); return { name: n }; }, () => [...active.keys()]);
  const out = await reg.get('load_skill').execute({ name: 'weather' }, { signal: new AbortController().signal });
  assert.deepEqual(out, { name: 'weather', note: '本会话已激活' });
  assert.deepEqual(calls, []);
  void registry;
});

test('renderSkillDiscovery 只显示未激活有效启用技能', () => {
  const text = renderSkillDiscovery(SKILLS, []);
  assert.ok(text.includes('weather'));
  assert.ok(text.includes('查天气'));
  assert.ok(!text.includes('broken'));
  assert.ok(!text.includes('off'));
  assert.ok(!text.includes('正文'));
  assert.equal(renderSkillDiscovery(SKILLS, ['weather']), null);
});

// --- runTurn 集成测试 ---

test('集成：load_skill 后下一次请求追加正文并开放工具', async () => {
  const llm = await startFakeLLM({
    replies: [
      { reasoning: 'r1', text: '先加载', tool_calls: [
        { name: 'load_skill', arguments: { name: 'weather' } },
        { name: 'fetch_url', arguments: { url: 'http://x' } },
      ] },
      { text: '再取', tool_calls: [{ name: 'fetch_url', arguments: { url: 'http://x' } }] },
      { text: '完成' },
    ],
  });
  try {
    let fetchCount = 0;
    const registry = new ToolRegistry().register({ name: 'fetch_url', exposure: 'on-demand',
      description: '测试抓取', parameters: { type: 'object', properties: {} },
      execute() { fetchCount++; return '公开页面'; } });
    const active = [];
    const { events, emit } = collect();
    const backendCalls = [];
    const ctx = makeCtx({ registry, active, emit, llm, backend: fakeBackend(llm, 2, backendCalls) });

    await runTurn(ctx, { registry, backend: ctx.backend ?? fakeBackend(llm, 2, backendCalls),
      sections: DEFAULT_SECTIONS }, emit, new AbortController().signal);

    assert.equal(llm.requests.length, 3);
    const r1 = llm.requests[0];
    assert.ok(r1.tools.some((t) => t.function.name === 'load_skill'));
    assert.ok(!r1.tools.some((t) => t.function.name === 'fetch_url'));
    assert.ok(!r1.messages[0].content.includes('正文'));

    const r2 = llm.requests[1];
    assert.ok(r2.messages[0].content.includes('正文:weather'));
    assert.ok(r2.tools.some((t) => t.function.name === 'fetch_url'));
    assert.ok(r2.messages.some((m) => m.role === 'tool' && /不可用/.test(m.content)));
    assert.equal(backendCalls.filter((n) => n === 'weather').length, 1);

    assert.ok(events.some((e) => e.type === 'text_delta'));
    assert.equal(fetchCount, 1);
    assert.ok(events.some((e) => e.type === 'reasoning_delta'));
    assert.equal(events.at(-1).type, 'turn_end');
    assert.equal(events.at(-1).status, 'done');
    assert.equal(registry.get('load_skill'), undefined, '回合工具不能污染原注册表');
  } finally {
    await llm.close();
  }
});

test('集成：关闭 load_skill 时不自动加载', async () => {
  const llm = await startFakeLLM({ replies: [{ text: '好的' }] });
  try {
    const registry = new ToolRegistry();
    const active = [];
    const { emit } = collect();
    const ctx = makeCtx({ registry, active, emit, llm, backend: fakeBackend(llm, 2) });
    ctx.tool_switches = { load_skill: false };
    await runTurn(ctx, { registry, backend: fakeBackend(llm, 2), sections: DEFAULT_SECTIONS },
      emit, new AbortController().signal);
    const req = llm.requests[0];
    assert.ok(!(req.tools ?? []).some((t) => t.function.name === 'load_skill'));
    assert.ok(!req.messages[0].content.includes('可用技能'));
  } finally {
    await llm.close();
  }
});

test('runTool 拒绝不可见工具', async () => {
  const { registry } = setup();
  const res = await runTool(registry, new Set(), {
    id: 'c1', type: 'function', function: { name: 'load_skill', arguments: '{"name":"weather"}' },
  }, { sessionId: 1, turnId: 2, signal: new AbortController().signal, backend: {}, emit: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.content, /不可用/);
});
