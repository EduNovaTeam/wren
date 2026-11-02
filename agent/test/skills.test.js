import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SECTIONS, buildSystemPrompt, skillsSection } from '../src/context.js';
import { runTool } from '../src/tools/registry.js';
import { createToolRegistry } from '../src/tools/index.js';
import { useSkill } from '../src/tools/skills.js';

const SKILL = {
  name: 'weekly-report',
  description: '按团队模板撰写个人周报。',
  body: '# 写周报\n\n1. 先读 references/template.md',
  files: ['references/template.md'],
};

const LIST = [{ name: 'weekly-report', description: '按团队模板撰写个人周报。' }];

/** @param {Partial<{ skill: any, file: any, skills: any[], failure: Error }>} [options] */
function fakeBackend(options = {}) {
  return {
    calls: /** @type {any[]} */ ([]),
    async listSkills() {
      this.calls.push(['list']);
      if (options.failure) throw options.failure;
      return { skills: options.skills ?? LIST };
    },
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

test('use_skill without a name returns the catalog instead of a body', async () => {
  const backend = fakeBackend();
  const text = await useSkill.execute({}, ctx(backend));
  assert.match(text, /可用的 skill（1 个）/);
  assert.match(text, /weekly-report：按团队模板撰写个人周报。/);
  assert.match(text, /use_skill\(name\)/);
  assert.deepEqual(backend.calls, [['list']]);
});

test('use_skill renders an empty catalog without inventing entries', async () => {
  const backend = fakeBackend({ skills: [] });
  assert.equal(await useSkill.execute({}, ctx(backend)), '当前没有可用的 skill。');
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

test('use_skill refuses a file without a skill name', async () => {
  const backend = fakeBackend();
  await assert.rejects(
    () => useSkill.execute({ file: 'references/template.md' }, ctx(backend)),
    /需要同时提供 name/,
  );
  assert.deepEqual(backend.calls, []);
});

test('missing skill becomes an error result for the model, not a thrown turn', async () => {
  const backend = fakeBackend({ failure: new Error('后端 404：skill 不存在或有问题') });
  const out = await runTool(
    createToolRegistry(),
    new Set(['use_skill']),
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

test('system prompt only says skills exist, never lists them', () => {
  const prompt = buildSystemPrompt(DEFAULT_SECTIONS, {
    system_prompt: '',
    skills: LIST,
  });
  assert.match(prompt, /use_skill/);
  // 关键：清单里任何一条都不能出现在系统提示里，否则每回合都在为它付 token
  assert.doesNotMatch(prompt, /weekly-report/);
  assert.doesNotMatch(prompt, /按团队模板撰写个人周报/);
  // 提示长度不随 skill 数量变化
  assert.ok(/** @type {string} */ (skillsSection.render({ skills: LIST })).length < 160);
});

test('system prompt drops the skill section when nothing is installed', () => {
  const without = buildSystemPrompt(DEFAULT_SECTIONS, { system_prompt: '', skills: [] });
  assert.doesNotMatch(without, /可用的 skill/);
  assert.doesNotMatch(without, /\n\n\n/);
});
