/**
 * 工具注册表。
 *
 * 每个工具是一个普通对象（见 ToolDefinition），在 `src/tools/index.js` 里注册。
 * 模型可见的工具由 `toolsFor()` 在每次模型请求前计算：设置页开启的普通工具，加上
 * 已激活 Skill 声明的按需工具。框架自身的工具（core）始终可见。
 */

/**
 * @typedef {object} ToolContext
 * @property {number} sessionId
 * @property {number} turnId
 * @property {AbortSignal} signal  回合被停止或工具超时时触发
 * @property {import('../backend.js').BackendClient} backend  读写持久化数据走这里
 * @property {(event: import('../types.js').TurnEvent) => void} emit  向前端发自定义事件
 */

/**
 * @typedef {object} ToolDefinition
 * @property {string} name  只能用字母、数字、下划线、短横线
 * @property {string} description  给模型看的说明：做什么、什么时候用
 * @property {object} parameters  JSON Schema（type: object）
 * @property {'default'|'on-demand'|'core'} [exposure]
 *   default：按设置页的开关决定是否可见（默认）。
 *   on-demand：默认不可见；只有已激活 Skill 的 allowed-tools 声明它、且用户没有
 *     明确关闭时才开放。设置页会列出它，供用户明确禁用。
 *   core：框架自身使用的工具（例如 activate_skill），始终可见，不出现在设置页。
 * @property {number} [timeoutMs]  默认 30 秒
 * @property {number} [maxResultChars]  返回给模型的最大字符数，默认 20000；
 *   Skill 正文工具需要放宽到正文预算允许的长度，避免截断关键指引。
 * @property {(args: any, ctx: ToolContext) => Promise<unknown>|unknown} execute
 *   返回字符串或可 JSON 序列化的值；抛出的异常会作为错误结果交给模型。
 */

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, Required<Omit<ToolDefinition, 'execute'>> & Pick<ToolDefinition, 'execute'>>} */
    this.tools = new Map();
  }

  /** @param {ToolDefinition} def */
  register(def) {
    if (!NAME_RE.test(def.name)) throw new Error(`工具名不合规：${def.name}`);
    if (this.tools.has(def.name)) throw new Error(`工具重复注册：${def.name}`);
    if (def.parameters?.type !== 'object') throw new Error(`${def.name}: parameters 必须是 object schema`);
    if (def.exposure && !['default', 'on-demand', 'core'].includes(def.exposure)) {
      throw new Error(`${def.name}: exposure 只能是 default / on-demand / core`);
    }
    if (typeof def.execute !== 'function') throw new Error(`${def.name}: 缺少 execute`);
    this.tools.set(def.name, {
      exposure: 'default',
      timeoutMs: 30_000,
      maxResultChars: RESULT_MAX_CHARS,
      ...def,
    });
    return this;
  }

  /** @param {string} name */
  get(name) {
    return this.tools.get(name);
  }

  /** 全部工具名（Skill 校验 allowed-tools 用）。 */
  toolNames() {
    return [...this.tools.keys()];
  }

  /** 给后端设置页用的工具清单。按需工具也列出来，用户可以明确禁用。 */
  list() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      exposure: t.exposure,
      toggleable: t.exposure !== 'core',
    }));
  }

  /**
   * 本回合对模型可见的工具名（有序）。
   * @param {Record<string, boolean>} switches  设置页的开关，缺省视为开启
   * @returns {string[]}
   */
  visibleTools(switches) {
    return [...this.tools.values()]
      .filter((t) => t.exposure === 'default' && switches[t.name] !== false)
      .map((t) => t.name);
  }

  /**
   * 一次模型请求可以使用的工具名（有序）：框架工具 + 开关打开的普通工具 +
   * 已激活 Skill 声明、且用户没有明确关闭的按需工具。
   * @param {Record<string, boolean>} switches
   * @param {Iterable<string>} [extra]  Skill 的 allowed-tools
   * @returns {string[]}
   */
  toolsFor(switches, extra = []) {
    const extraNames = new Set(extra);
    return [...this.tools.values()]
      .filter((t) => {
        if (t.exposure === 'core') return true;
        if (switches[t.name] === false) return false;
        return t.exposure === 'default' || extraNames.has(t.name);
      })
      .map((t) => t.name);
  }

  /**
   * 转成 Chat Completions 的 tools 参数。
   * @param {string[]} names
   */
  schemas(names) {
    return names.map((name) => {
      const t = /** @type {NonNullable<ReturnType<ToolRegistry['get']>>} */ (this.tools.get(name));
      return {
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      };
    });
  }
}

export const RESULT_MAX_CHARS = 20_000;

/**
 * 执行一次工具调用。永不抛出（停止除外）：参数错误、超时、工具异常都变成给模型看的错误文本。
 * @param {ToolRegistry} registry
 * @param {Set<string>} visible  本回合可见的工具
 * @param {import('../types.js').ToolCall} call
 * @param {Omit<ToolContext, 'signal'> & { signal: AbortSignal }} ctx
 * @returns {Promise<{ ok: boolean, content: string }>}
 */
export async function runTool(registry, visible, call, ctx) {
  const name = call.function.name;
  const tool = registry.get(name);
  if (!tool || !visible.has(name)) {
    return { ok: false, content: `错误：工具 ${name} 不存在或当前不可用。` };
  }
  let args;
  try {
    args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
  } catch {
    return { ok: false, content: '错误：参数不是合法的 JSON。' };
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, content: '错误：参数必须是 JSON 对象。' };
  }

  // 用普通 setTimeout 而不是 AbortSignal.timeout()：后者在部分 Node 版本里不占用事件循环，
  // 工具一直不返回时进程可能在超时触发前就认为无事可做。
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('timeout')), tool.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout.signal]);
  try {
    const value = await raceAbort(Promise.resolve(tool.execute(args, { ...ctx, signal })), signal);
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return { ok: true, content: truncate(text, tool.maxResultChars) };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    if (timeout.signal.aborted) return { ok: false, content: `错误：工具执行超时（${tool.timeoutMs}ms）。` };
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `错误：${truncate(message, 2000)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * @param {string} text
 * @param {number} [max]
 */
function truncate(text, max = RESULT_MAX_CHARS) {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，原长 ${text.length} 字符）` : text;
}
