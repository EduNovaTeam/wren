/**
 * 一个回合内的 Skill 状态。
 *
 * - 回合开始时从后端拿到的激活记录只用于初始化；之后每次模型请求前调用 `refresh()`
 *   重新读取，用户停用 Skill 或关闭工具能立刻反映到下一次请求。
 * - 激活状态以后端为准，模块本身不保存跨回合状态。
 * - 工具权限由 `allowedToolNames()` 按「已注册的普通工具 + 已激活 Skill 声明的按需工具」
 *   算出，每次请求重新计算；同一份集合也用于执行该次响应里的工具调用。
 */

import { readSkillText } from './read.js';

/** 单个资源一次最多返回的字符数。 */
export const RESOURCE_MAX_CHARS = 12_000;

export class SkillActivationError extends Error {}

export class SkillRuntime {
  /**
   * @param {object} options
   * @param {import('./catalog.js').SkillCatalog} options.catalog
   * @param {Record<string, boolean>} [options.skillSwitches]
   * @param {Record<string, boolean>} [options.toolSwitches]
   * @param {{ name: string, source?: string }[]} [options.active]
   * @param {import('../tools/registry.js').ToolRegistry} options.registry
   * @param {import('../backend.js').BackendClient} [options.backend]
   * @param {number} options.sessionId
   * @param {(event: import('../types.js').TurnEvent) => void} [options.emit]
   * @param {number} [options.totalBodyBudgetTokens]
   */
  constructor({
    catalog,
    skillSwitches = {},
    toolSwitches = {},
    active = [],
    registry,
    backend,
    sessionId,
    emit = () => {},
    totalBodyBudgetTokens = 40_000,
  }) {
    this.catalog = catalog;
    this.skillSwitches = { ...skillSwitches };
    this.toolSwitches = { ...toolSwitches };
    this.registry = registry;
    this.backend = backend;
    this.sessionId = sessionId;
    this.emit = emit;
    this.totalBodyBudgetTokens = totalBodyBudgetTokens;
    /** @type {Map<string, { skill: import('./catalog.js').Skill, viaTool: boolean }>} */
    this.active = new Map();
    /** @type {Map<string, string>} */
    this.unavailable = new Map();
    for (const row of active) this.#attach(row.name, { viaTool: false, notify: true });
  }

  /** 已激活且有效的 Skill 名（按激活顺序）。 */
  activeNames() {
    return [...this.active.keys()];
  }

  /**
   * 重新读取后端的启停与激活状态。失败时抛异常，由调用方决定是否沿用旧状态。
   */
  async refresh() {
    if (!this.backend?.request) return;
    const state = await this.backend.request(
      'GET',
      `/internal/sessions/${this.sessionId}/skills/state`,
    );
    this.applyState(state);
  }

  /**
   * @param {{
   *   skill_switches?: Record<string, boolean>,
   *   tool_switches?: Record<string, boolean>,
   *   active_skills?: { name: string }[],
   * }} state
   */
  applyState(state) {
    const rows = Array.isArray(state.active_skills) ? state.active_skills : [];
    const wanted = new Set(rows.map((row) => row.name));

    for (const name of [...this.active.keys()]) {
      if (!wanted.has(name)) this.active.delete(name);
    }
    for (const name of [...this.unavailable.keys()]) {
      if (!wanted.has(name)) this.unavailable.delete(name);
    }
    // 后端返回完整状态；字段缺失时保留当前值，避免把已有开关误清空。
    if (state.skill_switches) this.skillSwitches = { ...state.skill_switches };
    if (state.tool_switches) this.toolSwitches = { ...state.tool_switches };
    for (const row of rows) {
      if (!this.active.has(row.name)) this.#attach(row.name, { viaTool: false, notify: true });
    }
    // 全局停用后，已经激活的 Skill 立即停止加载正文、不再开放工具。
    for (const name of [...this.active.keys()]) {
      if (this.skillSwitches[name] === false) {
        this.#markUnavailable(name, 'Skill 已被全局停用', true);
      }
    }
  }

