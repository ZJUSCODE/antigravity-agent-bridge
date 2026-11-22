# Antigravity ↔ 多智能体（Codex / Pi / Claude Code / Gemini CLI / OpenCode）协同对讲室规则

1. **主动协商与多智能体派工（全程右侧栏实时可视）**：
   - 当用户要求与本地外部智能体（如 **OpenAI Codex**、**Pi Agent**、**Claude Code**、**Gemini CLI**、**OpenCode**，或**多智能体圆桌群聊 Council**）讨论方案、并行交叉代码审查（Code Review）、“你决策让某某 Agent 执行”，或要求打开对讲室面板时：
     1. **第 1 轮调用前立即给入口**：先在对话框输出单个可点击胶囊 `[Codex 对讲室](sidecar://codex-bridge/codex_room/)` 与本轮核心目标摘要（1-2 句话），让用户可同屏实时观看各智能体流式输出。
     2. **按目标选择标准桥接技能**：
        - 调度任意单智能体或多智能体并行圆桌（`--agent codex|pi|claude|gemini|opencode|council` 或 `--agents codex,pi`）：激活 `agent-bridge` 技能，调用 `node "$HOME/.gemini/config/plugins/codex-bridge/skills/agent-bridge/scripts/talk_agent.mjs"`（支持 `--protocol rfc|review|debug|audit|free`、开放式当前轮次 `--round 1` / `--round 2`…、以及落盘执行 `--sandbox workspace-write`）。
        - 单独与 Codex 深度多轮交互也可直接调用 `codex-chat` 技能中的 `talk_codex.mjs`。
        - 严禁自行模拟或扮演其他智能体的回复。
     3. **由 Antigravity 自主动态决策交流轮次（1～N 轮智能收敛）与逐轮播报**：
        - 除非用户明确指定了固定讨论轮数，否则**禁止机械锁死 2 轮或 3 轮**。由你根据议题复杂度、源码核验结果以及对方返回的收敛信号（`[PEER_STATUS: CONVERGED | NEEDS_ROUND]` 或 `[PEER_VERDICT: PASS | CHANGES_REQUIRED]`）自主决定往返 1～N 轮：首轮已完全达成共识且无隐患时 1 轮即止；只要存在未闭合的技术分歧或必改缺陷，则自主继续发起第 2、3、4…N 轮深挖或打回重修直至真正闭环（若连续拉锯超过 6 轮仍存在路线分歧，则整理双方核心依据交由用户拍板）。
        - 每完成一轮并准备发起下一轮前，**必须**在主聊天流输出简明的 **「第 k 轮交锋纪要与继续追问原因」**，禁止静默连跑多轮。

2. **被动应答（外部智能体 → Antigravity 被调用防递归守则）**：
   - 当你在 CLI 非交互模式下收到带有 `[PEER-EXCHANGE-FROM-...]` 协议头或 `AGY_CODEX_PEER_CALL=1` 的同侪请求时，请直接核查代码并输出客观结论与协议末尾状态标记，**严禁**反向调用 `talk_agent.mjs` 或 `talk_codex.mjs`，确保双向零死循环。
