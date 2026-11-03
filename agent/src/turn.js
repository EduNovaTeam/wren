/**
 * 回合循环：调模型 → 有工具调用就执行并把结果交回模型 → 直到模型给出最终回答。
 *
 * 一个回合内每产生一条完整消息（assistant 或 tool）就发一个 `message` 事件，后端据此落库；
 * 下个回合的历史只从后端读取，本进程不保存任何跨回合状态。
 *
 * 工具列表在每次模型请求前重新计算（Skill 激活会开放新工具）；每个工具调用执行前再读一次
 * 状态，并同时遵守「发出请求时的集合」和「执行前重新读取到的集合」，因此：
 * - 同一个响应里刚完成的激活不会让其他调用获得新权限；
 * - 用户中途停用工具或 Skill、甚至前一个调用改变了权限，后续调用都会立即被拒绝；
 * - 状态读取失败时不沿用旧权限，直接拒绝执行。
 */

import { buildSystemPrompt, selectHistory } from './context.js';
import { LLMError, streamCompletion } from './llm.js';
import { loadCatalog } from './skills/catalog.js';
import { SkillRuntime } from './skills/runtime.js';
import { runTool } from './tools/registry.js';

/** 框架自身使用的事件类型。工具通过 ctx.emit 发的自定义事件不能占用这些名字。 */
export const CORE_EVENTS = new Set([
  'turn_info',
  'step_start',
  'reasoning_delta',
  'text_delta',
  'message',
  'tool_start',
  'tool_end',
  'usage',
  'turn_end',
]);

const RETRY_DELAYS_MS = [1000, 3000];

/**
 * @typedef {object} SkillOptions
 * @property {string} [builtinDir]
 * @property {string} [userDir]
 * @property {number} [bodyBudgetTokens]
 * @property {number} [indexBudgetTokens]
 * @property {number} [totalBodyBudgetTokens]
 */

/**
 * @typedef {object} TurnDeps
 * @property {import('./tools/registry.js').ToolRegistry} registry
 * @property {import('./context.js').PromptSection[]} sections
 * @property {import('./backend.js').BackendClient} backend
 * @property {SkillOptions} [skillOptions]
 * @property {typeof streamCompletion} [complete]  测试时可替换
 */

/**
 * @param {import('./types.js').TurnContext} ctx
 * @param {TurnDeps} deps
 * @param {(event: import('./types.js').TurnEvent) => void} emit
 * @param {AbortSignal} signal
 * @returns {Promise<void>} 总是以 turn_end 事件结束，不会抛出
 */
