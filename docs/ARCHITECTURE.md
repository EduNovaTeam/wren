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
4. **工具可见列表在回合开始时确定。** `ToolRegistry.visibleTools()` 按设置页的开关算出本回合的工具，再加上生效中 skill 的 `allowed-tools` 声明的工具；整个回合内不变，同一份列表既决定发给模型的 `tools` 参数，也决定 `runTool` 允许执行哪些工具。回合中间才读到的 skill，它带的工具要到下一回合才出现。
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
- **不越界**：skill 是外部内容，只能读它自己目录里的东西。读取时按 realpath 校验，路径必须留在该 skill 目录内；链接一律不跟——符号链接和 Windows 的目录联接都算，靠比较 `lstat` 与 `stat` 的 inode 判断（比 `resolve()` 的字符串可靠：Windows 上 `resolve()` 返回磁盘上的真实大小写，`skill.md` 会被误判）。目录本身是链接的 skill 记成「有问题」并在设置页显示目标路径，不加载；`SKILL.md` 是链接同样不读。`list_files` 是逐层遍历而不是 `rglob`：一个指回自己的目录联接会让 `rglob` 原地打转，把同一个文件名刷出几十遍发给模型。
- **发现放在后端**：设置页要列出全部 skill 与问题，而 agent 不保存状态，所以由后端解析文件、校验 frontmatter，有问题的 skill 不下发给模型。
- **启用与停用**：设置页可以逐个开关，开关存在 settings 表的 `skills` 键里（`{名字: true/false}`），没配过的按启用处理，所以新增 skill 不用写配置。停用是全局且立刻生效的：`/internal/skills` 不再列出它，`GET /internal/skills/<name>` 直接 404，`/名字` 会在创建回合前被 400 挡下。停用**不**删除 `session_skills` 里的记录——它只是暂时不参与，重新启用后之前用过的 skill 立刻恢复，用户不必再点名一次。有问题的 skill 不允许启用（本来也不会交给模型，启用它没有意义），设置页把 checkbox 置灰并列出 `problems` 与目录路径，好让人直接去改那个文件。
- **主动指定**：消息以 `/skill-name` 开头时，后端在创建回合前解析并校验（不存在或有问题的直接 400，不留下半截回合），回合上下文带上该 skill 的正文（`active_skills`），系统提示里直接出现，模型本回合不必再查一次。用户原样输入的内容照旧落库，前端不用改写显示。命令后必须跟空白或行尾，所以 `/usr/bin/env …` 不会被误判成调用 `usr`。
- **跨回合生效**：skill 用过一次就一直在。用户 `/skill-name` 点名的、以及模型用 `use_skill(name)` 读到正文的，都会记进 `session_skills`（`003_session_skills.sql`），之后每个回合的上下文都把正文带上，来源标为 `session`。注入时明说「对之后每条消息都生效、不必再写命令」——只写「继续按它说的做」时，模型会退回按正文里的适用条件判断，于是没有命令前缀的下一句被当成普通聊天，看起来像没生效。skill 后来被删掉或改坏时跳过，不让回合失败。
- **退出生效**：对话界面在输入框上方列出本会话生效中的 skill（`GET /api/sessions/<id>/skills`），点 × 调 `DELETE /api/sessions/<id>/skills/<name>` 就退出，立刻生效，下一个回合不再注入，它带的工具也随之消失。退出**不是删记录**，而是给 `session_skills.suppressed_at` 打标记（`004_session_skill_suppressed.sql`）：用户点过退出之后，模型即使又用 `use_skill` 读了同一个 skill，也不该把它悄悄拉回生效状态——那会让按钮看起来是坏的。只有用户 `/skill-name` 明确点名才清掉标记重新生效。
  只停注入还不够，退出必须挡住三条路：内部接口带上 `?session=` 后，清单里不出现它、正文和附带文件都 404；回合上下文的 `skills` 也不列它。否则模型自己翻一遍清单、读一遍正文，这个回合又照着做了，用户点的退出等于没点。
  还有一条是历史：它之前被调用成功过，模型会照着自己旧的做法继续调它带的工具（实测会直接发 `fetch_url`，然后拿到「工具不存在」的错误再硬答）。所以回合上下文带上 `left_skills`，agent 在历史之后、用户消息之前补一句「用户退出了 skill：X，它们带来的工具本回合不可用」。和工具开放那句提醒同一个位置、同一个道理：写在系统提示开头没用。
