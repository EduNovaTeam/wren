import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadCatalog } from '../src/skills/catalog.js';
import { SkillActivationError, SkillRuntime } from '../src/skills/runtime.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { tempDir, writeSkill } from './support/skills.js';

const schema = { type: 'object', properties: {} };

function registry() {
  return new ToolRegistry()
    .register({ name: 'current_time', description: '', parameters: schema, execute: () => 'now' })
    .register({ name: 'fetch_url', description: '', parameters: schema, exposure: 'on-demand',
      execute: () => 'page' })
    .register({ name: 'run_sql', description: '', parameters: schema, exposure: 'on-demand',
      execute: () => 'rows' })
    .register({ name: 'activate_skill', description: '', parameters: schema, exposure: 'core',
      execute: () => 'ok' });
}

function fakeBackend() {
  return {
    calls: [],
    async request(method, path, body) {
      this.calls.push({ method, path, body });
      return { ok: true };
    },
  };
}

async function setup(skills) {
  const dir = await tempDir();
  for (const [name, options] of Object.entries(skills)) {
    await writeSkill(dir, name, options);
  }
  const catalog = await loadCatalog({
    builtinDir: dir,
    userDir: undefined,
    toolNames: registry().toolNames(),
    bodyBudgetTokens: 4000,
  });
  return { dir, catalog };
}

test('tools are the union of active skills, and explicit disable wins', async () => {
  const { dir, catalog } = await setup({
    web: { fields: { description: '网页', 'allowed-tools': 'fetch_url' } },
    data: { fields: { description: '数据', 'allowed-tools': 'fetch_url run_sql' } },
  });
  const backend = fakeBackend();
  const runtime = new SkillRuntime({
    catalog,
    active: [{ name: 'web' }, { name: 'data' }],
    registry: registry(),
    backend,
    sessionId: 1,
    skillSwitches: {},
    toolSwitches: {},
  });
  assert.deepEqual(runtime.allowedToolNames(), ['current_time', 'fetch_url', 'run_sql', 'activate_skill']);

  // 关掉一个显式开关：即使 Skill 声明了，也不能开放。
  runtime.applyState({ active_skills: [{ name: 'web' }, { name: 'data' }], tool_switches: { fetch_url: false } });
  assert.deepEqual(runtime.allowedToolNames(), ['current_time', 'run_sql', 'activate_skill']);

  // 移除一个 Skill：只被它使用的工具收回，另一个 Skill 还在用的继续开放。
  runtime.applyState({ active_skills: [{ name: 'web' }], tool_switches: {} });
  assert.deepEqual(runtime.allowedToolNames(), ['current_time', 'fetch_url', 'activate_skill']);
});

test('activation is idempotent and persisted through the backend', async () => {
  const { catalog } = await setup({
    weekly: { fields: { description: '周报' }, body: '正文内容' },
  });
  const backend = fakeBackend();
  const events = [];
  const runtime = new SkillRuntime({
    catalog, active: [], registry: registry(), backend, sessionId: 7,
    emit: (event) => events.push(event),
  });

  const first = await runtime.activate('weekly');
  assert.equal(first.status, 'activated');
  const second = await runtime.activate('weekly');
  assert.equal(second.status, 'already');
  assert.equal(backend.calls.filter((c) => c.method === 'PUT').length, 1);
  assert.deepEqual(events.map((e) => e.type), ['skill_activated']);
  assert.deepEqual(runtime.activeNames(), ['weekly']);
  // 通过工具激活的正文已经在工具结果里，同一回合不再重复注入系统提示。
  assert.equal(runtime.promptState().bodies, null);
  const resumed = new SkillRuntime({
    catalog, active: [{ name: 'weekly' }], registry: registry(), backend, sessionId: 7,
  });
  assert.match(resumed.promptState().bodies, /正文内容/);
});

