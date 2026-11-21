---
name: antigravity-chat
description: 当用户明确要求与本地 Google Antigravity 讨论技术方案、碰撞架构权衡、开展对抗式交叉代码审查（Code Review）或进行双 AI 多轮协商时使用。普通单代理问答或常规开发不自动触发。
metadata:
  short-description: 与本地 Antigravity 开展多轮工程协商与交叉代码审查
---

# Codex ↔ Antigravity 专业同侪协商与互审技能

通过本地 CLI 桥接脚本 [talk_antigravity.mjs](./scripts/talk_antigravity.mjs) 与本机 Google Antigravity（`agy`）建立有状态多轮对话，并将全过程同步写入共享对讲室（`.codex_room`），供用户在双端随时查看。四模式详细规程按需阅读 [peer_protocols.md](./references/peer_protocols.md)。

## 1. 协作流程

1. **选定协议（`--protocol`）**：
   - `rfc`：架构选型、数据流与接口契约碰撞。
   - `review`：对抗式代码互审（加 `--diff-git` 自动附带工作区 Git 变更，按 `P0-P3` 分级并定位 `文件:行号`）。
   - `debug`：疑难故障双盲根因假设与最小证伪实验对比。
   - `audit`：对照原始需求与真实 Diff 做洁净室独立核对。
   - `free`：自由技术交流。
2. **有状态多轮往返与逐轮透明播报（默认 2 轮，上限 4 轮）**：
   - 第 1 轮前：先在对话流用 1-2 句话告知用户即将向 Antigravity 发起的讨论焦点。将包含关键代码路径与判断依据的文本写入临时 UTF-8 文件（避免 Windows 引号与换行转义破坏），运行 `talk_antigravity.mjs` 发起协商。相同 `--cwd`（或显式 `--room`）会自动复用同一个 `agyConversationId` 保持多轮上下文，并实时触发 Antigravity 右侧「Codex 对讲室」自动切入直播。
   - 轮次间透明播报（必做）：每轮返回后，若需发起下一轮（`--round 2/N` 等），**必须**先在当前 Codex 聊天流输出简短的 **「第 k/N 轮交锋纪要」**（Antigravity 的核心观点/反例 + 我方下一轮回应重点），严禁在后台连续静默调用多轮脚本而不展示中间讨论过程。
   - 收尾：作为当前主代理亲自完成必要的本地验证后，向用户给出精炼结论、双 AI 关键碰撞收获及待用户拍板的分歧（若有）。

## 2. 调用方式（Windows PowerShell 7 / Node）

```powershell
# 第 1/2 轮架构碰撞（长文本推荐走 --prompt-file）：
node "$HOME\.codex\skills\antigravity-chat\scripts\talk_antigravity.mjs" `
  --cwd "E:\Antigravity\Projects\demo" `
  --protocol rfc `
  --round 1/2 `
  --effort medium `
  --prompt-file "E:\Antigravity\scratch\peer_topic.md"

# 携带当前 Git 变更或关键源码快照请 Antigravity 交叉审查代码：
node "$HOME\.codex\skills\antigravity-chat\scripts\talk_antigravity.mjs" `
  --cwd "E:\Antigravity\Projects\demo" `
  --protocol review `
  --round 1/2 `
  --diff-git `
  --file "E:\Antigravity\Projects\demo\src\core.ts" `
  --prompt "请独立审查当前未提交改动是否存在并发竞态、异常吞没或边界遗漏。"
```

常用可选参数：`--file <path>`（可重复传入，在后台协议载荷中附带带行号源码快照而保持对讲室气泡清爽）、`--room <id>`（指定共享房间 ID）、`--new-thread`（开启全新话题上下文）、`--reset`（重置当前房间绑定的 Antigravity 会话）、`--effort low|medium|high|xhigh|max`、`--model <slug>`。

## 3. 执行边界与防死循环铁律

- **真实调用，禁止扮演**：用户要求与 Antigravity 交流时，必须真实执行 `talk_antigravity.mjs`，不得自行模拟对方回复。
- **硬件级防递归铁律**：当环境变量 `AGY_CODEX_PEER_CALL=1` 或输入包含 `[PEER-EXCHANGE-FROM-ANTIGRAVITY]` 时，说明当前回合是由 Antigravity 主动调用你；此时必须直接基于代码和事实输出独立专业结论与末尾状态标记，**严禁**反向调用 `talk_antigravity.mjs`。
- **主代理责任边界**：Antigravity 的回复属于外部同侪评审意见，不能替代当前主代理的独立判断与必要的本地检查；未获授权时保持只读，不因协商流程自动扩大文件修改范围。
