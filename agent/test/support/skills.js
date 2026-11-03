/**
 * 测试用的 Skill 目录构造器。
 */

import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.frontmatter]  自定义 frontmatter 内容（不含首尾的 ---）
 * @param {Record<string, string>} [options.fields]  简单的 `键: 值` 字段
 * @param {string} [options.body]
 * @returns {string} SKILL.md 内容
 */
export function skillMarkdown(name, { frontmatter, fields, body = '# 正文\n' } = {}) {
  const lines = frontmatter
    ? frontmatter.split('\n')
    : [`name: ${name}`, ...Object.entries(fields ?? {}).map(([k, v]) => `${k}: ${v}`)];
  return ['---', ...lines, '---', '', body].join('\n');
}

/**
 * 在 base 下创建一个 Skill 目录，返回目录路径。
 * @param {string} base
 * @param {string} name
 * @param {{ frontmatter?: string, fields?: Record<string, string>, body?: string,
 *   files?: Record<string, string>, skipSkillMd?: boolean }} [options]
 */
export async function writeSkill(base, name, options = {}) {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  if (!options.skipSkillMd) {
    await writeFile(join(dir, 'SKILL.md'), skillMarkdown(name, options));
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

/** 建一个空的临时目录。 */
export function tempDir() {
  return mkdtemp(join(tmpdir(), 'wren-skills-'));
}

/** 创建一个指向 target 的符号链接（Windows 上可能需要权限，测试里自行跳过）。 */
export async function link(target, path) {
  await symlink(target, path);
}