export async function runTurn(ctx, deps, emit, signal) {
  const complete = deps.complete ?? streamCompletion;
  const model = ctx.model;

  // 一个回合内共用同一份 Skill 快照：正文、依赖和权限不会来自不同版本的文件。
  let catalog;
  try {
    catalog = await loadCatalog({
      ...deps.skillOptions,
      toolNames: deps.registry.toolNames(),
    });
  } catch (err) {
    emit({ type: 'turn_end', status: 'failed', error: `读取 Skill 失败：${errorMessage(err)}` });
    return;
  }

  const skills = new SkillRuntime({
    catalog,
    skillSwitches: ctx.skill_switches ?? {},
    toolSwitches: ctx.tool_switches ?? {},
    active: ctx.active_skills ?? [],
    registry: deps.registry,
    backend: deps.backend,
    sessionId: ctx.session_id,
    emit,
    totalBodyBudgetTokens: deps.skillOptions?.totalBodyBudgetTokens ?? 40_000,
  });

  // 消息开头的 /skill-name 由程序自动激活，和模型调用激活走同一套校验。
  const command = parseSkillCommand(ctx.user_message.content);
  if (command) {
    try {
      await skills.activate(command.name, { viaTool: false, trigger: 'command' });
    } catch (err) {
      emit({
        type: 'turn_end',
        status: 'failed',
        error: `无法激活 Skill「${command.name}」：${errorMessage(err)}`,
      });
      return;
    }
  }

  const history = selectHistory(ctx.history, model.history_budget_tokens);
  /** @type {import('./types.js').ChatMessage[]} */
  const messages = [...history.messages, ctx.user_message];

  const toolCtx = {
    sessionId: ctx.session_id,
    turnId: ctx.turn_id,
    backend: deps.backend,
    skills,
    /** @param {import('./types.js').TurnEvent} event */
    emit(event) {
      if (!event || typeof event.type !== 'string' || CORE_EVENTS.has(event.type)) {
        throw new Error(`自定义事件类型不合法：${event?.type}`);
      }
      emit(event);
    },
  };

  let partial = { reasoning: '', text: '' };
  try {
    for (let step = 1; step <= model.max_steps; step++) {
      // 每次请求前重新读取启停 / 激活状态，让停用和移除立即生效。
      await refreshSkills(skills);
      const requestNames = skills.allowedToolNames();
      const requestAllowed = new Set(requestNames);
      emit({
        type: 'turn_info',
        tools: requestNames,
        skills: skills.activeNames(),
        history_turns: history.keptTurns,
        dropped_turns: history.droppedTurns,
      });

      const last = step === model.max_steps;
      emit({ type: 'step_start', step });
      partial = { reasoning: '', text: '' };

      const result = await withRetry(
        () =>
          complete({
            model,
            messages: toApiMessages([
              { role: 'system', content: buildSystemPrompt(deps.sections, withSkillPrompt(ctx, skills, history.messages)) },
              ...messages,
            ]),
            tools: deps.registry.schemas(requestNames),
            // 最后一步仍带上 tools（思考模式下回传 reasoning_content 的规则依赖它），但禁止再调用。
            ...(last && requestNames.length ? { toolChoice: 'none' } : {}),
            signal,
            onDelta(delta) {
              if (delta.reasoning) {
                partial.reasoning += delta.reasoning;
                emit({ type: 'reasoning_delta', text: delta.reasoning });
              }
              if (delta.text) {
                partial.text += delta.text;
                emit({ type: 'text_delta', text: delta.text });
              }
            },
          }),
        () => partial.reasoning === '' && partial.text === '',
        signal,
      );
      partial = { reasoning: '', text: '' };
      if (result.usage) emit({ type: 'usage', usage: result.usage });

      const assistant = result.message;
      messages.push(assistant);
      emit({ type: 'message', message: assistant });

      if (!assistant.tool_calls?.length) {
        emit({ type: 'turn_end', status: 'done' });
        return;
      }

      for (const call of assistant.tool_calls) {
        emit({
          type: 'tool_start',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
        // 每个调用执行前都重新读状态：同一个响应里的前一个调用可能改了权限，
        // 用户也可能在调用之间关闭工具或停用 Skill。无法确认状态时拒绝执行。
        const live = await refreshSkills(skills);
        let out;
        if (!live) {
          out = {
            ok: false,
            content:
              `错误：无法确认当前的 Skill / 工具权限（状态读取失败），已拒绝执行「${call.function.name}」。` +
              '请稍后重试。',
          };
        } else {
          const execAllowed = new Set(
            skills.allowedToolNames().filter((name) => requestAllowed.has(name)),
          );
          out = await runTool(deps.registry, execAllowed, call, { ...toolCtx, signal });
        }
        /** @type {import('./types.js').ChatMessage} */
        const toolMsg = {
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: out.content,
        };
        messages.push(toolMsg);
        emit({ type: 'message', message: toolMsg });
        emit({ type: 'tool_end', call_id: call.id, name: call.function.name, ok: out.ok });
      }
    }
    emit({ type: 'turn_end', status: 'failed', error: `超过单回合步数上限（${model.max_steps}）` });
  } catch (err) {
    // 已经流出来的正文要保住：停止 / 出错时把它作为一条 assistant 消息落库。
    if (partial.text || partial.reasoning) {
      emit({
        type: 'message',
        message: {
          role: 'assistant',
          content: partial.text,
          ...(partial.reasoning ? { reasoning_content: partial.reasoning } : {}),
        },
      });
    }
    if (signal.aborted) {
      emit({ type: 'turn_end', status: 'stopped' });
    } else {
      emit({ type: 'turn_end', status: 'failed', error: errorMessage(err) });
    }
  }
}

/**
 * 从用户消息开头解析 `/skill-name`。只在消息开头识别，正文里的 /xxx 不是命令。
 * @param {string} content
 * @returns {{ name: string } | null}
 */
export function parseSkillCommand(content) {
  const match = /^\s*\/([a-z0-9][a-z0-9-]{0,63})(?=\s|$)/.exec(String(content ?? ''));
  return match ? { name: match[1] } : null;
}

/**
 * 重新读取后端的 Skill 状态。返回是否成功。
 *
 * 请求前读取失败时沿用回合已有的快照继续对话：此时还没有执行任何依赖权限的动作。
 * 执行工具调用前读取失败则必须由调用方拒绝执行，不能拿旧权限冒险。
 *
 * @param {SkillRuntime} skills
 * @returns {Promise<boolean>}
 */
async function refreshSkills(skills) {
  try {
    await skills.refresh();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('./types.js').TurnContext} ctx
 * @param {SkillRuntime} skills
 * @param {import('./types.js').ChatMessage[]} history
 * @returns {import('./types.js').TurnContext}
 */
function withSkillPrompt(ctx, skills, history) {
  return { ...ctx, skill_prompt: skills.promptState({ history }) };
}

/**
 * 去掉只给本系统用的字段，得到可以直接发给模型接口的 messages。
 * @param {import('./types.js').ChatMessage[]} messages
 */
export function toApiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      const { name, ...rest } = m;
      return rest;
    }
    // 思考模式 + tools 时，每条历史 assistant 消息都必须带 reasoning_content。
    // 停止时落库的半截消息、关闭思考时产生的消息可能没有，补空字符串。
    if (m.role === 'assistant' && typeof m.reasoning_content !== 'string') {
      return { ...m, reasoning_content: '' };
    }
    return m;
  });
}

/**
 * 只在还没有向用户输出任何内容时重试（否则重试会让前端看到重复的文字）。
 * @template T
 * @param {() => Promise<T>} fn
 * @param {() => boolean} canRetry
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
async function withRetry(fn, canRetry, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (!(err instanceof LLMError) || !err.retryable || delay === undefined || !canRetry()) {
        throw err;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    }
  }
}

/** @param {unknown} err */
function errorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
