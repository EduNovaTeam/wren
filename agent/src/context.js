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
 * 本回合可以调用哪些工具，逐个写出来。
 *
 * 工具定义本身会作为接口参数发给模型，但实测它会凭印象说「我没有这个工具」，
 * 甚至读到别处的说明也照样否认。写在系统提示里、并且每回合重算，它才肯认。
 * 单独成段而不是塞进 skill 段：塞进去会被当成 skill 自己的说法，不被当作事实。
 * @type {PromptSection}
 */
export const toolsSection = {
  id: 'tools',
  render: (ctx) => {
    const tools = ctx.visible_tools ?? [];
    if (!tools.length) return null;
    return `本回合可调用的工具：${tools.join('、')}。以这份列表为准，回合内不会变化。`;
  },
};

/**
 * skill 的存在性提示：不列清单，只说明「有，可以查」。
 *
 * 清单本身每回合都要付 token，而多数对话一个 skill 都用不到；改成按需查询后，
 * 这段文案不随 skill 数量变化，也顺带对前缀缓存友好。
 * @type {PromptSection}
 */
export const skillsSection = {
  id: 'skills',
  render: (ctx) =>
    ctx.skills?.length
      ? '有可用的 skill。用户的要求如果像是有现成做法可循（成文的流程、模板、规范），先调用 use_skill 查看清单，再按名字读取说明照着做；不要凭名字猜内容。'
      : null,
};

/**
 * 生效中的 skill，正文直接写进系统提示。
 *
 * 分两种来源：用户这一条消息点名的，和本会话此前用上、继续生效的。
 *
 * 会话这一种有两点讲究，都是踩过坑才加上的：
 * 1. 必须说清「对之后每条消息都生效、没有命令也照样用」。只说「继续按它说的做」时，
 *    模型会退回按适用范围判断，没有命令前缀的下一句就被当成普通聊天。
 * 2. 不能带 description。skill 的描述是写给挑选用的触发条件（「用户要求翻译时，
 *    或以 /translate 开头时」），一旦出现在「当前生效」的上下文里，模型就拿它
 *    反过来论证这个 skill 此刻不适用——正文还在提示里，却一次都没被用。
 *
 * 排最后：这一段的存废和内容随会话变化，靠后能少破坏前面的前缀缓存。
 * @type {PromptSection}
 */
export const activeSkillsSection = {
  id: 'active-skills',
  render: (ctx) => {
    const active = ctx.active_skills ?? [];
    if (!active.length) return null;
    return active
      .map((skill) => {
        const parts =
          skill.reason === 'session'
            ? [
                `本会话已启用 skill「${skill.name}」，它对之后每条消息都生效，即使消息里没有 /${skill.name}`
                  + ' 命令也照样按它处理。下面是当前生效的做法：',
                skill.body,
              ]
            : [
                `用户指定本回合使用 skill「${skill.name}」（${skill.description}），照它说的做：`,
                skill.body,
              ];
        // 工具清单是接口参数，模型未必会去翻；实测它会顺着上一句「下一回合才能用」继续说没有。
        // 所以这里把已开放的工具写成文字，明确到「现在就能调」。
        if (skill.allowed_tools?.length) {
          parts.push(
            `这个 skill 需要的工具本回合已经开放：${skill.allowed_tools.join('、')}。`
              + '需要时直接调用，不要说它不存在或再等一个回合。',
          );
        }
        if (skill.reason === 'session') {
          parts.push('用户明确说停用、或明确要你去做别的事时才不套用它。');
        }
        if (skill.files?.length) {
          parts.push(
            `附带文件：${skill.files.join('、')}。需要时用 use_skill({ name: '${skill.name}', file }) 读取。`,
          );
        }
        return parts.join('\n\n');
      })
      .join('\n\n');
  },
};

export const DEFAULT_SECTIONS = [
  identitySection,
  environmentSection,
  userInstructionsSection,
  toolsSection,
  skillsSection,
  activeSkillsSection,
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
