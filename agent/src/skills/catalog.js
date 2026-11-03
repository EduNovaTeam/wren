/**
 * 扫描并校验 Skill。
 *
 * 来源有两个：仓库内置目录（skills/）和用户本地目录（默认 data/skills，可用
 * WREN_SKILLS_DIR 配置）。同名时用户版本覆盖内置版本；用户版本无效时显示错误，
 * 不回退到内置版本。一次扫描的结果是一个不可变快照，一个回合内共用同一份快照，
 * 避免正文和工具权限来自不同版本。
 *
 * 扫描只解析元数据和正文，不把正文或附件注入模型；注入发生在激活之后。
 */

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { estimateTokens } from '../context.js';
import { SkillFormatError, parseSkillFile } from './parse.js';
import { SkillFileError, readSkillText } from './read.js';

export const SKILL_FILE = 'SKILL.md';
export const SKILL_FILE_MAX_BYTES = 128 * 1024;
export const DESCRIPTION_MAX = 1024;
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * @typedef {object} Skill
 * @property {string} name  目录名，也是唯一标识
 * @property {string} description
 * @property {'builtin'|'user'} source
 * @property {string} dir  绝对路径；只在 agent 内部使用，不发给模型
 * @property {string[]} allowedTools
 * @property {string} body
 * @property {number} bodyTokens
 * @property {string} [license]
 * @property {string} [compatibility]
 * @property {Record<string, string>} [metadata]
 * @property {boolean} valid
 * @property {string|null} error
 * @property {string[]} missingTools
 */

export class SkillCatalog {
  /**
   * @param {object} options
   * @param {Skill[]} options.skills
   * @param {string[]} [options.errors]  目录级错误（例如目录无法读取）
   * @param {number} [options.indexBudgetTokens]
   */
  constructor({ skills, errors = [], indexBudgetTokens = 1500 }) {
    /** @type {Skill[]} */
    this.skills = skills;
    this.errors = errors;
    this.indexBudgetTokens = indexBudgetTokens;
    /** @type {Map<string, Skill>} */
    this.byName = new Map(skills.map((s) => [s.name, s]));
  }

  /** @param {string} name */
  get(name) {
    return this.byName.get(name);
  }

  /** 给设置页 / 接口用的精简列表，不含正文。 */
  list() {
    return this.skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      valid: s.valid,
      error: s.error,
      allowed_tools: s.allowedTools,
      missing_tools: s.missingTools,
      body_tokens: s.bodyTokens,
      license: s.license ?? null,
      compatibility: s.compatibility ?? null,
    }));
  }

  /**
   * 已启用且有效的 Skill。目录只列这些。
   * @param {Record<string, boolean>} [switches]
   */
  available(switches = {}) {
    return this.skills.filter((s) => s.valid && switches[s.name] !== false);
  }

  /**
   * 系统提示里的 Skill 目录：只有名称和简介。
   * @param {Record<string, boolean>} [switches]
   * @returns {string|null}
   */
  renderIndex(switches = {}) {
    return renderSkillIndex(this.available(switches), this.indexBudgetTokens);
  }
}

/**
 * @param {object} options
 * @param {string} [options.builtinDir]  仓库内置 Skill 目录
 * @param {string} [options.userDir]  用户 Skill 目录
 * @param {Iterable<string>} [options.toolNames]  已注册的工具名
 * @param {number} [options.bodyBudgetTokens]  单个 Skill 正文预算
 * @param {number} [options.indexBudgetTokens]  目录预算
 * @returns {Promise<SkillCatalog>}
 */
export async function loadCatalog({
  builtinDir,
  userDir,
  toolNames = [],
  bodyBudgetTokens = 24_000,
  indexBudgetTokens = 1500,
} = {}) {
  const errors = [];
  const tools = new Set(toolNames);
  const [builtin, user] = await Promise.all([
    scanDir(builtinDir, 'builtin', { tools, bodyBudgetTokens, errors }),
    scanDir(userDir, 'user', { tools, bodyBudgetTokens, errors }),
  ]);

  // 用户版本覆盖内置版本，即使它无效：不能让用户以为自己在改的版本生效了。
  /** @type {Map<string, Skill>} */
  const byName = new Map();
  for (const skill of builtin) byName.set(skill.name, skill);
  for (const skill of user) byName.set(skill.name, skill);

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return new SkillCatalog({ skills, errors, indexBudgetTokens });
}

/**
 * @param {string|undefined} dir
 * @param {'builtin'|'user'} source
 * @param {{ tools: Set<string>, bodyBudgetTokens: number, errors: string[] }} context
 * @returns {Promise<Skill[]>}
 */
async function scanDir(dir, source, context) {
  if (!dir) return [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return [];
    context.errors.push(
      `${source === 'builtin' ? '内置' : '用户'} Skill 目录无法读取：${errorMessage(err)}`,
    );
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let info;
    try {
      info = await lstat(full);
    } catch (err) {
      skills.push(brokenSkill(name, source, full, `无法读取目录项：${errorMessage(err)}`));
      continue;
    }
    if (info.isSymbolicLink()) {
      skills.push(brokenSkill(name, source, full, 'Skill 目录不能是符号链接'));
      continue;
    }
    if (!info.isDirectory()) continue;
    skills.push(await loadSkill(full, name, source, context));
  }
  return skills;
}

