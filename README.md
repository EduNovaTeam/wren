# Wren

一个跑在自己电脑上的单用户 agent。接任意 OpenAI 兼容的模型接口，支持流式输出、思考过程、多步工具调用、随时停止，所有对话保存在本地 SQLite。

- **backend/**：Flask。会话、回合记录、设置，全部持久化都在这里。
- **agent/**：Node.js。回合循环、工具、模型调用。无第三方依赖。
- **web/**：Vue 3 + Vite。对话界面与设置页。

架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 快速开始

需要 Python 3.11+、Node.js 22+。

```bash
# 1. 后端依赖（在 backend/ 下建虚拟环境）
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS / Linux: source .venv/bin/activate
pip install -e ".[dev]"
cd ..

# 2. 前端依赖
cd web
npm install
cd ..

# 3. 启动（后端 + agent + 前端，Ctrl+C 全部退出）
node scripts/dev.mjs
```

打开 <http://127.0.0.1:5173>，到「设置 → 模型」填写 Base URL、模型名和 API key，点「测试连接」，然后就可以对话了。

- 模型配置保存在 `data/wren.db`（已在 .gitignore 中），不要提交这个文件。
- 端口等运行参数可在根目录 `.env` 里改，参考 `.env.example`。
- `npm run build` 之后，后端也会直接托管前端页面（<http://127.0.0.1:5280>），这时可以用 `node scripts/dev.mjs --no-web`。

## 功能

| 功能 | 说明 |
|---|---|
| 对话 | 流式输出，思考过程可折叠；刷新页面会接上进行中的回合 |
| 停止 | 随时停止，已经输出的内容保留 |
| 工具 | `current_time`、`save_note`、`search_notes`；设置页可逐个开关 |
| Skill | 把「怎么把一类事做好」写成 `SKILL.md`，按需加载；设置页可查看状态、启用停用 |
| 笔记 | 让 agent「记下来」，在笔记页查看和删除 |
| 历史预算 | 只把预算内最近的完整回合发给模型，超出部分整回合丢弃 |

## 测试

```bash
cd backend && pytest          # 后端
cd agent && npm test          # agent（含 fake LLM）
cd web && npm run build       # 前端构建
node scripts/e2e.mjs          # 端到端冒烟：真实进程 + fake LLM，不需要 key
```

## 许可

[MIT](LICENSE)
