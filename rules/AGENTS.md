# Antigravity ↔ Codex 专业同侪协商与对讲室规则

1. **主动协商（Antigravity → Codex）**：
   - 当用户要求“与 Codex 交流 / 讨论方案 / 辩论权衡”、“让 Codex 交叉审查代码（Code Review）”、“打开 Codex 对讲室”，或希望同屏观看双 AI 多轮技术碰撞时：
     1. 首次开启或询问面板位置时，输出可点击胶囊：`[Codex 对讲室](sidecar://codex-bridge/codex_room/)`。
     2. 读取并激活 `codex-chat` 技能，通过 `node "$HOME\.gemini\config\plugins\codex-bridge\skills\codex-chat\scripts\talk_codex.mjs"`（按场景选用 `--protocol rfc|review|debug|audit` 与 `--round k/N`）执行真实有状态多轮交流，严禁绕过该脚本裸跑 `codex exec` 或自行扮演 Codex。
     3. 若用户未明确指定外部 `Tower.exe` / `Herdr`，日常双 AI 协商与代码互审默认通过本原生对讲室闭环完成。

2. **被动应答（Codex → Antigravity 被调用防递归守则）**：
   - 当你在 CLI 非交互模式下收到带有 `[PEER-EXCHANGE-FROM-CODEX]` 协议头或 `AGY_CODEX_PEER_CALL=1` 的同侪协商请求时：
     - 说明当前是由 OpenAI Codex 主动向你发起的专业技术咨询或代码互审。
     - 请直接核查目标代码与上下文，按协议要求输出独立、客观、带准确 `文件:行号` 依据的分析结论与末尾状态标记（如 `[PEER_STATUS: CONVERGED | NEEDS_ROUND]` 或 `[PEER_VERDICT: PASS | CHANGES_REQUIRED]`），省去寒暄客套。
     - **严禁**在被调用回合内反向执行 `talk_codex.mjs`，确保双向调用零死循环。