/**
 * @param {string} dir
 * @param {string} dirName
 * @param {'builtin'|'user'} source
 * @param {{ tools: Set<string>, bodyBudgetTokens: number }} context
 * @returns {Promise<Skill>}
 */
async function loadSkill(dir, dirName, source, context) {
  let text;
  try {
    const result = await readSkillText(dir, SKILL_FILE, {
      maxBytes: SKILL_FILE_MAX_BYTES,
      maxChars: SKILL_FILE_MAX_BYTES,
    });
    text = result.text;
  } catch (err) {
    const reason =
      err instanceof SkillFileError && err.message === '文件不存在'
        ? `缺少 ${SKILL_FILE}`
        : errorMessage(err);
    return brokenSkill(dirName, source, dir, reason);
  }

  let parsed;
  try {
    parsed = parseSkillFile(text);
  } catch (err) {
    const reason = err instanceof SkillFormatError ? err.message : `无法解析：${errorMessage(err)}`;
    return brokenSkill(dirName, source, dir, reason);
  }

  const { data, body } = parsed;
  const allowedTools = Array.isArray(data['allowed-tools']) ? data['allowed-tools'] : [];
  const bodyTokens = estimateTokens(body);
  const missingTools = allowedTools.filter((name) => !context.tools.has(name));
  /** @type {Skill} */
  const skill = {
    name: dirName,
    description: typeof data.description === 'string' ? data.description : '',
    source,
    dir,
    allowedTools,
    body,
    bodyTokens,
    license: typeof data.license === 'string' ? data.license : undefined,
    compatibility: typeof data.compatibility === 'string' ? data.compatibility : undefined,
    metadata: data.metadata,
    valid: false,
    error: null,
    missingTools,
  };
  skill.error = validate(skill, data, context.bodyBudgetTokens);
  skill.valid = skill.error === null;
  return skill;
}

/**
 * @param {Skill} skill
 * @param {Record<string, any>} data
 * @param {number} bodyBudgetTokens
 * @returns {string|null}
 */
function validate(skill, data, bodyBudgetTokens) {
  const name = data.name;
  if (typeof name !== 'string' || !name.trim()) return '缺少 name';
  if (!NAME_RE.test(name) || name.length > 64) {
    return 'name 格式不对：只能是小写字母、数字和短横线，最多 64 字符';
  }
  if (name !== skill.name) return `name（${name}）与目录名（${skill.name}）不一致`;
  if (!skill.description.trim()) return '缺少 description';
  if (skill.description.length > DESCRIPTION_MAX) {
    return `description 不能超过 ${DESCRIPTION_MAX} 字`;
  }
  for (const tool of skill.allowedTools) {
    if (typeof tool !== 'string' || !TOOL_NAME_RE.test(tool)) {
      return `allowed-tools 含不合法的工具名：${String(tool)}`;
    }
  }
  if (!skill.body) return '正文为空';
  if (skill.bodyTokens > bodyBudgetTokens) {
    return `正文约 ${skill.bodyTokens} tokens，超过单 Skill 预算 ${bodyBudgetTokens}`;
  }
  if (skill.missingTools.length) {
    return `依赖的工具未注册：${skill.missingTools.join('、')}`;
  }
  return null;
}

/**
 * @param {string} name
 * @param {'builtin'|'user'} source
 * @param {string} dir
 * @param {string} reason
 * @returns {Skill}
 */
function brokenSkill(name, source, dir, reason) {
  return {
    name,
    description: '',
    source,
    dir,
    allowedTools: [],
    body: '',
    bodyTokens: 0,
    valid: false,
    error: reason,
    missingTools: [],
  };
}

/**
 * 渲染系统提示里的 Skill 目录，只含名称和简介。
 * 超出目录预算时截断简介并明确说明，不静默丢内容。
 * @param {Skill[]} skills
 * @param {number} budgetTokens
 * @returns {string|null}
 */
export function renderSkillIndex(skills, budgetTokens) {
  if (!skills.length) return null;
  const header = '可用的 Skill（先用 activate_skill 启用，才能看到正文并使用它声明的工具）：';
  const lines = [];
  let used = estimateTokens(header);
  let omitted = 0;
  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const prefix = `- ${skill.name}：`;
    const line = prefix + skill.description;
    const cost = estimateTokens(line) + 1;
    if (used + cost <= budgetTokens) {
      lines.push(line);
      used += cost;
      continue;
    }
    const room = budgetTokens - used - estimateTokens(prefix) - 8;
    if (room >= 16) {
      lines.push(`${prefix}${skill.description.slice(0, room)}…`);
      omitted = skills.length - i - 1;
    } else {
      omitted = skills.length - i;
    }
    break;
  }
  if (omitted > 0) lines.push(`（还有 ${omitted} 个 Skill 因目录预算未列出）`);
  return [header, ...lines].join('\n');
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
