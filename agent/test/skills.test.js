/**
 * 技能：显式 /name 激活、跨回合正文注入、allowed-tools 开放与安全资源读取。
 * 全部使用 fake-llm，不访问真实模型。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SECTIONS } from '../src/context.js';
import { registerResourceTool, prepareSkills } from '../src/skills.js';
import { ToolRegistry, runTool } from '../src/tools/registry.js';
import { runTurn } from '../src/turn.js';
import { startFakeLLM } from './support/fake-llm.js';

/** 一个没有技能的完整 ctx。 @param {object} [over] */
function baseCtx(over = {}) {
  return {
    session_id: 1,
    turn_id: 1,
    model: {
      base_url: '',
      model: 'fake',
      api_key: 'x',
      thinking: 'disabled',
      reasoning_effort: '',
      max_steps: 3,
      history_budget_tokens: 100000,
    },
    system_prompt: '',
    tool_switches: {},
    history: [],
    user_message: { role: 'user', content: '你好' },
    ...over,
  };
}

/** 带默认工具和 on-demand 工具的注册表。 */
function baseRegistry() {
  const r = new ToolRegistry();
  r.register({
    name: 'current_time',
    description: '时间',
    parameters: { type: 'object', properties: {} },
    execute: () => 'now',
  });
  r.register({
    name: 'save_note',
    description: '保存',
    parameters: { type: 'object', properties: {} },
    execute: () => 'ok',
  });
  r.register({
    name: 'search_notes',
    description: '搜索',
    parameters: { type: 'object', properties: {} },
    execute: () => 'ok',
  });
  r.register({
    name: 'fetch_url',
    description: '抓取',
    exposure: 'on-demand',
    parameters: { type: 'object', properties: {} },
    execute: () => 'html',
  });
  return r;
}

/** 脚本化的后端，记录调用。 */
function fakeBackend(handler) {
  const calls = [];
  return {
    calls,
    async request(method, path, body, signal) {
      calls.push({ method, path, body });
      return handler(method, path, body, signal);
    },
  };
}

/** 固定技能数据。 */
const SKILL_BODY = '这是 metrics-query 的完整正文：请先调用 fetch_url 再引用 run_sql。';
function skillsInput({ active = [], available } = {}) {
  return {
    available: available ?? [
      {
        name: 'metrics-query',
        description: '查指标',
        source: '/skills/metrics',
        allowed_tools: ['fetch_url', 'run_sql'],
        valid: true,
        enabled: true,
      },
      {
        name: 'disabled-skill',
        description: '禁用',
        source: '/skills/disabled',
        allowed_tools: [],
        valid: true,
        enabled: false,
      },
    ],
    active,
  };
}

/** 收集事件。 */
function collector() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

/** @param {string} content */
function userTurn(content, turn_id, history = []) {
  return baseCtx({ turn_id, user_message: { role: 'user', content }, history });
}

test('显式 /name：去掉命令且不改动原 ctx 对象', async () => {
  const llm = await startFakeLLM({ replies: [{ text: '好的' }] });
  try {
    const ctx = baseCtx({
      model: { ...baseCtx().model, base_url: llm.url },
      user_message: { role: 'user', content: '/metrics-query 帮我看看昨天的数据' },
      skills: skillsInput(),
    });
    const original = structuredClone(ctx);
    const backend = fakeBackend((_m, path) => {
      assert.match(path, /\/skills\/metrics-query\/activate$/);
      return { skill: { name: 'metrics-query', body: SKILL_BODY } };
    });
    const { events, emit } = collector();
    await runTurn(ctx, { registry: baseRegistry(), sections: DEFAULT_SECTIONS, backend }, emit, new AbortController().signal);

    assert.deepEqual(ctx, original, '原 ctx 不能被修改');
    const req = llm.requests[0];
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    assert.equal(lastUser.content, '帮我看看昨天的数据');
    const info = events.find((e) => e.type === 'turn_info');
    assert.deepEqual(info.skills, ['metrics-query']);
    const activated = events.find((e) => e.type === 'skill_activated');
    assert.equal(activated.name, 'metrics-query');
    assert.deepEqual(activated.missing_tools, ['run_sql']);
  } finally {
    await llm.close();
  }
});

