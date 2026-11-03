/**
 * 回合循环：调模型 → 有工具调用就执行并把结果交回模型 → 直到模型给出最终回答。
 *
 * 一个回合内每产生一条完整消息（assistant 或 tool）就发一个 `message` 事件，后端据此落库；
 * 下个回合的历史只从后端读取，本进程不保存任何跨回合状态。
 */

import { buildSystemPrompt, selectHistory } from './context.js';
import { LLMError, streamCompletion } from './llm.js';
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
 * @typedef {object} TurnDeps
 * @property {import('./tools/registry.js').ToolRegistry} registry
 * @property {import('./context.js').PromptSection[]} sections
 * @property {import('./backend.js').BackendClient} backend
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

  // 本回合可见的工具在开始时确定，整个回合不变。
  // 生效中的 skill 通过 allowed-tools 带进来的工具也算在内；回合中间才读到的 skill，
  // 它的工具要到下一个回合才出现，这样一回合内的工具集不会变。
  const skillTools = (ctx.active_skills ?? []).flatMap((s) => s.allowed_tools ?? []);
  const visibleNames = deps.registry.visibleTools(ctx.tool_switches, skillTools);
  const visible = new Set(visibleNames);
  const tools = deps.registry.schemas(visibleNames);

  // 提示里只说真正开放了的工具：skill 里写了没注册的名字（如 run_sql）不能声称为可用。
  const plainNames = new Set(deps.registry.visibleTools(ctx.tool_switches));
  const granted = new Set(visibleNames.filter((name) => !plainNames.has(name)));
  const promptCtx = ctx.active_skills?.some((s) => s.allowed_tools?.length)
    ? {
        ...ctx,
        active_skills: ctx.active_skills.map((s) => ({
          ...s,
          allowed_tools: (s.allowed_tools ?? []).filter((name) => granted.has(name)),
        })),
      }
    : ctx;

  const history = selectHistory(ctx.history, model.history_budget_tokens);
  /** @type {import('./types.js').ChatMessage[]} */
  const messages = [
    { role: 'system', content: buildSystemPrompt(deps.sections, promptCtx) },
    ...history.messages,
    ctx.user_message,
  ];
  emit({
    type: 'turn_info',
    tools: visibleNames,
    history_turns: history.keptTurns,
    dropped_turns: history.droppedTurns,
  });

  const toolCtx = {
    sessionId: ctx.session_id,
    turnId: ctx.turn_id,
    backend: deps.backend,
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
      const last = step === model.max_steps;
      emit({ type: 'step_start', step });
      partial = { reasoning: '', text: '' };

      const result = await withRetry(
        () =>
          complete({
            model,
            messages: toApiMessages(messages),
            tools,
            // 最后一步仍带上 tools（思考模式下回传 reasoning_content 的规则依赖它），但禁止再调用。
            ...(last && tools.length ? { toolChoice: 'none' } : {}),
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
        const out = await runTool(deps.registry, visible, call, { ...toolCtx, signal });
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
