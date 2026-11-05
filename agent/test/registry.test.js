import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPrivateAddress } from '../src/tools/builtin.js';
import { ToolRegistry, runTool } from '../src/tools/registry.js';

const schema = { type: 'object', properties: {} };
const call = (name, args = '{}') => ({ id: 'c', type: /** @type {const} */ ('function'),
  function: { name, arguments: args } });
const ctx = () => /** @type {any} */ ({ sessionId: 1, turnId: 1, backend: null, emit() {},
  signal: new AbortController().signal });

function registry() {
  return new ToolRegistry()
    .register({ name: 'ok', description: '', parameters: schema, execute: (a) => ({ got: a }) })
    .register({ name: 'boom', description: '', parameters: schema,
      execute: () => { throw new Error('坏了'); } })
    .register({ name: 'slow', description: '', parameters: schema, timeoutMs: 20,
      execute: () => new Promise(() => {}) })
    .register({ name: 'hidden', description: '', parameters: schema, exposure: 'on-demand',
      execute: () => 'secret' });
}

test('visibleTools respects switches and on-demand exposure', () => {
  const r = registry();
  assert.deepEqual(r.visibleTools({ boom: false }), ['ok', 'slow']);
  assert.deepEqual(r.list().find((t) => t.name === 'hidden')?.toggleable, false);
});

test('visibleTools opens on-demand tools only when a skill asks for them', () => {
  const r = registry();
  // 没有 skill 要，on-demand 的工具不出现
  assert.deepEqual(r.visibleTools({}), ['ok', 'boom', 'slow']);
  assert.deepEqual(r.visibleTools({}, ['hidden']), ['ok', 'boom', 'slow', 'hidden']);
  // 没注册的名字忽略，不能让回合失败
  assert.deepEqual(r.visibleTools({}, ['nope']), ['ok', 'boom', 'slow']);
  // 开关归用户管：skill 不能替用户打开被关掉的工具
  assert.deepEqual(r.visibleTools({ ok: false }, ['ok']), ['boom', 'slow']);
  // 重复声明只出现一次
  assert.deepEqual(r.visibleTools({}, ['hidden', 'hidden']), ['ok', 'boom', 'slow', 'hidden']);
});

test('register rejects duplicates and bad names', () => {
  const r = registry();
  assert.throws(() => r.register({ name: 'ok', description: '', parameters: schema, execute() {} }));
  assert.throws(() => r.register({ name: 'a b', description: '', parameters: schema, execute() {} }));
});

test('runTool turns failures into results for the model', async () => {
  const r = registry();
  const visible = new Set(['ok', 'boom', 'slow']);
  assert.deepEqual(await runTool(r, visible, call('ok', '{"x":1}'), ctx()),
    { ok: true, content: '{"got":{"x":1}}' });
  assert.match((await runTool(r, visible, call('boom'), ctx())).content, /坏了/);
  assert.match((await runTool(r, visible, call('slow'), ctx())).content, /超时/);
  assert.match((await runTool(r, visible, call('ok', '{bad'), ctx())).content, /JSON/);
  assert.match((await runTool(r, visible, call('ok', '[1]'), ctx())).content, /对象/);
});

test('runTool refuses tools that are not visible this turn', async () => {
  const r = registry();
  const out = await runTool(r, new Set(['ok']), call('hidden'), ctx());
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.content, /secret/);
});

test('isPrivateAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '::1',
    '::ffff:127.0.0.1', 'fd00::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});
