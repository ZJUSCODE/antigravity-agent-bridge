---
name: codex-chat
description: 与本地 OpenAI Codex 进行专业多轮工程协商、架构方案碰撞（RFC）、对抗式交叉代码审查（Code Review）与疑难排障，并将全过程实时同步至右侧辅助栏「Codex 对讲室」。当用户要求与 Codex 讨论、互审代码、双 AI 辩论或打开对讲室时激活此技能。
---

# Antigravity ↔ Codex 专业同侪协商与互审技能

本技能提供 Antigravity 与本地 OpenAI Codex 的有状态双向工程协作通道，所有对话、思考摘要与工具轨迹均实时同步至右侧辅助栏面板。详细四模式协议与缺陷分级准则按需查阅 [peer_protocols.md](./references/peer_protocols.md)。

## 1. 核心工作流

1. **首次开启面板胶囊**：在对话首次发起协商或用户询问面板时，输出单个可点击胶囊：`[Codex 对讲室](sidecar://codex-bridge/codex_room/)`。
2. **按场景选择协作协议（`--protocol`）**：
   - `rfc`：架构设计与技术选型碰撞（默认只读，聚焦隐含假设、权衡与接口定稿）。
   - `review`：对抗式交叉代码审查（配合 `--diff-git` 自动附带 Git 变更，按 `P0-P3` 分级并精确到 `文件:行号`）。
   - `debug`：疑难故障双盲根因假设与最小证伪实验设计。
   - `audit`：实现完成后的洁净室独立验收核查。
   - `free`：自由技术对聊。
3. **执行有状态多轮闭环（默认 2 轮，上限 4 轮）**：
   - 调用 [talk_codex.mjs](./scripts/talk_codex.mjs) 发送第 1 轮立论或待审上下文（长文本、多行代码或引号内容优先写入临时 UTF-8 文件后用 `--prompt-file` 传入，彻底规避 PowerShell 转义问题）。
   - 审读终端返回的 Codex 意见与末尾状态标记（`[PEER_STATUS: CONVERGED | NEEDS_ROUND]` 或 `[PEER_VERDICT: PASS | CHANGES_REQUIRED]`）。
   - 若存在待收敛分歧或 `P0/P1` 必改缺陷：先独立核实或修复代码，再保持相同 `--conv`（或 `--room`）发起第 2 轮复核，直至达成 `CONVERGED` / `PASS`，最后向用户输出精炼共识结论。

## 2. 标准调用示例（PowerShell）

```powershell
# 架构碰撞第 1/2 轮：
node "$HOME\.gemini\config\plugins\codex-bridge\skills\codex-chat\scripts\talk_codex.mjs" `
  --conv "<当前Conversation_ID>" `
  --cwd "<项目根目录>" `
  --protocol rfc `
  --round 1/2 `
  --effort medium `
  --prompt-file "<UTF-8议题文件路径>"

# 代码修改后附带实时 Git Diff 或指定源码文件发起对抗式互审：
node "$HOME\.gemini\config\plugins\codex-bridge\skills\codex-chat\scripts\talk_codex.mjs" `
  --conv "<当前Conversation_ID>" `
  --cwd "<项目根目录>" `
  --protocol review `
  --round 1/2 `
  --diff-git `
  --file "<关键源码路径1>" `
  --prompt "请重点审查本次并发锁与异常回退分支是否存在竞态或句柄泄漏。"
```

## 3. 参数速查与红线守则

| 参数 | 说明 |
| :--- | :--- |
| `--conv <id>` / `--room <id>` | 当前 Antigravity 会话 ID（自动对齐右侧栏激活房间）或显式指定房间 ID |
| `--protocol <mode>` | `rfc` \| `review` \| `debug` \| `audit` \| `free` |
| `--round <k/N>` | 轮次进度标记（如 `1/2`、`2/2`），同步展示在对讲室气泡标题与协议头中 |
| `--diff-git` | 自动采集 `--cwd` 下的 `git status --short` 与 `git diff HEAD` 供对方审查 |
| `--file <path>` | 附加带行号源码快照进后台协议载荷（可重复传入；审查 `.gemini`/`.codex` 等沙盒受限目录时必传） |
| `--prompt <text>` / `--prompt-file <p>` / `--stdin` | 消息输入（长文本推荐 `--prompt-file`） |
| `--image <path>` | 附加本地截图或架构图（可重复传入） |
| `--model <slug>` / `--effort <lvl>` | 覆盖模型或推理强度（`low` \| `medium` \| `high` \| `xhigh` \| `max` \| `ultra`） |
| `--sandbox <mode>` | `read-only`（省略时默认）或 `workspace-write` |
| `--new-thread` / `--reset` | 开启全新 Codex 上下文线程 / 仅重置当前房间线程绑定 |

**执行红线**：
- **严禁角色扮演**：要求与 Codex 交流时必须真实调用 `talk_codex.mjs`，绝不自行模拟对方观点。
- **防递归铁律**：若当前回合处于被 Codex 发起的同侪调用中（环境变量 `AGY_CODEX_PEER_CALL=1` 或输入含 `[PEER-EXCHANGE-FROM-CODEX]`），必须直接基于事实输出专业答复，**严禁**反向调用 `talk_codex.mjs`。
