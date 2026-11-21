---
name: codex-chat
description: 与本地 OpenAI Codex 进行专业多轮工程协商、架构方案碰撞（RFC）、主从派工执行、对抗式交叉代码审查（Code Review）与疑难排障，并将全过程实时同步至右侧辅助栏「Codex 对讲室」。当用户要求与 Codex 讨论、让 Codex 执行改码、互审代码、双 AI 辩论或打开对讲室时激活此技能。
---

# Antigravity ↔ Codex 专业同侪协商与协同执行技能

本技能提供 Antigravity 与本地 OpenAI Codex 的有状态双向工程协作通道（兼容 Windows / macOS / Linux），所有对话、思考摘要、命令轨迹与代码 Diff 均实时同步至右侧辅助栏面板及双端客户端对应项目文件夹。详细四模式协议与缺陷分级准则按需查阅 [peer_protocols.md](./references/peer_protocols.md)。

## 1. 核心工作流（全程双端实时可视）

1. **发起前先亮入口与议题**：在第 1 轮调用前，立即在聊天流输出单个可点击胶囊 `[Codex 对讲室](sidecar://codex-bridge/codex_room/)` 及本轮拟与 Codex 碰撞或派发的核心目标。右侧对讲室会自动对齐当前会话窗口并实时流式渲染思考链与逐字回复，同时线程自动出现在 OpenAI Codex 桌面端对应项目文件夹（`[双AI] ...`）。
2. **按场景选择协作协议（`--protocol`）与沙盒权限（`--sandbox`）**：
   - `rfc`：架构设计与技术选型碰撞（默认 `--sandbox read-only`，聚焦隐含假设、权衡与接口定稿）。
   - `review`：对抗式交叉代码审查（配合 `--diff-git` 自动附带 Git 变更，按 `P0-P3` 分级并精确到 `文件:行号`）。
   - `debug`：疑难故障双盲根因假设与最小证伪实验设计。
   - `audit`：实现完成后的洁净室独立验收核查。
   - `free` + `--sandbox workspace-write`：**主从决策→执行模式**（Antigravity 拍板架构与验收标准后，指令 Codex 在工作区内直接落盘编码、运行单测并返回结果，再由 Antigravity 做独立 Diff 验收）。
3. **执行有状态多轮闭环与逐轮透明播报（默认 2 轮，上限 4 轮）**：
   - 调用 [talk_codex.mjs](./scripts/talk_codex.mjs) 发送立论或任务书（长文本、多行代码或含引号内容优先写入临时 UTF-8 文件后通过 `--prompt-file` 传入，跨平台零转义损坏）。
   - 审读返回的 Codex 意见与末尾状态标记（`[PEER_STATUS: CONVERGED | NEEDS_ROUND]` 或 `[PEER_VERDICT: PASS | CHANGES_REQUIRED]`）。
   - **逐轮播报铁律**：若需进入下一轮（`Round 2/N` 等），在调用下一轮脚本前，**必须**先在当前主对话框输出 3-5 行 **「🔄 第 k/N 轮交锋进展」**（概括 Codex 提出的核心异议/缺陷及我方验证或回应方向），**严禁**不发一言连续静默跑完所有轮次。

## 2. 跨平台标准调用示例（Bash / Zsh / PowerShell 通用正斜杠路径）

```bash
# 1) 架构碰撞第 1/2 轮（默认只读）：
node "$HOME/.gemini/config/plugins/codex-bridge/skills/codex-chat/scripts/talk_codex.mjs" \
  --conv "<当前Conversation_ID>" \
  --cwd "<项目根目录>" \
  --protocol rfc \
  --round 1/2 \
  --effort medium \
  --prompt-file "<UTF-8议题文件路径>"

# 2) 代码修改后附带实时 Git Diff 或关键源码发起对抗式互审：
node "$HOME/.gemini/config/plugins/codex-bridge/skills/codex-chat/scripts/talk_codex.mjs" \
  --conv "<当前Conversation_ID>" \
  --cwd "<项目根目录>" \
  --protocol review \
  --round 1/2 \
  --diff-git \
  --file "<关键源码路径>" \
  --prompt "请重点审查本次并发锁与异常回退分支是否存在竞态或句柄泄漏。"

# 3) Antigravity 决策 -> Codex 落盘执行并跑单测：
node "$HOME/.gemini/config/plugins/codex-bridge/skills/codex-chat/scripts/talk_codex.mjs" \
  --conv "<当前Conversation_ID>" \
  --cwd "<项目根目录>" \
  --sandbox workspace-write \
  --effort high \
  --prompt-file "<UTF-8执行任务书路径>"
```
*(注：在 Windows PowerShell 中单行执行或将行尾 `\` 换为反引号 `` ` `` 即可直接运行。)*

## 3. 参数速查与红线守则

| 参数 | 说明 |
| :--- | :--- |
| `--conv <id>` / `--room <id>` | 当前 Antigravity 会话 ID（自动绑定对应对讲室窗口）或显式指定房间 ID |
| `--protocol <mode>` | `rfc` \| `review` \| `debug` \| `audit` \| `free` |
| `--round <k/N>` | 轮次进度标记（如 `1/2`、`2/2`），同步展示在对讲室气泡标题与协议头中 |
| `--diff-git` | 自动采集 `--cwd` 下的 `git status --short` 与 `git diff HEAD` 供对方审查 |
| `--file <path>` | 附加带行号源码快照进后台协议载荷（可重复传入；审查工作区外文件时必传） |
| `--prompt <text>` / `--prompt-file <p>` / `--stdin` | 消息输入（长文本推荐 `--prompt-file`） |
| `--image <path>` | 附加本地截图或架构图（可重复传入） |
| `--model <slug>` / `--effort <lvl>` | 覆盖模型（省略时自动跟随用户本地 Codex 默认模型）或推理强度（`low` → `ultra`） |
| `--sandbox <mode>` | `read-only`（省略时默认）或 `workspace-write`（授权落盘修改与执行测试） |
| `--new-thread` / `--reset` | 开启全新 Codex 上下文线程 / 仅重置当前房间线程绑定 |

**执行红线**：
- **严禁角色扮演**：要求与 Codex 交流时必须真实调用 `talk_codex.mjs`，绝不自行模拟对方观点。
- **防递归铁律**：若当前回合处于被 Codex 发起的同侪调用中（环境变量 `AGY_CODEX_PEER_CALL=1` 或输入含 `[PEER-EXCHANGE-FROM-CODEX]`），必须直接基于事实输出专业答复，**严禁**反向调用 `talk_codex.mjs`。
