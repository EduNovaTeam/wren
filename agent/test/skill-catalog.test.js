import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadCatalog, renderSkillIndex } from '../src/skills/catalog.js';
import { SkillFileError, readSkillText } from '../src/skills/read.js';
import { link, tempDir, writeSkill } from './support/skills.js';

const tools = ['current_time', 'fetch_url'];

test('discovers builtin and user skills; user version overrides builtin', async () => {
  const base = await tempDir();
  const builtin = join(base, 'builtin');
  const user = join(base, 'user');
  await writeSkill(builtin, 'weekly-report', { fields: { description: '内置版' } });
  await writeSkill(builtin, 'translate', { fields: { description: '翻译' } });
  await writeSkill(user, 'weekly-report', { fields: { description: '用户版' } });

  const catalog = await loadCatalog({ builtinDir: builtin, userDir: user, toolNames: tools });
  const weekly = catalog.get('weekly-report');
  assert.equal(weekly.description, '用户版');
  assert.equal(weekly.source, 'user');
  assert.equal(catalog.get('translate').source, 'builtin');
  assert.equal(catalog.list().length, 2);
});

test('an invalid user version does not silently fall back to the builtin one', async () => {
  const base = await tempDir();
  const builtin = join(base, 'builtin');
  const user = join(base, 'user');
  await writeSkill(builtin, 'weekly-report', { fields: { description: '内置版' } });
  await writeSkill(user, 'weekly-report', { frontmatter: 'name: weekly-report\ndescription: 用户版\nauthor: me' });

  const catalog = await loadCatalog({ builtinDir: builtin, userDir: user, toolNames: tools });
  const weekly = catalog.get('weekly-report');
  assert.equal(weekly.source, 'user');
  assert.equal(weekly.valid, false);
  assert.match(weekly.error, /不支持的字段/);
});

test('one broken skill does not stop the others', async () => {
  const base = await tempDir();
  const builtin = join(base, 'builtin');
  await writeSkill(builtin, 'good', { fields: { description: '好的', 'allowed-tools': 'current_time' } });
  await writeSkill(builtin, 'broken', { frontmatter: 'name: other\ndescription: 名字不一致' });
  await writeSkill(builtin, 'empty', { skipSkillMd: true });
  await mkdir(join(builtin, 'plain-file'));
  await writeFile(join(builtin, 'plain-file', 'SKILL.md'), '没有 frontmatter');

  const catalog = await loadCatalog({ builtinDir: builtin, userDir: join(base, 'none'), toolNames: tools });
  assert.equal(catalog.get('good').valid, true);
  assert.match(catalog.get('broken').error, /不一致/);
  assert.match(catalog.get('empty').error, /缺少 SKILL.md/);
  assert.match(catalog.get('plain-file').error, /frontmatter/);
  assert.equal(catalog.available().length, 1);
});

test('missing tool dependencies make a skill unavailable but keep others usable', async () => {
  const base = await tempDir();
  const builtin = join(base, 'builtin');
  await writeSkill(builtin, 'metrics-query', {
    fields: { description: '查指标', 'allowed-tools': 'fetch_url run_sql' },
  });
  await writeSkill(builtin, 'web-research', {
    fields: { description: '查网页', 'allowed-tools': 'fetch_url' },
  });

  const catalog = await loadCatalog({ builtinDir: builtin, userDir: undefined, toolNames: tools });
  const metrics = catalog.get('metrics-query');
  assert.equal(metrics.valid, false);
  assert.deepEqual(metrics.missingTools, ['run_sql']);
  assert.match(metrics.error, /依赖的工具未注册：run_sql/);
  assert.equal(catalog.get('web-research').valid, true);
});

test('body over the per-skill budget is rejected instead of truncated', async () => {
  const base = await tempDir();
  const builtin = join(base, 'builtin');
  await writeSkill(builtin, 'long', { fields: { description: '很长' }, body: '字'.repeat(200) });

  const catalog = await loadCatalog({
    builtinDir: builtin,
    userDir: undefined,
    toolNames: tools,
    bodyBudgetTokens: 50,
  });
  assert.equal(catalog.get('long').valid, false);
  assert.match(catalog.get('long').error, /超过单 Skill 预算/);
});

test('skill index stays within its own budget and says what was omitted', () => {
  const skills = Array.from({ length: 5 }, (_, i) => ({
    name: `skill-${i}`,
    description: '描述'.repeat(20),
    source: 'builtin',
    dir: '',
    allowedTools: [],
    body: '',
    bodyTokens: 0,
    valid: true,
    error: null,
    missingTools: [],
  }));
  const text = renderSkillIndex(skills, 60);
  assert.match(text, /^可用的 Skill/);
  assert.match(text, /因目录预算未列出/);
  assert.ok(text.length < 200);
});

test('resource reads reject absolute paths, traversal and files outside the skill', async () => {
  const base = await tempDir();
  const dir = await writeSkill(base, 'weekly-report', {
    fields: { description: '周报' },
    files: { 'references/template.md': '# 模板\n' },
  });
  const outside = join(base, 'outside.md');
  await writeFile(outside, '不该被读到');
  await link(outside, join(dir, 'references', 'escape.md'));

  assert.equal((await readSkillText(dir, 'references/template.md')).text, '# 模板\n');
  for (const bad of ['/etc/passwd', '../outside.md', 'references/../../outside.md', 'a\\b']) {
    await assert.rejects(readSkillText(dir, bad), SkillFileError, bad);
  }
  await assert.rejects(readSkillText(dir, 'references/escape.md'), /超出 Skill 目录/);
  await assert.rejects(readSkillText(dir, 'references/missing.md'), /不存在/);
});

test('symlinked skill directories are rejected during discovery', async () => {
  const base = await tempDir();
  const real = await writeSkill(base, 'real', { fields: { description: '真目录' } });
  const builtin = join(base, 'builtin');
  await mkdir(builtin, { recursive: true });
  await link(real, join(builtin, 'linked'));

  const catalog = await loadCatalog({ builtinDir: builtin, userDir: undefined, toolNames: tools });
  const linked = catalog.get('linked');
  assert.equal(linked.valid, false);
  assert.match(linked.error, /符号链接/);
});

test('binary and oversized resources are reported clearly', async () => {
  const base = await tempDir();
  const dir = await writeSkill(base, 'x', {
    fields: { description: 'x' },
    files: { 'assets/binary.md': 'a\u0000b', 'assets/large.md': 'x'.repeat(100) },
  });
  await assert.rejects(readSkillText(dir, 'assets/binary.md'), /不是文本文件/);
  await assert.rejects(readSkillText(dir, 'assets/large.md', { maxBytes: 50 }), /文件过大/);
});

test('resource text is truncated with an explicit count', async () => {
  const base = await tempDir();
  const dir = await writeSkill(base, 'x', {
    fields: { description: 'x' },
    files: { 'references/long.md': 'a'.repeat(100) },
  });
  const result = await readSkillText(dir, 'references/long.md', { maxChars: 30 });
  assert.equal(result.truncated, true);
  assert.equal(result.totalChars, 100);
  assert.equal(result.text.length, 30);
});
