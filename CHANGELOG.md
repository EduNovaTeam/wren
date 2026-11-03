# 更新记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

### 新增

- skill：agent 可以通过 `use_skill` 使用 `skills/` 下的做法说明。系统提示只说明「有可用 skill」，清单与正文都在需要时获取，用不到的 skill 不占上下文。
- `use_skill` 可以读取 skill 目录内的附带文件（如 `references/style.md`、`assets/template.md`）；路径越出该 skill 目录会被拒绝。
- 对话里可以用 `/skill-name` 指定本次使用某个 skill，正文直接进入系统提示；名字不存在或 skill 有问题时，发送前就会报错。
- skill 用过一次后在后续对话里继续生效：`/skill-name` 点过，或 agent 读过它的正文，都会记为会话级生效。目前没有取消的入口，删掉会话即清空。
- skill 可以用 `allowed-tools` 带上自己需要的工具（如 `fetch_url`），这些工具只在它生效时对模型开放；没生效时模型连工具定义都看不到。
- `GET /api/skills` 返回全部 skill 及其校验结果；有问题的 skill 只在设置侧展示，不下发给模型。
- skill 支持两个来源：仓库内置 `skills/` 与本地 `data/skills/`，同名时以本地为准。

## [0.1.0] - 2026-11-01

### 新增

- 对话：流式输出、思考过程、多步工具调用、停止；刷新页面接上进行中的回合。
- 回合记录完整落库，历史按预算整回合截断。
- 设置页：模型连接（任意 OpenAI 兼容接口）、思考模式与强度、工具开关、附加系统提示。
- 工具：`current_time`、`save_note`、`search_notes`；`fetch_url` 已注册但默认不开放。
- 笔记页。
- `scripts/dev.mjs` 一键启动；`scripts/e2e.mjs` 端到端冒烟；GitHub Actions CI。
