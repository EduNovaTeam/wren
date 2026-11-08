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
| 笔记 | 让 agent「记下来」，在笔记页查看和删除 |
| 历史预算 | 只把预算内最近的完整回合发给模型，超出部分整回合丢弃 |
| 技能 | 自动按需加载，也支持 `/技能名`；已启用技能在当前会话的后续回合继续生效 |

## 使用技能

到「设置 → 技能」查看内置与本地技能、格式诊断和启停状态。可以直接说「帮我写周报」，
由模型按简介选择技能；也可以输入 `/weekly-report 本周完成了……` 明确指定。
输入框上方会显示当前会话已激活的技能，回合结束后可以移除。

本地技能默认放在 `data/skills/<技能名>/SKILL.md`，格式遵循
[Agent Skills 规范](https://agentskills.io/specification)。可用 `WREN_SKILLS_DIR` 指向其他目录。
同名时本地版本覆盖内置版本；本地版本有问题时会显示原因，不会静默回退。
新建或修改文件后可刷新设置页，后续回合重新读取。

模型初始只看到技能简介，加载后才得到正文；模板和参考资料通过 `read_skill_resource` 按需读取。
技能声明的按需工具从下一次模型请求开始开放，全局关闭和未注册的工具不会因此开放。
例如 `metrics-query` 声明的 `run_sql` 尚未实现，会提示缺失。
关闭技能会清除所有会话里的激活记录，重新开启后需要再次选用。
本期支持读取文本资料，不执行技能脚本，不提供在线安装。

## 测试

```bash
cd backend && pytest          # 后端
cd agent && npm test          # agent（含 fake LLM）
cd web && npm run build       # 前端构建
node scripts/e2e.mjs          # 端到端冒烟：真实进程 + fake LLM，不需要 key
```

## 许可

[MIT](LICENSE)
