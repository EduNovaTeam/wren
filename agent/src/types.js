// 共享的 JSDoc 类型定义，没有运行时代码。

/**
 * OpenAI Chat Completions 形状的消息（DeepSeek 额外有 reasoning_content）。
 * @typedef {object} ChatMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string} content
 * @property {string} [reasoning_content]
 * @property {ToolCall[]} [tool_calls]
 * @property {string} [tool_call_id]
 * @property {string} [name]
 */

/**
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {'function'} type
 * @property {{ name: string, arguments: string }} function
 */

/**
 * @typedef {object} SkillSummary
 * @property {string} name
 * @property {string} description
 * @property {'builtin'|'user'} source
 */

/**
 * 后端 `GET /internal/turns/:id/context` 的返回值。
 * @typedef {object} TurnContext
 * @property {number} session_id
 * @property {number} turn_id
 * @property {ModelSettings} model
 * @property {string} system_prompt  用户在设置页填写的自定义提示，可能为空
 * @property {Record<string, boolean>} tool_switches
 * @property {SkillSummary[]} skills  可用的 skill 清单（只有名字和描述，正文按需读取）
 * @property {HistoryTurn[]} history  按时间顺序，已结束的回合
 * @property {ChatMessage} user_message
 */

/**
 * @typedef {object} HistoryTurn
 * @property {number} turn_id
 * @property {'done'|'stopped'|'failed'} status
 * @property {ChatMessage[]} messages
 */

/**
 * @typedef {object} ModelSettings
 * @property {string} base_url
 * @property {string} model
 * @property {string} api_key
 * @property {'default'|'enabled'|'disabled'} thinking
 * @property {''|'low'|'high'|'max'} reasoning_effort
 * @property {number} max_steps
 * @property {number} history_budget_tokens
 */

/**
 * agent 发给后端的事件（NDJSON，一行一个）。见 docs/ARCHITECTURE.md「事件」。
 * @typedef {{ type: string, [key: string]: unknown }} TurnEvent
 */

export {};
