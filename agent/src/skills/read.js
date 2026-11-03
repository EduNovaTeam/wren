/**
 * Skill 目录内的安全读取。
 *
 * 所有 Skill 正文和附属资源都必须经过这里：只接受 Skill 目录内的相对路径，
 * 用真实路径检查阻止 `..` 与符号链接越界，并限制文件大小和返回长度。
 * 错误信息只描述问题本身，不返回目录外的任何内容。
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

/** 单个 Skill 文件最多读取的字节数（防止误放超大文件）。 */
export const FILE_MAX_BYTES = 256 * 1024;
/** 一次返回给模型的最大字符数。 */
export const TEXT_MAX_CHARS = 12_000;

export class SkillFileError extends Error {}

/**
 * 校验并拆分相对路径。拒绝绝对路径、反斜杠、`.`、`..`、空段和 NUL。
 * @param {unknown} input
 * @returns {string[]}
 */
export function safeRelativeParts(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new SkillFileError('path 不能为空');
  }
  if (input.includes('\0')) throw new SkillFileError('path 含非法字符');
  if (input.includes('\\')) throw new SkillFileError('path 只能使用 / 分隔目录');
  if (isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    throw new SkillFileError('不允许绝对路径');
  }
  const parts = input.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new SkillFileError('path 不能包含 .、.. 或多余的 /');
  }
  return parts;
}

/**
 * 读取 Skill 目录内的一个文本文件。
 * @param {string} rootDir  Skill 目录
 * @param {string} relativePath  相对路径，使用 /
 * @param {object} [options]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxChars]
 * @returns {Promise<{ text: string, truncated: boolean, totalChars: number, size: number }>}
 */
export async function readSkillText(rootDir, relativePath, options = {}) {
  const { maxBytes = FILE_MAX_BYTES, maxChars = TEXT_MAX_CHARS } = options;
  const parts = safeRelativeParts(relativePath);

  let root;
  try {
    root = await realpath(rootDir);
  } catch {
    throw new SkillFileError('Skill 目录不存在');
  }
  const target = join(root, ...parts);
  let real;
  try {
    real = await realpath(target);
  } catch {
    throw new SkillFileError('文件不存在');
  }
  // 符号链接可能把真实路径带到 Skill 目录之外，必须用真实路径判断。
  if (real !== root && !real.startsWith(root + sep)) {
    throw new SkillFileError('文件超出 Skill 目录');
  }

  let info;
  try {
    info = await stat(real);
  } catch {
    throw new SkillFileError('无法读取文件');
  }
  if (!info.isFile()) throw new SkillFileError('不是普通文件');
  if (info.size > maxBytes) {
    throw new SkillFileError(`文件过大（${info.size} 字节，上限 ${maxBytes} 字节）`);
  }

  let buffer;
  try {
    buffer = await readFile(real);
  } catch {
    throw new SkillFileError('无法读取文件');
  }
  if (buffer.includes(0)) throw new SkillFileError('不是文本文件（含二进制内容）');

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new SkillFileError('不是 UTF-8 文本文件');
  }

  const chars = Array.from(text);
  const truncated = chars.length > maxChars;
  if (truncated) text = chars.slice(0, maxChars).join('');
  return { text, truncated, totalChars: chars.length, size: info.size };
}
