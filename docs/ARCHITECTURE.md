# 架构

```
浏览器 (web/)  ──REST + SSE──▶  后端 (backend/, Flask)  ──HTTP, NDJSON──▶  agent (agent/, Node)  ──▶  模型接口
                                    ▲                                          │
                                    └──────────── /internal/*（带口令）─────────┘
```

| 进程 | 默认端口 | 职责 |
|---|---|---|
| backend | 5280 | 会话、回合、消息、设置、笔记、Skill 启停与激活状态的存储和接口；回合调度；浏览器的唯一入口 |
| agent | 5281 | 一个回合内的循环：扫描 Skill → 组装上下文 → 调模型 → 执行工具 → 再调模型 |
| web | 5173（开发） | 界面。开发时 Vite 把 `/api` 代理到后端 |

Skill 的目录格式、激活方式、工具授权和预算见 [SKILLS.md](SKILLS.md)。

## 既有设定

改动前请先确认是否与这些设定冲突；需要打破时在 PR 里说明。

1. **后端是唯一的持久化层。** agent 进程不保存任何跨回合状态，可以随时重启；工具需要读写数据时调用后端的 `/internal/*` 接口。
2. **回合记录是完整的。** 每个回合保存用户消息，以及 agent 产生的每一条 assistant / tool 消息，字段与 Chat Completions 一致（包括 `reasoning_content`、`tool_calls`）。思考模式下带 `tools` 的请求必须回传历史上的 `reasoning_content`，所以不能只存正文。
3. **历史按预算截断。** agent 从最新的回合往前取，放不下的回合整回合丢弃（`context.js` 的 `selectHistory`）；预算在「设置 → 模型 → 历史预算」，按估算 token 计。被丢弃的回合模型看不到，界面会提示。
4. **工具可见列表在每次模型请求前确定。** `SkillRuntime.allowedToolNames()` 按设置页的开关和已激活 Skill 的 `allowed-tools` 算出这一次请求的工具；发送给模型的 `tools` 参数和执行该次响应里的工具调用使用同一份集合。每个工具调用执行前都会重新读取状态，并与请求时的集合取交集，因此同一个响应里的前一个调用、或用户中途停用，都会立即撤销后续调用的权限。状态读取失败时拒绝执行，不沿用旧权限。
   - 取舍：原来的「整个回合固定」无法支持「激活 Skill 后开放它需要的工具」，也无法让用户在回合中途撤销权限。代价是每次模型请求和每个工具调用都要读一次后端状态（本地 HTTP，开销很小），并且同一响应里刚完成的激活不会追溯地放宽该响应中其他调用的权限。
5. **单用户、无登录。** 后端只监听 127.0.0.1。
6. **同一会话同时只有一个进行中的回合。** 第二个请求返回 409。
7. **后端单进程运行。** 回合运行器在进程内存里（`turns.py`），不支持多 worker。

## 一个回合的流程

1. 浏览器 `POST /api/sessions/:id/turns {content}`。后端在一个事务里建回合（`running`）并写入用户消息，返回 `turn_id`。
2. 后端起一个线程，`POST agent/turns {session_id, turn_id}`，读取 NDJSON 事件流。
3. agent 调 `GET /internal/turns/:id/context`，拿到模型配置、附加系统提示、工具开关、Skill 启停、本会话已激活的 Skill、历史回合和本回合用户消息。
4. agent 扫描两个 Skill 目录（内置 `skills/`、用户目录），得到本回合的 Skill 快照；如果用户消息以 `/skill-name` 开头，先按快照校验并激活（激活状态写回后端）。
5. agent 组装每个请求的 messages：系统提示（身份 / 附加要求 / 可用 Skill 目录 / 已激活 Skill 正文）+ `selectHistory()` 选出的历史 + 用户消息，然后进入循环（`turn.js`）。如果某条激活工具的结果已经在保留下来的历史里，系统提示不再重复注入同一个 Skill 的正文：
   - 每次请求前重新读取启停与激活状态，算出这一次请求的工具列表，发 `turn_info`（`tools`、`skills`）；
   - 流式调用模型，边收边发 `reasoning_delta` / `text_delta`；
   - 收完后发 `message`（完整的 assistant 消息），后端落库；
   - 有工具调用就逐个执行（执行前再读一次状态，只执行该请求允许且现在仍允许的工具），每个结果作为 `message`（tool 消息）发出并落库；然后进入下一步；
   - 没有工具调用即结束，发 `turn_end`。最后一步会带 `tool_choice: none`，强制模型给出回答。
   - Skill 工具激活后发 `skill_activated`；已激活的 Skill 被删除 / 失效 / 停用时发 `skill_unavailable`。
6. 后端收到 `turn_end` 把回合迁到终态（只迁一次），并转发给浏览器。
7. 浏览器 `GET /api/turns/:id/events`（SSE）订阅。订阅时先补发本回合已产生的全部事件，因此刷新页面后可以接着看。

