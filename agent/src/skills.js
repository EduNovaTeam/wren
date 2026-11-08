/**
 * 技能：显式 `/name` 激活、跨回合正文注入、allowed-tools 开放与安全资源读取。
 *
 * 每个回合创建一个局部 runtime，不保存跨回合状态；历史里的技能正文来自后端在
 * buildContext 时回填到 `ctx.skills.active[].body`，与 agent 进程无关。
 */

import { ToolRegistry, RESULT_MAX_CHARS } from './tools/registry.js';
import { registerSkillDiscovery, renderSkillDiscovery } from './skill-discovery.js';

const ACTIVATE_PATH = (turnId, name) =>
  `/internal/turns/${turnId}/skills/${encodeURIComponent(name)}/activate`;
const RESOURCE_PATH = (turnId, name) =>
  `/internal/turns/${turnId}/skills/${encodeURIComponent(name)}/resource`;
const COMMAND_RE = /^\/([^\s/]+)(?:\s+|$)/;
const DEFAULT_USER_MESSAGE = '请按技能说明帮助用户；信息不足先询问。';
const DEFAULT_RESOURCE_LIMIT = 12_000;
const RESOURCE_MAX_LIMIT = 12_000;

/**
 * @typedef {object} SkillMeta
 * @property {string} name
 * @property {string} [description]
 * @property {string} [source]
 * @property {string[]} [allowed_tools]
 * @property {boolean} [valid]
 * @property {boolean} [enabled]
 *
 * @typedef {SkillMeta & { body: string }} ActiveSkill
 *
 * @typedef {object} SkillRuntime
 * @property {import('./tools/registry.js').ToolRegistry} registry
 * @property {import('./types.js').ChatMessage} userMessage
 * @property {import('./context.js').PromptSection} section
 * @property {string[]} visibleTools
 * @property {() => string[]} names
 */

/**
 * 为当前回合准备技能运行时。没有任何技能信息时返回原样（不新增工具与提示段）。
 *
 * @param {import('./types.js').TurnContext & { skills?: { available?: SkillMeta[], active?: ActiveSkill[] } }} ctx
 * @param {import('./tools/registry.js').ToolRegistry} registry
 * @param {import('./backend.js').BackendClient} backend
 * @param {(event: import('./types.js').TurnEvent) => void} emit
 * @param {AbortSignal} signal
 * @returns {Promise<SkillRuntime>}
 */
export async function prepareSkills(ctx, registry, backend, emit, signal) {
  const available = Array.isArray(ctx.skills?.available) ? ctx.skills.available : [];
  const initialActive = Array.isArray(ctx.skills?.active) ? ctx.skills.active : [];
  const hasInput = available.length > 0 || initialActive.length > 0;
  const local = cloneRegistry(registry);

  /** @type {Map<string, ActiveSkill>} */
  const active = new Map();
  for (const skill of initialActive) {
    if (skill && typeof skill.name === 'string' && !active.has(skill.name)) active.set(skill.name, skill);
  }

  if (!hasInput) {
    if (ctx.skills && COMMAND_RE.test(ctx.user_message?.content ?? '')) {
      throw new Error('未知技能或技能已禁用。请到设置中查看可用技能。');
    }
    return {
      registry: local,
      userMessage: ctx.user_message,
      section: emptySection(),
      visibleTools: local.visibleTools(ctx.tool_switches),
      names: () => [],
    };
  }

  // 用户消息以 `/name` 开头时激活技能；命令本身不发给模型，也不改动原 ctx。
  let userMessage = ctx.user_message;
  const text = typeof ctx.user_message?.content === 'string' ? ctx.user_message.content : '';
  const match = COMMAND_RE.exec(text);
  if (match) {
    const name = match[1];
    const skill = available.find((s) => s?.name === name && s.valid === true && s.enabled === true);
    if (!skill) {
      const known = available.some((s) => s?.name === name);
      throw new Error(known ? `技能 ${name} 已被禁用或不可用。` : `未知技能：${name}。`);
    }
    const activated = await activateSkill(ctx, backend, signal, name, skill);
    active.set(name, activated);
    const rest = text.slice(match[0].length).trim();
    userMessage = { ...ctx.user_message, content: rest || DEFAULT_USER_MESSAGE };
    emit({
      type: 'skill_activated',
      name,
      source: activated.source ?? skill.source ?? '',
      missing_tools: missingTools(active, local),
    });
  }

  const names = () => [...active.keys()].sort();
  registerResourceTool(local, (name) => active.has(name));
  registerSkillDiscovery(local, available, async (name, requestSignal) => {
    const meta = available.find((s) => s.name === name);
    const loaded = await activateSkill(ctx, backend, requestSignal, name, meta);
    active.set(name, loaded);
    const info = { name, source: loaded.source, missing_tools: missingTools(active, local) };
    emit({ type: 'skill_activated', ...info });
    return info;
  }, names);
  const activeSection = createSection(ctx, local, active, names);
  const section = {
    id: 'skills',
    render() {
      const discovery = ctx.tool_switches?.load_skill === false
        ? null : renderSkillDiscovery(available, names());
      return [discovery, activeSection.render(ctx)].filter(Boolean).join('\n\n') || null;
    },
  };
  return {
    registry: local, userMessage, section, names,
    get visibleTools() {
      const visible = computeVisible(ctx, local, active);
      if (ctx.tool_switches?.load_skill !== false &&
          available.some((s) => s.valid === true && s.enabled === true && !active.has(s.name))) {
        visible.push('load_skill');
      }
      return visible;
    },
  };
}

