# 架构

```
浏览器 (web/)  ──REST + SSE──▶  后端 (backend/, Flask)  ──HTTP, NDJSON──▶  agent (agent/, Node)  ──▶  模型接口
                                    ▲                                          │
                                    └──────────── /internal/*（带口令）─────────┘
```

| 进程 | 默认端口 | 职责 |
|---|---|---|
| backend | 5280 | 会话、回合、消息、设置、笔记的存储与接口；回合调度；浏览器的唯一入口 |
| agent | 5281 | 一个回合内的循环：组装上下文 → 调模型 → 执行工具 → 再调模型 |
| web | 5173（开发） | 界面。开发时 Vite 把 `/api` 代理到后端 |

## 既有设定

改动前请先确认是否与这些设定冲突；需要打破时在 PR 里说明。

1. **后端是唯一的持久化层。** agent 进程不保存任何跨回合状态，可以随时重启；工具需要读写数据时调用后端的 `/internal/*` 接口。
2. **回合记录是完整的。** 每个回合保存用户消息，以及 agent 产生的每一条 assistant / tool 消息，字段与 Chat Completions 一致（包括 `reasoning_content`、`tool_calls`）。思考模式下带 `tools` 的请求必须回传历史上的 `reasoning_content`，所以不能只存正文。
3. **历史按预算截断。** agent 从最新的回合往前取，放不下的回合整回合丢弃（`context.js` 的 `selectHistory`）；预算在「设置 → 模型 → 历史预算」，按估算 token 计。被丢弃的回合模型看不到，界面会提示。
4. **工具可见列表在回合开始时确定。** `ToolRegistry.visibleTools()` 按设置页的开关算出本回合的工具，整个回合内不变，同一份列表既决定发给模型的 `tools` 参数，也决定 `runTool` 允许执行哪些工具。
5. **单用户、无登录。** 后端只监听 127.0.0.1。
6. **同一会话同时只有一个进行中的回合。** 第二个请求返回 409。
7. **后端单进程运行。** 回合运行器在进程内存里（`turns.py`），不支持多 worker。

## 一个回合的流程

1. 浏览器 `POST /api/sessions/:id/turns {content}`。后端在一个事务里建回合（`running`）并写入用户消息，返回 `turn_id`。
2. 后端起一个线程，`POST agent/turns {session_id, turn_id}`，读取 NDJSON 事件流。
3. agent 调 `GET /internal/turns/:id/context`，拿到模型配置、附加系统提示、工具开关、历史回合和本回合用户消息。
4. agent 组装 messages：系统提示 + `selectHistory()` 选出的历史 + 用户消息，然后进入循环（`turn.js`）：
   - 流式调用模型，边收边发 `reasoning_delta` / `text_delta`；
   - 收完后发 `message`（完整的 assistant 消息），后端落库；
   - 有工具调用就逐个执行，每个结果作为 `message`（tool 消息）发出并落库；然后进入下一步；
   - 没有工具调用即结束，发 `turn_end`。最后一步会带 `tool_choice: none`，强制模型给出回答。
5. 后端收到 `turn_end` 把回合迁到终态（只迁一次），并转发给浏览器。
6. 浏览器 `GET /api/turns/:id/events`（SSE）订阅。订阅时先补发本回合已产生的全部事件，因此刷新页面后可以接着看。

停止：浏览器 `POST /api/turns/:id/stop` → 后端转发 `POST agent/turns/:id/abort` → agent 中止模型请求或工具，把已输出的部分作为一条 assistant 消息落库，以 `stopped` 结束。agent 10 秒内没收尾时后端强制结束。

后端重启时，残留的 `running` 回合会被标记为 `failed`。

## 事件

agent → 后端（NDJSON）与 后端 → 浏览器（SSE `data:`）使用同一套事件，后端只额外加了 `turn_start`。

| type | 字段 | 说明 |
|---|---|---|
| `turn_start` | `turn_id`, `user_message_id` | 后端产生 |
| `turn_info` | `tools`, `history_turns`, `dropped_turns` | 本回合可见工具、实际发送 / 丢弃的历史回合数 |
| `step_start` | `step` | 每次调用模型前 |
| `reasoning_delta` / `text_delta` | `text` | 增量，仅用于显示，不落库 |
| `message` | `message` | 一条完整消息（assistant 或 tool），**后端据此落库** |
| `tool_start` / `tool_end` | `call_id`, `name`, (`arguments` / `ok`) | 工具执行开始 / 结束 |
| `usage` | `usage` | 本步 token 用量，后端累加 |
| `turn_end` | `status`, `error?` | `done` / `stopped` / `failed` |
| 其他 | 任意 | 工具通过 `ctx.emit()` 发出的自定义事件，原样转发给浏览器 |

## 数据

| 表 | 说明 |
|---|---|
| `sessions` | 会话 |
| `turns` | 回合：`status`（running / done / stopped / failed）、`error`、`usage` |
| `messages` | 模型可见的消息：`role`、`content`、`reasoning_content`、`tool_calls`（JSON）、`tool_call_id`、`name` |
| `settings` | 键值：`model`（含 api_key）、`tools`（开关）、`system_prompt` |
| `notes` | 笔记 |

## Skill

skill 是「怎么把一类事做好」的做法，写在 `skills/<名字>/SKILL.md` 里：frontmatter 写 `name`、`description`，正文是步骤。

- **来源**：仓库内置 `skills/`，以及 `<data_dir>/skills/`（用户本地，不入库）。同名时用户的覆盖内置的。
- **按需加载**：系统提示里只留一句「有可用的 skill，需要时查」，不列清单。清单（名字 + 描述）由 `use_skill` 不带参数时向 `GET /internal/skills` 取，正文由 `use_skill(name)` 向 `GET /internal/skills/<name>` 取。用不到的 skill 一个字符都不占上下文；提示本身也不随 skill 数量变化，对前缀缓存友好。代价是发现要靠模型主动调用一次。
- **附带文件**：说明里引用的模板、规范通过 `use_skill({ name, file })` 读，落到 `GET /internal/skills/<name>/files/<路径>`。
- **不越界**：读取时按 realpath 校验，路径必须留在该 skill 目录内；指向目录外的符号链接不算它的内容。
- **发现放在后端**：设置页要列出全部 skill 与问题，而 agent 不保存状态，所以由后端解析文件、校验 frontmatter，有问题的 skill 不下发给模型。
- 系统提示里的 skill 清单排在最后一段（`context.js` 的 `skillsSection`），因为它会随安装变化，靠后能少破坏前缀缓存。

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

**web**

- 新页面：在 `router.js` 加路由，在 `nav.js` 登记入口。
- 渲染自定义事件：`chat/renderers.js` 的 `registerEventRenderer(type, Component)`，组件收到 `event` 属性。
- 接口调用统一放在 `api/client.js`。

## 测试替身

- `agent/test/support/fake-llm.js`：OpenAI 兼容的流式模型服务，按顺序回放预设回复，记录收到的请求；会像真实服务一样拒绝缺少 `reasoning_content` 的请求。
- `backend/tests/conftest.py` 的 `FakeAgent`：按脚本回放 agent 事件。
- `scripts/e2e.mjs`：真实启动后端与 agent，模型换成 fake LLM。
