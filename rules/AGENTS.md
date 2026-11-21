# Antigravity ↔ Codex 专业同侪协商与对讲室规则

1. **主动协商（Antigravity → Codex 全程可视守则）**：
   - 当用户要求“与 Codex 交流 / 讨论方案 / 辩论权衡”、“让 Codex 交叉审查代码（Code Review）”、“打开 Codex 对讲室”，或希望同屏观看双 AI 多轮技术碰撞时：
     1. **第 1 轮调用前立即给入口**：在发起第 1 轮工具调用前，先在对话框输出可点击胶囊 `[Codex 对讲室](sidecar://codex-bridge/codex_room/)` 与本轮发往 Codex 的核心议题摘要（1-2 句话），让用户第一时间看到讨论启动并可同屏观看逐字流式直播。
     2. **读取并调用标准桥接脚本**：激活 `codex-chat` 技能，通过 `node "$HOME\.gemini\config\plugins\codex-bridge\skills\codex-chat\scripts\talk_codex.mjs"`（按场景选用 `--protocol rfc|review|debug|audit` 与 `--round k/N`）执行真实有状态多轮交流（底层基于 `codex app-server` 自动写入 OpenAI Codex 桌面端侧栏并对讲室实时流式同步），严禁绕过该脚本裸跑 `codex exec` 或自行扮演 Codex。
     3. **禁止静默连跑多轮（逐轮透明播报）**：每完成一轮 `talk_codex.mjs` 调用并准备发起下一轮前，**必须**在主聊天流输出简明的 **「第 k/N 轮交锋纪要」**（Codex 的核心反驳/发现 vs 我方下一轮回应重点），禁止在后台连续静默调用多轮脚本而不输出中间过程。
     4. 若用户未明确指定外部 `Tower.exe` / `Herdr`，日常双 AI 协商与代码互审默认通过本原生对讲室闭环完成。

2. **被动应答（Codex → Antigravity 被调用防递归守则）**：
   - 当你在 CLI 非交互模式下收到带有 `[PEER-EXCHANGE-FROM-CODEX]` 协议头或 `AGY_CODEX_PEER_CALL=1` 的同侪协商请求时：
     - 说明当前是由 OpenAI Codex 主动向你发起的专业技术咨询或代码互审。
     - 请直接核查目标代码与上下文，按协议要求输出独立、客观、带准确 `文件:行号` 依据的分析结论与末尾状态标记（如 `[PEER_STATUS: CONVERGED | NEEDS_ROUND]` 或 `[PEER_VERDICT: PASS | CHANGES_REQUIRED]`），省去寒暄客套。
     - **严禁**在被调用回合内反向执行 `talk_codex.mjs`，确保双向调用零死循环。