test('仅命令：用默认引导语作为用户消息', async () => {
  const llm = await startFakeLLM({ replies: [{ text: '好' }] });
  try {
    const ctx = baseCtx({
      model: { ...baseCtx().model, base_url: llm.url },
      user_message: { role: 'user', content: '/metrics-query' },
      skills: skillsInput(),
    });
    const backend = fakeBackend(() => ({ skill: { name: 'metrics-query', body: SKILL_BODY } }));
    const { emit } = collector();
    await runTurn(ctx, { registry: baseRegistry(), sections: DEFAULT_SECTIONS, backend }, emit, new AbortController().signal);
    const lastUser = [...llm.requests[0].messages].reverse().find((m) => m.role === 'user');
    assert.equal(lastUser.content, '请按技能说明帮助用户；信息不足先询问。');
  } finally {
    await llm.close();
  }
});

test('未知/禁用技能：直接 failed，不调用模型也不发用户消息', async () => {
  const llm = await startFakeLLM({ replies: [{ text: '不应被调用' }] });
  try {
    for (const content of ['/nope 测试', '/disabled-skill 测试']) {
      const ctx = baseCtx({
        model: { ...baseCtx().model, base_url: llm.url },
        user_message: { role: 'user', content },
        skills: skillsInput(),
      });
      const backend = fakeBackend(() => {
        throw new Error('不应激活');
      });
      const { events, emit } = collector();
      await runTurn(ctx, { registry: baseRegistry(), sections: DEFAULT_SECTIONS, backend }, emit, new AbortController().signal);
      const end = events.at(-1);
      assert.equal(end.type, 'turn_end');
      assert.equal(end.status, 'failed');
      assert.match(end.error, /技能|未知/);
    }
    assert.equal(llm.requests.length, 0);
  } finally {
    await llm.close();
  }
});

test('全部技能禁用时，显式指令仍然报错', async () => {
  const events = [];
  await runTurn(baseCtx({
    skills: { available: [], active: [] },
    user_message: { role: 'user', content: '/metrics-query 测试' },
  }), { registry: baseRegistry(), sections: DEFAULT_SECTIONS, backend: fakeBackend(() => null) },
  (event) => events.push(event), new AbortController().signal);
  assert.equal(events.at(-1).status, 'failed');
  assert.match(events.at(-1).error, /技能/);
});

test('跨回合：历史被预算裁掉也不影响下一轮 active 正文注入', async () => {
  const llm = await startFakeLLM({ replies: [{ text: '第二轮回答' }] });
  try {
    const active = [
      { name: 'metrics-query', source: '/skills/metrics', allowed_tools: ['fetch_url', 'run_sql'], body: SKILL_BODY },
    ];
    const ctx = baseCtx({
      model: { ...baseCtx().model, base_url: llm.url, history_budget_tokens: 1 },
      user_message: { role: 'user', content: '继续' },
      skills: skillsInput({ active }),
      history: [
        {
          turn_id: 1,
          status: 'done',
          messages: [
            { role: 'user', content: '/metrics-query 上一轮' },
            { role: 'assistant', content: '上一轮回答'.repeat(200) },
          ],
        },
      ],
    });
    const backend = fakeBackend(() => {
      throw new Error('已是 active，不应重复激活');
    });
    const { events, emit } = collector();
    await runTurn(ctx, { registry: baseRegistry(), sections: DEFAULT_SECTIONS, backend }, emit, new AbortController().signal);
    const sys = llm.requests[0].messages[0];
    assert.equal(sys.role, 'system');
    assert.ok(sys.content.includes(SKILL_BODY), '系统提示应含已激活正文');
    const info = events.find((e) => e.type === 'turn_info');
    assert.equal(info.dropped_turns, 1);
    assert.deepEqual(info.skills, ['metrics-query']);
  } finally {
    await llm.close();
  }
});

