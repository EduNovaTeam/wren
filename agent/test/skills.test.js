import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SECTIONS, buildSystemPrompt } from '../src/context.js';
import { createToolRegistry } from '../src/tools/index.js';
import { useSkill } from '../src/tools/skills.js';
import { runTool } from '../src/tools/registry.js';

const SKILL = {
  name: 'weekly-report',
  description: '按团队模板撰写个人周报。',
  body: '# 写周报\n\n1. 先读 references/template.md',
  files: ['references/template.md'],
};

/** @param {Partial<{ skill: any, file: any, failure: Error }>} [options] */
function fakeBackend(options = {}) {
  return {
    calls: /** @type {any[]} */ ([]),
    /** @param {string} name */
    async getSkill(name) {
      this.calls.push(['skill', name]);
      if (options.failure) throw options.failure;
      return options.skill ?? SKILL;
    },
    /** @param {string} name @param {string} file */
    async getSkillFile(name, file) {
      this.calls.push(['file', name, file]);
      if (options.failure) throw options.failure;
      return options.file ?? { path: file, content: '【周报】模板正文' };
    },
  };
}

/** @param {any} backend */
const ctx = (backend) => ({
  sessionId: 1,
  turnId: 1,
  backend,
  emit() {},
  signal: new AbortController().signal,
});

test('use_skill returns the body and lists attached files', async () => {
  const backend = fakeBackend();
  const text = await useSkill.execute({ name: ' weekly-report ' }, ctx(backend));
  assert.match(text, /# 写周报/);
  assert.match(text, /按团队模板撰写个人周报/);
  assert.match(text, /references\/template\.md/);
  // name 两端空白要清掉，否则后端按名字查不到
  assert.deepEqual(backend.calls, [['skill', 'weekly-report']]);
});

test('use_skill reads an attached file when file is given', async () => {
  const backend = fakeBackend();
  const text = await useSkill.execute(
    { name: 'weekly-report', file: 'references/template.md' },
    ctx(backend),
  );
  assert.equal(text, '【周报】模板正文');
  assert.deepEqual(backend.calls, [['file', 'weekly-report', 'references/template.md']]);
});

test('use_skill rejects an empty name without calling the backend', async () => {
  const backend = fakeBackend();
  await assert.rejects(() => useSkill.execute({ name: '  ' }, ctx(backend)), /name 不能为空/);
  assert.deepEqual(backend.calls, []);
});

test('missing skill becomes an error result for the model, not a thrown turn', async () => {
  const backend = fakeBackend({ failure: new Error('后端 404：skill 不存在或有问题') });
  const visible = new Set(['use_skill']);
  const out = await runTool(
    createToolRegistry(),
    visible,
    { id: 'c1', type: 'function', function: { name: 'use_skill', arguments: '{"name":"nope"}' } },
    ctx(backend),
  );
  assert.equal(out.ok, false);
  assert.match(out.content, /404/);
});

test('use_skill is registered by default and visible in settings', () => {
  const registry = createToolRegistry();
  assert.ok(registry.get('use_skill'));
  assert.ok(registry.visibleTools({}).includes('use_skill'));
});

test('system prompt lists skills and skips the section when there is none', () => {
  const withSkills = buildSystemPrompt(DEFAULT_SECTIONS, {
    system_prompt: '',
    skills: [{ name: 'weekly-report', description: '写周报' }],
  });
  assert.match(withSkills, /weekly-report：写周报/);
  assert.match(withSkills, /use_skill/);

  const without = buildSystemPrompt(DEFAULT_SECTIONS, { system_prompt: '', skills: [] });
  assert.doesNotMatch(without, /可用的 skill/);
  // 没有 skill 时整段被跳过，不留空行
  assert.doesNotMatch(without, /\n\n\n/);
});