停止：浏览器 `POST /api/turns/:id/stop` → 后端转发 `POST agent/turns/:id/abort` → agent 中止模型请求或工具，把已输出的部分作为一条 assistant 消息落库，以 `stopped` 结束。agent 10 秒内没收尾时后端强制结束。

后端重启时，残留的 `running` 回合会被标记为 `failed`。

## 事件

agent → 后端（NDJSON）与 后端 → 浏览器（SSE `data:`）使用同一套事件，后端只额外加了 `turn_start`。

| type | 字段 | 说明 |
|---|---|---|
| `turn_start` | `turn_id`, `user_message_id` | 后端产生 |
| `turn_info` | `tools`, `skills`, `history_turns`, `dropped_turns` | 本次请求可见的工具（含 Skill 按需工具）、已激活 Skill、实际发送 / 丢弃的历史回合数 |
| `step_start` | `step` | 每次调用模型前 |
| `reasoning_delta` / `text_delta` | `text` | 增量，仅用于显示，不落库 |
| `message` | `message` | 一条完整消息（assistant 或 tool），**后端据此落库** |
| `tool_start` / `tool_end` | `call_id`, `name`, (`arguments` / `ok`) | 工具执行开始 / 结束 |
| `usage` | `usage` | 本步 token 用量，后端累加 |
| `turn_end` | `status`, `error?` | `done` / `stopped` / `failed` |
| `skill_activated` | `name`, `source`, `trigger` | 激活了 Skill；`trigger` 为 `tool` 或 `command` |
| `skill_unavailable` | `name`, `reason` | 已激活的 Skill 现在不可用（被删、失效、停用） |
| 其他 | 任意 | 工具通过 `ctx.emit()` 发出的自定义事件，原样转发给浏览器 |

## 数据

| 表 | 说明 |
|---|---|
| `sessions` | 会话 |
| `turns` | 回合：`status`（running / done / stopped / failed）、`error`、`usage` |
| `messages` | 模型可见的消息：`role`、`content`、`reasoning_content`、`tool_calls`（JSON）、`tool_call_id`、`name` |
| `settings` | 键值：`model`（含 api_key）、`tools`（开关）、`system_prompt` |
| `notes` | 笔记 |
| `skill_settings` | Skill 全局启停（只保存用户显式改过的项，缺省启用） |
| `session_skills` | 每个会话已激活的 Skill 及其来源；会话删除时级联删除 |

## 扩展点

以「笔记」功能为例（提交 `feat(notes)`），一个跨三层的功能需要动的地方：

**backend**

- 新表：`wren/migrations/NNN_xxx.sql`，启动时自动执行。
- 新接口：在 `wren/api/` 写蓝图，加进 `app.py` 的 `BLUEPRINTS`。给 agent 用的接口放在 `/internal/` 下，并 `before_request(require_token)`。
- 请求内用 `api.db()` 取连接。

**agent**

- 新工具：写一个 `ToolDefinition`（`tools/registry.js` 有字段说明），在 `tools/index.js` 注册。
  - `execute(args, ctx)`：`ctx.backend.request()` 调后端，`ctx.signal` 用于停止 / 超时，`ctx.emit()` 发自定义事件。
  - 返回字符串或可 JSON 序列化的值；抛异常会变成给模型看的错误文本，不会中断回合。
  - `exposure: 'on-demand'`：默认不可见，也不出现在设置页（例如 `fetch_url`）。
- 系统提示：由 `context.js` 的 `PromptSection` 按顺序拼接（`DEFAULT_SECTIONS`）。越靠前越应该稳定，模型服务按前缀命中缓存。
- Skill：扫描与校验在 `skills/catalog.js`，安全读取在 `skills/read.js`，回合内状态与工具权限在 `skills/runtime.js`，两个模型工具在 `tools/skills.js`。新增 Skill 只需要放目录，不需要改代码；新增「按需工具」时在 `ToolDefinition` 上标 `exposure: 'on-demand'` 即可在设置页看到它。

**web**

- 新页面：在 `router.js` 加路由，在 `nav.js` 登记入口。
- 渲染自定义事件：`chat/renderers.js` 的 `registerEventRenderer(type, Component)`，组件收到 `event` 属性；Skill 事件在 `features/skills.js` 注册。
- 接口调用统一放在 `api/client.js`。

## 测试替身

- `agent/test/support/fake-llm.js`：OpenAI 兼容的流式模型服务，按顺序回放预设回复，记录收到的请求；会像真实服务一样拒绝缺少 `reasoning_content` 的请求。
- `backend/tests/conftest.py` 的 `FakeAgent`：按脚本回放 agent 事件。
- `scripts/e2e.mjs`：真实启动后端与 agent，模型换成 fake LLM。