test('未使用的技能全文不出现', async () => {
  const llm = await startFakeLLM({ replies: [{ text: '回答' }] });
  try {
    const ctx = baseCtx({
      model: { ...baseCtx().model, base_url: llm.url },
      user_message: { role: 'user', content: '普通问题' },
      skills: {
        available: [
          ...skillsInput().available,
          { name: 'other', description: '其它', source: '/s/other', allowed_tools: [], valid: true, enabled: true },
        ],
        active: [],
      },
    });
    const backend = fakeBackend(() => {
      throw new Error('不应激活');
    });
    const { events, emit } = collector();
    await runTurn(ctx, { registry: baseRegistry(), sections: DEFAULT_SECTIONS, backend }, emit, new AbortController().signal);
    const sys = llm.requests[0].messages[0];
    assert.ok(!sys.content.includes(SKILL_BODY));
    assert.ok(!sys.content.includes('## 技能'));
    const info = events.find((e) => e.type === 'turn_info');
    assert.deepEqual(info.skills, []);
  } finally {
    await llm.close();
  }
});

test('会话不串：A 激活后 B 未带 active 不出现正文', async () => {
  const llm = await startFakeLLM({ replies: [{ text: 'a' }, { text: 'b' }] });
  try {
    const backend = fakeBackend(() => ({ skill: { name: 'metrics-query', body: SKILL_BODY } }));
    const ctxA = baseCtx({
      model: { ...baseCtx().model, base_url: llm.url },
      user_message: { role: 'user', content: '/metrics-query 查询' },
      skills: skillsInput(),
    });
    await runTurn(ctxA, { registry: baseRegistry(), sections: DEFAULT_SECTIONS, backend }, () => {}, new AbortController().signal);

    const ctxB = baseCtx({
      session_id: 2,
      turn_id: 9,
      model: { ...baseCtx().model, base_url: llm.url },
      user_message: { role: 'user', content: '另一个会话' },
      skills: { available: skillsInput().available, active: [] },
    });
    await runTurn(ctxB, { registry: baseRegistry(), sections: DEFAULT_SECTIONS, backend }, () => {}, new AbortController().signal);
    assert.ok(!llm.requests[1].messages[0].content.includes(SKILL_BODY));
  } finally {
    await llm.close();
  }
});

test('只有 active 才开放 fetch_url；未知 run_sql 不注册', async () => {
  // 无技能：on-demand 不出现
  const r1 = baseRegistry();
  const ctx0 = baseCtx({ user_message: { role: 'user', content: 'hi' } });
  const rt0 = await prepareSkills(ctx0, r1, fakeBackend(() => null), () => {}, new AbortController().signal);
  assert.ok(!rt0.visibleTools.includes('fetch_url'));

  // 有 active：fetch_url 开放，run_sql 未注册不出现
  const r2 = baseRegistry();
  const ctx1 = baseCtx({
    user_message: { role: 'user', content: 'hi' },
    skills: skillsInput({
      active: [{ name: 'metrics-query', allowed_tools: ['fetch_url', 'run_sql'], body: SKILL_BODY }],
    }),
  });
  const rt1 = await prepareSkills(ctx1, r2, fakeBackend(() => null), () => {}, new AbortController().signal);
  assert.ok(rt1.visibleTools.includes('fetch_url'));
  assert.ok(!rt1.visibleTools.includes('run_sql'));
  const prompt = rt1.section.render(ctx1);
  assert.ok(prompt.includes('run_sql'), '缺失工具要在说明中标注');
});

test('全局开关 false 不能被技能反向打开', async () => {
  const r = baseRegistry();
  const ctx = baseCtx({
    tool_switches: { fetch_url: false, current_time: false },
    user_message: { role: 'user', content: 'hi' },
    skills: skillsInput({
      active: [{ name: 'metrics-query', allowed_tools: ['fetch_url'], body: SKILL_BODY }],
    }),
  });
  const rt = await prepareSkills(ctx, r, fakeBackend(() => null), () => {}, new AbortController().signal);
  assert.ok(!rt.visibleTools.includes('fetch_url'));
  assert.ok(!rt.visibleTools.includes('current_time'));
  assert.ok(rt.visibleTools.includes('save_note'), '默认工具仍按原开关行为');
});

