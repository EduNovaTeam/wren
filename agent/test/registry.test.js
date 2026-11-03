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
  // 按需工具也列在设置页：用户可以明确关闭它。
  assert.equal(r.list().find((t) => t.name === 'hidden')?.toggleable, true);
});

test('toolsFor opens on-demand tools only when requested, never when disabled', () => {
  const r = registry().register({ name: 'core', description: '', parameters: schema,
    exposure: 'core', execute: () => 'c' });
  assert.deepEqual(r.toolsFor({ boom: false }, ['hidden']), ['ok', 'slow', 'hidden', 'core']);
  assert.deepEqual(r.toolsFor({ hidden: false }, ['hidden']), ['ok', 'boom', 'slow', 'core']);
  assert.deepEqual(r.toolsFor({}), ['ok', 'boom', 'slow', 'core']);
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

test('runTool honors a per-tool result limit with an explicit note', async () => {
  const r = new ToolRegistry().register({
    name: 'big', description: '', parameters: schema, maxResultChars: 10,
    execute: () => 'x'.repeat(30),
  });
  const out = await runTool(r, new Set(['big']), call('big'), ctx());
  assert.equal(out.ok, true);
  assert.match(out.content, /^x{10}\n…（已截断，原长 30 字符）$/);
});

test('runTool refuses tools that are not visible this turn', async () => {
  const r = registry();
  const out = await runTool(r, new Set(['ok']), call('hidden'), ctx());
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.content, /secret/);
});

test('isPrivateAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:a00:1',
    '::ffff:c0a8:101', 'fd00::1', '2001:db8::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  // URL 会把 IPv4 映射地址规范化成十六进制形式，检查的是规范化后的 hostname。
  for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/']) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    assert.equal(isPrivateAddress(host), true, url);
  }
});