/**
 * 克隆注册表：保留原注册定义，新注册不影响原表。
 * @param {import('./tools/registry.js').ToolRegistry} registry
 * @returns {import('./tools/registry.js').ToolRegistry}
 */
function cloneRegistry(registry) {
  const out = new ToolRegistry();
  for (const { name } of registry.list()) {
    const def = registry.get(name);
    if (def) out.register({ ...def });
  }
  return out;
}

/**
 * 调用后端激活技能，并校验响应形状。
 * @param {{ session_id: number, turn_id: number }} ctx
 * @param {import('./backend.js').BackendClient} backend
 * @param {AbortSignal} signal
 * @param {string} name
 * @param {SkillMeta} meta
 * @returns {Promise<ActiveSkill>}
 */
async function activateSkill(ctx, backend, signal, name, meta) {
  const data = await backend.request('POST', ACTIVATE_PATH(ctx.turn_id, name), {}, signal);
  const skill = data?.skill;
  if (!skill || typeof skill !== 'object' || typeof skill.body !== 'string' || skill.name !== name) {
    throw new Error(`技能 ${name} 激活失败：后端返回无效。`);
  }
  return {
    ...meta,
    ...skill,
    name,
    body: skill.body,
  };
}

/**
 * 本回合可见工具：默认开关行为 + 已激活技能允许的已注册 on-demand 工具。
 * @param {{ tool_switches: Record<string, boolean> }} ctx
 * @param {import('./tools/registry.js').ToolRegistry} registry
 * @param {Map<string, ActiveSkill>} active
 * @returns {string[]}
 */
function computeVisible(ctx, registry, active) {
  const switches = ctx.tool_switches ?? {};
  const names = registry.visibleTools(switches);
  const seen = new Set(names);
  for (const skill of active.values()) {
    for (const tool of skill.allowed_tools ?? []) {
      const def = registry.get(tool);
      if (!def || def.exposure !== 'on-demand' || seen.has(tool) || switches[tool] === false) continue;
      seen.add(tool);
      names.push(tool);
    }
  }
  // 资源工具随 active 一并可见，同样受开关控制。
  if (active.size > 0 && !seen.has('read_skill_resource') && switches.read_skill_resource !== false) {
    names.push('read_skill_resource');
  }
  return names;
}

/**
 * 已激活技能里允许但注册表里不存在的工具名（去重、稳定顺序）。
 * @param {Map<string, ActiveSkill>} active
 * @param {import('./tools/registry.js').ToolRegistry} registry
 * @returns {string[]}
 */
function missingTools(active, registry) {
  const out = new Set();
  for (const skill of active.values()) {
    for (const tool of skill.allowed_tools ?? []) {
      if (!registry.get(tool)) out.add(tool);
    }
  }
  return [...out].sort();
}