test('资源工具：未激活拒绝、已激活分页读取、失败变 tool 错误', async () => {
  const r = baseRegistry();
  const activeNames = new Set(['metrics-query']);
  registerResourceTool(r, (n) => activeNames.has(n));
  const content = 'x'.repeat(30000);
  const backend = fakeBackend((_m, path, body) => {
    assert.match(path, /\/skills\/metrics-query\/resource$/);
    if (body.path === 'bad.txt') throw new Error('资源不存在');
    return { content };
  });
  const tool = r.get('read_skill_resource');

  await assert.rejects(
    tool.execute({ skill: 'other', path: 'a.txt' }, { backend, turnId: 1, signal: new AbortController().signal }),
    /未激活/,
  );

  const page1 = await tool.execute(
    { skill: 'metrics-query', path: 'a.txt' },
    { backend, turnId: 1, signal: new AbortController().signal },
  );
  assert.equal(page1.offset, 0);
  assert.equal(page1.total_chars, 30000);
  assert.equal(page1.content.length, 12000);
  assert.equal(page1.has_more, true);

  const page2 = await tool.execute(
    { skill: 'metrics-query', path: 'a.txt', offset: 12000, limit: 12000 },
    { backend, turnId: 1, signal: new AbortController().signal },
  );
  assert.equal(page2.offset, 12000);
  assert.equal(page2.has_more, true);

  await assert.rejects(
    tool.execute({ skill: 'metrics-query', path: 'bad.txt' }, { backend, turnId: 1, signal: new AbortController().signal }),
    /资源不存在/,
  );
  const failed = await runTool(r, new Set(['read_skill_resource']), {
    id: 'resource-error', type: 'function', function: { name: 'read_skill_resource',
      arguments: JSON.stringify({ skill: 'metrics-query', path: 'bad.txt' }) },
  }, { backend, turnId: 1, sessionId: 1, emit() {}, signal: new AbortController().signal });
  assert.equal(failed.ok, false);
  assert.match(failed.content, /错误：资源不存在/);
});

test('停止时 partial 正文仍保留', async () => {
  const llm = await startFakeLLM({ replies: [{ text: '很长的部分回答', hang: true }] });
  try {
    const ctx = baseCtx({
      model: { ...baseCtx().model, base_url: llm.url },
      user_message: { role: 'user', content: '/metrics-query 查询' },
      skills: skillsInput(),
    });
    const backend = fakeBackend(() => ({ skill: { name: 'metrics-query', body: SKILL_BODY } }));
    const ac = new AbortController();
    const { events, emit } = collector();
    await runTurn(ctx, { registry: baseRegistry(), sections: DEFAULT_SECTIONS, backend }, (event) => {
      emit(event);
      if (event.type === 'text_delta') ac.abort();
    }, ac.signal);
    const partial = events.find((e) => e.type === 'message' && e.message.role === 'assistant');
    assert.ok(partial, '半截 assistant 消息要落库');
    assert.ok(partial.message.content.length > 0);
    assert.equal(events.at(-1).status, 'stopped');
  } finally {
    await llm.close();
  }
});

test('资源结果包含大量转义字符时仍保留有效分页信息', async () => {
  const registry = baseRegistry();
  registerResourceTool(registry, (name) => name === 'demo');
  const backend = fakeBackend(() => ({ content: '\u0000"\\'.repeat(12000) }));
  const result = await runTool(registry, new Set(['read_skill_resource']), {
    id: 'escaped', type: 'function', function: { name: 'read_skill_resource',
      arguments: JSON.stringify({ skill: 'demo', path: 'references/example.md' }) },
  }, { backend, turnId: 1, sessionId: 1, emit() {}, signal: new AbortController().signal });
  assert.equal(result.ok, true);
  const page = JSON.parse(result.content);
  assert.ok(page.content.length > 0);
  assert.equal(page.has_more, true);
  assert.ok(result.content.length <= 20000);
});
