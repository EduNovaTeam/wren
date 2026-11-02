/**
 * 每个回合送给模型的 messages：系统提示 + 预算内的历史回合 + 本回合用户消息。
 */

/**
 * 系统提示的一段。各段按注册顺序拼接，返回空值的段会被跳过。
 * 越靠前的内容越应该稳定不变：模型服务按前缀命中缓存，前面一变后面全部失效。
 * @typedef {object} PromptSection
 * @property {string} id
 * @property {(ctx: import('./types.js').TurnContext) => string|null|undefined} render
 */

/** @type {PromptSection} */
export const identitySection = {
  id: 'identity',
  render: () =>
    [
      '你是 Wren，一个运行在用户本机的助手。',
      '回答使用用户的语言；不确定的事情直接说不确定，不要编造。',
      '需要实时信息或执行操作时使用提供的工具；工具返回错误时，向用户说明而不是假装成功。',
    ].join('\n'),
};

/** @type {PromptSection} */
export const environmentSection = {
  id: 'environment',
  // 只精确到日期：精确到分钟会让每个回合的系统提示都不同。
  render: () => `今天是 ${new Date().toLocaleDateString('zh-CN', { dateStyle: 'full' })}。`,
};

/** @type {PromptSection} */
export const userInstructionsSection = {
  id: 'user-instructions',
  render: (ctx) => (ctx.system_prompt.trim() ? `用户的附加要求：\n${ctx.system_prompt.trim()}` : null),
};

/**
 * 可用 skill 的清单：只有名字和一句话描述，正文由 `use_skill` 按需取。
 * 放在最后：skill 清单可能随安装变化，靠后会少影响前缀缓存。
 * @type {PromptSection}
 */
export const skillsSection = {
  id: 'skills',
  render: (ctx) => {
    const list = ctx.skills ?? [];
    if (!list.length) return null;
    return [
      '可用的 skill（用户的要求正好属于其中某一类时，先用 use_skill 读取它的完整说明再动手，不要凭名字猜内容）：',
      ...list.map((skill) => `- ${skill.name}：${skill.description}`),
    ].join('\n');
  },
};

export const DEFAULT_SECTIONS = [
  identitySection,
  environmentSection,
  userInstructionsSection,
  skillsSection,
];

/**
 * @param {PromptSection[]} sections
 * @param {import('./types.js').TurnContext} ctx
 */
export function buildSystemPrompt(sections, ctx) {
  return sections
    .map((s) => s.render(ctx))
    .filter((text) => typeof text === 'string' && text.trim())
    .join('\n\n');
}

/**
 * 粗略估算 token：中日韩字符约 1 token/字，其余约 4 字符/token。只用于预算，不求精确。
 * @param {string} text
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = text.match(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** @param {import('./types.js').ChatMessage} m */
export function messageTokens(m) {
  let n = 4 + estimateTokens(m.content) + estimateTokens(m.reasoning_content ?? '');
  for (const call of m.tool_calls ?? []) {
    n += estimateTokens(call.function.name) + estimateTokens(call.function.arguments);
  }
  return n;
}

/**
 * 从最新的回合往前取，直到放不下为止；放不下的回合整回合丢弃（不拆开回合）。
 * @param {import('./types.js').HistoryTurn[]} history
 * @param {number} budget
 * @returns {{ messages: import('./types.js').ChatMessage[], keptTurns: number, droppedTurns: number }}
 */
export function selectHistory(history, budget) {
  const kept = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msgs = repairTurn(history[i].messages);
    const cost = msgs.reduce((sum, m) => sum + messageTokens(m), 0);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(msgs);
  }
  return {
    messages: kept.flat(),
    keptTurns: kept.length,
    droppedTurns: history.length - kept.length,
  };
}

/**
 * 被停止或失败的回合可能停在「已发起工具调用、还没有结果」的状态。
 * 模型接口要求每个 tool_call 都有对应的 tool 消息，这里补上占位结果。
 * @param {import('./types.js').ChatMessage[]} messages
 */
export function repairTurn(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const answered = new Set();
    for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
      answered.add(messages[j].tool_call_id);
    }
    const missing = m.tool_calls.filter((c) => !answered.has(c.id));
    // 补在已有 tool 结果之后
    let insertAt = out.length;
    while (messages[i + 1]?.role === 'tool') {
      out.push(messages[++i]);
      insertAt = out.length;
    }
    out.splice(
      insertAt,
      0,
      ...missing.map((c) => ({
        role: /** @type {const} */ ('tool'),
        tool_call_id: c.id,
        name: c.function.name,
        content: '（回合已中断，工具未执行完）',
      })),
    );
  }
  return out;
}