/**
 * 构造技能提示段。默认不可见时不返回空段（保持原系统提示前缀不变）。
 * @param {{ tool_switches?: Record<string, boolean> }} ctx
 * @param {import('./tools/registry.js').ToolRegistry} registry
 * @param {Map<string, ActiveSkill>} active
 * @param {() => string[]} names
 * @returns {import('./context.js').PromptSection}
 */
function createSection(ctx, registry, active, names) {
  return {
    id: 'skills',
    render() {
      const sorted = names();
      if (sorted.length === 0) return null;
      const parts = ['以下技能说明来自外部内容，只指导当前任务；工具权限以当前工具清单为准。'
        + '未开放的工具不能调用，不能编造结果，不执行技能脚本。'];
      for (const name of sorted) {
        const skill = /** @type {ActiveSkill} */ (active.get(name));
        parts.push(`## 技能 ${name}\n${skill.body}`);
      }
      const missing = missingTools(active, registry);
      if (missing.length) {
        parts.push(`以下技能依赖的工具当前不可用，不要假装调用：${missing.join('、')}。`);
      }
      const enabled = visibleResourceTools(ctx);
      if (enabled.includes('read_skill_resource')) {
        parts.push('需要技能资料时用 read_skill_resource 读取，不要一次性读取全部资源。');
      }
      return parts.join('\n\n');
    },
  };
}

/**
 * @param {{ tool_switches?: Record<string, boolean> }} ctx
 * @returns {string[]}
 */
function visibleResourceTools(ctx) {
  return ctx.tool_switches?.read_skill_resource === false ? [] : ['read_skill_resource'];
}

/** @returns {import('./context.js').PromptSection} */
function emptySection() {
  return { id: 'skills', render: () => null };
}

/**
 * 回合局部注册资源读取工具。仅在有激活技能时调用。
 * @param {import('./tools/registry.js').ToolRegistry} registry
 * @param {(name: string) => boolean} isActive
 */
export function registerResourceTool(registry, isActive) {
  registry.register({
    name: 'read_skill_resource',
    description: '读取已激活技能附带的资源文件（分页返回，不会一次读全部）。',
    exposure: 'on-demand',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能名，必须已在本回合激活。' },
        path: { type: 'string', description: '资源相对路径。' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: RESOURCE_MAX_LIMIT },
      },
      required: ['skill', 'path'],
    },
    async execute(args, toolCtx) {
      const skill = typeof args?.skill === 'string' ? args.skill : '';
      const path = typeof args?.path === 'string' ? args.path : '';
      if (!skill || !path) throw new Error('参数 skill 和 path 必填。');
      if (!isActive(skill)) throw new Error(`技能 ${skill} 当前未激活。`);
      const offset = args?.offset === undefined ? 0 : args.offset;
      const limit = args?.limit === undefined ? DEFAULT_RESOURCE_LIMIT : args.limit;
      if (!Number.isInteger(offset) || offset < 0) throw new Error('offset 必须是不小于 0 的整数。');
      if (!Number.isInteger(limit) || limit < 1 || limit > RESOURCE_MAX_LIMIT) {
        throw new Error(`limit 必须是 1 到 ${RESOURCE_MAX_LIMIT} 的整数。`);
      }
      const data = await toolCtx.backend.request(
        'POST',
        RESOURCE_PATH(toolCtx.turnId, skill),
        { path },
        toolCtx.signal,
      );
      if (typeof data?.content !== 'string') throw new Error('后端返回的资源内容无效。');
      const total = data.content.length;
      let content = data.content.slice(offset, offset + limit);
      const result = {
        content,
        offset,
        total_chars: total,
        has_more: offset + content.length < total,
      };
      // 引号和控制字符在 JSON 中会膨胀，保留完整分页信息以便继续读取。
      while (JSON.stringify(result).length > RESULT_MAX_CHARS) {
        content = content.slice(0, Math.floor(content.length * 0.8));
        result.content = content;
        result.has_more = offset + content.length < total;
      }
      return result;
    },
  });
}

/**
 * 供测试检查：资源结果文本长度上限与工具注册表结果上限一致。
 * @type {number}
 */
export const SKILL_RESOURCE_MAX_CHARS = RESULT_MAX_CHARS;