test('disabled, invalid and missing skills cannot be activated', async () => {
  const { catalog } = await setup({
    ok: { fields: { description: '可用' } },
    bad: { fields: { description: '缺工具', 'allowed-tools': 'missing_tool' } },
  });
  const backend = fakeBackend();
  const runtime = new SkillRuntime({
    catalog, active: [], registry: registry(), backend, sessionId: 1,
    skillSwitches: { ok: false },
  });
  await assert.rejects(runtime.activate('ok'), /已停用/);
  await assert.rejects(runtime.activate('bad'), /依赖的工具未注册/);
  await assert.rejects(runtime.activate('nope'), /不存在/);
  assert.equal(backend.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('restoring or refreshing active skills also obeys the total body budget', async () => {
  const { catalog } = await setup({
    big: { fields: { description: '大 Skill' }, body: 'x'.repeat(600) },
  });
  const events = [];
  const restored = new SkillRuntime({
    catalog,
    active: [{ name: 'big' }],
    registry: registry(),
    backend: fakeBackend(),
    sessionId: 1,
    totalBodyBudgetTokens: 100,
    emit: (event) => events.push(event),
  });
  assert.deepEqual(restored.activeNames(), []);
  assert.equal(restored.promptState().bodies, null);
  assert.ok(events.some((e) => e.type === 'skill_unavailable' && /总预算/.test(e.reason)));

  // 刷新时后端仍然返回这条激活记录，也不能绕过去。
  const refreshedEvents = [];
  const refreshed = new SkillRuntime({
    catalog,
    active: [],
    registry: registry(),
    backend: fakeBackend(),
    sessionId: 1,
    totalBodyBudgetTokens: 100,
    emit: (event) => refreshedEvents.push(event),
  });
  refreshed.applyState({ active_skills: [{ name: 'big' }] });
  assert.deepEqual(refreshed.activeNames(), []);
  assert.ok(refreshedEvents.some((e) => e.type === 'skill_unavailable' && /总预算/.test(e.reason)));
});

test('total body budget stops activating more skills', async () => {
  const { catalog } = await setup({
    a: { fields: { description: 'a' }, body: '字'.repeat(60) },
    b: { fields: { description: 'b' }, body: '字'.repeat(60) },
  });
  const runtime = new SkillRuntime({
    catalog, active: [], registry: registry(), backend: fakeBackend(), sessionId: 1,
    totalBodyBudgetTokens: 100,
  });
  await runtime.activate('a');
  await assert.rejects(runtime.activate('b'), /总预算/);
});

test('resources can only be read from active skills', async () => {
  const { catalog } = await setup({
    weekly: {
      fields: { description: '周报' },
      files: { 'references/template.md': '# 模板\n' },
    },
  });
  const runtime = new SkillRuntime({
    catalog, active: [{ name: 'weekly' }], registry: registry(), backend: fakeBackend(),
    sessionId: 1,
  });
  const file = await runtime.readResource('weekly', 'references/template.md');
  assert.equal(file.text, '# 模板\n');
  await assert.rejects(runtime.readResource('other', 'references/template.md'), /未激活/);
  await assert.rejects(runtime.readResource('weekly', '../SKILL.md'), /不能包含/);
  await assert.rejects(runtime.readResource('weekly', '/etc/passwd'), /绝对路径/);
});

test('unavailable active skills are reported and stop loading', async () => {
  const { catalog } = await setup({ weekly: { fields: { description: '周报' } } });
  const events = [];
  const runtime = new SkillRuntime({
    catalog,
    active: [{ name: 'gone' }],
    registry: registry(),
    backend: fakeBackend(),
    sessionId: 1,
    skillSwitches: { weekly: false },
    emit: (event) => events.push(event),
  });
  assert.deepEqual(runtime.activeNames(), []);
  assert.equal(events[0].type, 'skill_unavailable');
  assert.match(events[0].reason, /不存在/);
  assert.equal(runtime.promptState().bodies, null);
});
