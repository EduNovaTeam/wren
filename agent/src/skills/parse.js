/**
 * SKILL.md 的 frontmatter 解析。
 *
 * Skill 是外部内容，解析规则必须可预期：只支持下面这个 YAML 子集，遇到其他写法直接报错，
 * 不做「尽力猜」的兼容。支持的写法：
 *
 *   ---
 *   name: weekly-report
 *   description: 用户需要写周报时使用。
 *   allowed-tools: current_time fetch_url
 *   license: MIT
 *   compatibility: 需要支持工具调用
 *   metadata:
 *     owner: product
 *     version: "1.0"
 *   ---
 *
 * - 每个字段一行 `键: 值`；值可以用单引号或双引号包裹，也可以不包裹。
 * - `allowed-tools` 还可以写成缩进 2 个空格的列表（`  - 工具名`）。
 * - `metadata` 只能是一层缩进 2 个空格的 `键: 值`。
 * - 不支持：多行值（`|`、`>`）、流式集合（`[...]`、`{...}`）、锚点 / 标签、注释、制表符。
 * - 不允许未知字段，避免拼错字段后被静默忽略。
 */

/** 解析失败时抛出，消息直接展示给用户。 */
export class SkillFormatError extends Error {}

const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'allowed-tools',
  'license',
  'compatibility',
  'metadata',
]);

const KEY_RE = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/;
const INDENTED_KEY_RE = /^ {2}([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/;
const LIST_ITEM_RE = /^ {2}-[ \t]+(.+)$/;

/**
 * @param {string} text  SKILL.md 全文
 * @returns {{ data: Record<string, any>, body: string }}
 */
export function parseSkillFile(text) {
  const normalized = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new SkillFormatError('缺少 frontmatter：文件必须从 --- 开始');
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new SkillFormatError('frontmatter 没有闭合：缺少第二行 ---');

  const header = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n').trim();
  /** @type {Record<string, any>} */
  const data = {};
  let i = 0;
  while (i < header.length) {
    const raw = header[i];
    if (!raw.trim()) {
      i += 1;
      continue;
    }
    if (raw.includes('\t')) throw new SkillFormatError(lineError(i, '不支持制表符缩进'));
    if (/^\s/.test(raw)) throw new SkillFormatError(lineError(i, '顶层字段不能缩进'));

    const match = KEY_RE.exec(raw);
    if (!match) throw new SkillFormatError(lineError(i, '不是「键: 值」格式'));
    const key = match[1];
    const rest = (match[2] ?? '').trim();
    if (Object.hasOwn(data, key)) throw new SkillFormatError(lineError(i, `字段重复：${key}`));
    if (!ALLOWED_KEYS.has(key)) {
      throw new SkillFormatError(
        lineError(i, `不支持的字段：${key}（支持 ${[...ALLOWED_KEYS].join('、')}）`),
      );
    }

    if (key === 'metadata') {
      if (rest) throw new SkillFormatError(lineError(i, 'metadata 必须是缩进的键值列表'));
      const metadata = {};
      i += 1;
      i = parseMetadata(header, i, metadata);
      data.metadata = metadata;
      continue;
    }

    if (key === 'allowed-tools') {
      if (!rest) {
        const tools = [];
        i += 1;
        while (i < header.length) {
          const line = header[i];
          if (!line.trim()) {
            i += 1;
            continue;
          }
          if (!/^\s/.test(line)) break;
          if (line.includes('\t')) throw new SkillFormatError(lineError(i, '不支持制表符缩进'));
          const item = LIST_ITEM_RE.exec(line);
          if (!item) throw new SkillFormatError(lineError(i, '列表项应写成「- 工具名」'));
          tools.push(...splitTools(item[1]));
          i += 1;
        }
        data['allowed-tools'] = dedupe(tools);
        continue;
      }
      data['allowed-tools'] = dedupe(splitTools(rest));
      i += 1;
      continue;
    }

    data[key] = parseScalar(rest, i, key);
    i += 1;
  }

  return { data, body };
}

/**
 * @param {string[]} header
 * @param {number} start
 * @param {Record<string, string>} out
 * @returns {number} 下一个待处理的行号
 */
function parseMetadata(header, start, out) {
  let i = start;
  while (i < header.length) {
    const raw = header[i];
    if (!raw.trim()) {
      i += 1;
      continue;
    }
    if (!/^\s/.test(raw)) break;
    if (raw.includes('\t')) throw new SkillFormatError(lineError(i, '不支持制表符缩进'));
    const match = INDENTED_KEY_RE.exec(raw);
    if (!match) {
      throw new SkillFormatError(lineError(i, 'metadata 只能是一层、缩进 2 个空格的键值'));
    }
    if (Object.hasOwn(out, match[1])) {
      throw new SkillFormatError(lineError(i, `metadata 字段重复：${match[1]}`));
    }
    out[match[1]] = parseScalar((match[2] ?? '').trim(), i, `metadata.${match[1]}`);
    i += 1;
  }
  return i;
}

/**
 * @param {string} value
 * @param {number} line
 * @param {string} key
 */
function parseScalar(value, line, key) {
  if (!value) return '';
  if (/^[|>]/.test(value)) {
    throw new SkillFormatError(lineError(line, `${key} 不支持多行值（| / >），请写成一行`));
  }
  if (/^[[{]/.test(value)) {
    throw new SkillFormatError(lineError(line, `${key} 不支持流式集合（[...] / {...}）`));
  }
  if (/^[&*!]/.test(value)) {
    throw new SkillFormatError(lineError(line, `${key} 不支持锚点、别名或标签写法`));
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    if (value.length < 2 || !value.endsWith(quote)) {
      throw new SkillFormatError(lineError(line, `${key} 的引号没有闭合`));
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('#') || /\s#/.test(value)) {
    throw new SkillFormatError(lineError(line, `${key} 不支持行内注释`));
  }
  return value;
}

/** @param {string} value */
function splitTools(value) {
  let text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1);
  }
  return text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** @param {string[]} items */
function dedupe(items) {
  return [...new Set(items)];
}

/** @param {number} index @param {string} message */
function lineError(index, message) {
  return `frontmatter 第 ${index + 2} 行：${message}`;
}