  /**
   * 激活一个 Skill。重复激活是幂等的。
   * @param {string} rawName
   * @param {{ viaTool?: boolean, trigger?: 'tool'|'command' }} [options]
   * @returns {Promise<{ status: 'activated'|'already', skill: import('./catalog.js').Skill }>}
   */
  async activate(rawName, { viaTool = true, trigger = 'tool' } = {}) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) throw new SkillActivationError('name 不能为空');

    const existing = this.active.get(name);
    if (existing) return { status: 'already', skill: existing.skill };

    const skill = this.catalog.get(name);
    if (!skill) throw new SkillActivationError(`Skill「${name}」不存在`);
    if (!skill.valid) {
      throw new SkillActivationError(`Skill「${name}」不可用：${skill.error}`);
    }
    if (this.skillSwitches[name] === false) {
      throw new SkillActivationError(`Skill「${name}」已停用（设置 → Skills）`);
    }
    const used = [...this.active.values()].reduce(
      (sum, entry) => sum + entry.skill.bodyTokens,
      0,
    );
    if (used + skill.bodyTokens > this.totalBodyBudgetTokens) {
      throw new SkillActivationError(
        `已激活 Skill 的正文超出总预算（${used + skill.bodyTokens} > ` +
          `${this.totalBodyBudgetTokens} tokens），请先移除其他 Skill`,
      );
    }

    if (this.backend?.request) {
      try {
        await this.backend.request(
          'PUT',
          `/internal/sessions/${this.sessionId}/skills/${encodeURIComponent(name)}`,
          { source: skill.source },
        );
      } catch (err) {
        throw new SkillActivationError(
          `保存激活状态失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.active.set(name, { skill, viaTool });
    this.unavailable.delete(name);
    this.emit({
      type: 'skill_activated',
      name,
      description: skill.description,
      source: skill.source,
      trigger,
    });
    return { status: 'activated', skill };
  }

  /**
   * 读取已激活 Skill 的附属文本文件。
   * @param {string} rawName
   * @param {string} path
   * @returns {Promise<{ text: string, truncated: boolean, totalChars: number, size: number }>}
   */
  async readResource(rawName, path) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const entry = this.active.get(name);
    if (!entry) {
      const reason = this.unavailable.get(name);
      if (reason) throw new SkillActivationError(`Skill「${name}」不可用：${reason}`);
      throw new SkillActivationError(`Skill「${name}」未激活，先调用 activate_skill`);
    }
    if (this.skillSwitches[name] === false) {
      throw new SkillActivationError(`Skill「${name}」已停用`);
    }
    return readSkillText(entry.skill.dir, path, { maxChars: RESOURCE_MAX_CHARS });
  }

  /**
   * 本回合送给模型的系统提示片段。
   *
   * 已经作为工具结果返回过正文的 Skill 不再重复注入；如果激活回合还在历史里，正文也已经
   * 由那条工具消息承载，同样不重复。历史被截断后，正文会从系统提示补回。
   * @param {{ history?: import('../types.js').ChatMessage[] }} [options]
   * @returns {{ index: string|null, bodies: string|null }}
   */
  promptState({ history = [] } = {}) {
    const index = this.catalog.renderIndex(this.skillSwitches);
    let toolText = '';
    for (const message of history) {
      if (message.role === 'tool') toolText += `${message.content}\n`;
    }
    const bodies = [];
    for (const [name, entry] of this.active) {
      if (entry.viaTool) continue;
      if (entry.skill.body && toolText.includes(entry.skill.body)) continue;
      bodies.push(`## 已启用 Skill：${name}\n\n${entry.skill.body}`);
    }
    return {
      index,
      bodies: bodies.length
        ? `以下 Skill 在本会话中已启用，按其中的要求完成任务：\n\n${bodies.join('\n\n')}`
        : null,
    };
  }

  /**
   * 当前允许模型使用 / 执行的工具名。每次模型请求前重新计算。
   * @returns {string[]}
   */
  allowedToolNames() {
    const extra = new Set();
    for (const { skill } of this.active.values()) {
      for (const tool of skill.allowedTools) extra.add(tool);
    }
    return this.registry.toolsFor(this.toolSwitches, extra);
  }

  /**
   * @param {string} name
   * @param {{ viaTool: boolean, notify: boolean }} options
   */
  #attach(name, { viaTool, notify }) {
    const skill = this.catalog.get(name);
    if (!skill) return this.#markUnavailable(name, 'Skill 不存在（可能已被删除）', notify);
    if (!skill.valid) {
      return this.#markUnavailable(name, `Skill 不可用：${skill.error}`, notify);
    }
    if (this.skillSwitches[name] === false) {
      return this.#markUnavailable(name, 'Skill 已被全局停用', notify);
    }
    // 恢复 / 刷新激活状态也必须遵守总预算，不能因为激活记录已经存在就绕过。
    const used = [...this.active.values()].reduce(
      (sum, entry) => sum + entry.skill.bodyTokens,
      0,
    );
    if (used + skill.bodyTokens > this.totalBodyBudgetTokens) {
      return this.#markUnavailable(
        name,
        `已激活 Skill 的正文超出总预算（${used + skill.bodyTokens} > ` +
          `${this.totalBodyBudgetTokens} tokens），请先移除其他 Skill`,
        notify,
      );
    }
    this.unavailable.delete(name);
    this.active.set(name, { skill, viaTool });
    return undefined;
  }

  /**
   * @param {string} name
   * @param {string} reason
   * @param {boolean} notify
   */
  #markUnavailable(name, reason, notify) {
    this.active.delete(name);
    const previous = this.unavailable.get(name);
    this.unavailable.set(name, reason);
    if (notify && previous !== reason) this.emit({ type: 'skill_unavailable', name, reason });
  }
}