- **自带工具**：skill 用 frontmatter 的 `allowed-tools` 声明它需要的工具（空格或逗号分隔，如 `fetch_url`）。这些工具只在它生效时才对模型开放，没生效时模型连工具定义都看不到；反过来 `default` 类工具的开关始终归用户管，skill 不能替用户打开被关掉的工具。声明了没注册的工具名直接忽略，不能让回合失败。
  回合中间用 `use_skill` 读到的 skill，工具要到下一回合才出现（回合内工具集不变）。这件事只能在**每回合重新生成的系统提示**里说「本回合已经开放：…」，绝不能写进 `use_skill` 的工具结果：工具结果会永久留在历史里，模型之后每轮都读到那句「下一回合才能用」，于是明明工具已经开放也坚持说没有，还反过来解释为什么用不了。
  还有一层：同一会话里工具的可用性必然变过（先没有，skill 生效后才有），模型会把自己更早那句「我没有这个工具」当成事实，连工具定义和系统提示都推翻。实测把它那两句否认从历史里删掉，它立刻就能正常调用。所以每回合在历史之后、用户消息之前补一条只对本回合有效的系统提醒，说明旧结论作废；**写在系统提示开头没有用**，必须排在历史后面才管用。
- **多个 skill 同时生效**：一个回合只让其中一个「主导」带上正文，其余「待命」只给名字和一句话描述。全量注入正文时，几套规范同时在场，模型会把它们混着用（周报模板套进会议纪要）；而且系统提示随 skill 数量线性变长。待命的正文按需 `use_skill` 读，和整个系统「用不到就不占上下文」一致。**工具仍然全部开放**，哪怕它待命——否则模型读到正文后还得等下一回合才有工具，那是另一个已知的坑。
- **谁主导**：两种来源，不能混为一谈。
  - **用户指定**（点界面上的 chip，`POST /api/sessions/<id>/skills/<name>/primary` → `session_skills.pinned_at`，`006_session_skill_pinned.sql`）是硬指定：模型之后读别的 skill 也不会把它换掉，提示里写「这是用户自己指定的主导，别自己换」。解除有三条路：`/名字` 点别的 skill、点另一个 chip、或者再点一次同一个 chip（`DELETE …/<name>/primary`，回到「自动」）。
  - **自动**：没有指定时按最近使用排（`last_used_at`，模型每 `use_skill` 读一次就刷新）。
  
  一开始只有「自动」这一种，结果用户点了主导、模型下一回合读了别的 skill，最近使用被刷新，主导就无声地跑到了另一个 skill 上——用户点的选择失效。最近使用能说明「刚才在干什么」，说不清「用户要哪个」，所以分成两列。
- **给模型的判断顺序**：指定过主导时，只写三条——能套用就用它、不要自己换（觉得别的更合适先问）、和它完全无关时照常回答别硬套；没有指定时写四条——只有一个相关就用它、多个相关用主导且别混格式、分不清先问、都不相关就都不套用。只写「每个 skill 都对之后每条消息生效」时，模型的理解就是「全都用上」。
- 系统提示里与 skill 有关的两段都排在最后（`context.js` 的 `skillsSection` 与 `activeSkillsSection`）：前者是固定文案，后者随每条消息变化，靠后能少破坏前缀缓存。

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
  - `exposure: 'on-demand'`：默认不可见，也不出现在设置页（例如 `fetch_url`），只有生效中的 skill 通过 `allowed-tools` 声明它时才对模型开放。
- 系统提示：由 `context.js` 的 `PromptSection` 按顺序拼接（`DEFAULT_SECTIONS`）。越靠前越应该稳定，模型服务按前缀命中缓存。

**web**

- 新页面：在 `router.js` 加路由，在 `nav.js` 登记入口。
- 渲染自定义事件：`chat/renderers.js` 的 `registerEventRenderer(type, Component)`，组件收到 `event` 属性。
- 接口调用统一放在 `api/client.js`。

## 测试替身

- `agent/test/support/fake-llm.js`：OpenAI 兼容的流式模型服务，按顺序回放预设回复，记录收到的请求；会像真实服务一样拒绝缺少 `reasoning_content` 的请求。
- `backend/tests/conftest.py` 的 `FakeAgent`：按脚本回放 agent 事件。
- `scripts/e2e.mjs`：真实启动后端与 agent，模型换成 fake LLM。
