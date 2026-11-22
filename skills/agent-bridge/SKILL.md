---
name: agent-bridge
description: Orchestrate and collaborate with multiple local coding agents — OpenAI Codex, Pi Agent, Claude Code, Gemini CLI, OpenCode, or parallel Multi-Agent Council — streaming live into Antigravity's native Aux-Pane Roundtable. Activate when the user asks to discuss architecture, dispatch coding/testing tasks, or run cross-agent code reviews with Codex, Pi, Claude Code, Gemini CLI, or multiple agents together.
---

# Universal Multi-Agent Roundtable & Orchestration Skill (`agent-bridge`)

Drive stateful multi-round engineering debates (`rfc`), parallel multi-agent code reviews (`review`), root-cause debugging (`debug`), or Architect → Executor task dispatch (`--sandbox workspace-write`) across **OpenAI Codex**, **Pi Agent**, **Anthropic Claude Code**, **Google Gemini CLI**, **OpenCode**, or custom CLI agents — all streaming live into the right-hand `[AI 协同对讲室](sidecar://codex-bridge/codex_room/)`.

## 1. Supported Target Agents (`--agent` / `--agents`)

- `codex` — OpenAI Codex (`codex app-server` JSON-RPC v2)
- `pi` — Pi Coding Agent (`pi --mode json -p --session-id`)
- `claude` — Anthropic Claude Code (`claude -p --output-format stream-json`)
- `gemini` — Google Gemini CLI (`gemini -p --output-format stream-json`)
- `opencode` — OpenCode CLI (`opencode run --format json`)
- `council` (or `--agents codex,pi,claude`) — **Parallel Multi-Agent Roundtable** (dispatches simultaneously to all specified or installed agents and aggregates independent responses in the same room!)

Run `--list-agents` anytime to inspect which agents are installed on the current machine:
```bash
node "$HOME/.gemini/config/plugins/codex-bridge/skills/agent-bridge/scripts/talk_agent.mjs" --list-agents
```

## 2. Standard Workflows

1. **Surface the Sidecar Pill First**: Before Round 1, emit `[Codex 对讲室](sidecar://codex-bridge/codex_room/)` once with a 1-sentence summary of the topic or task being dispatched.
2. **Single-Agent Stateful Collaboration or Task Dispatch**:
   ```bash
   # Dispatch implementation & unit tests to Pi or Claude Code or Codex:
   node "$HOME/.gemini/config/plugins/codex-bridge/skills/agent-bridge/scripts/talk_agent.mjs" \
     --agent pi \
     --conv "<Conversation_ID>" \
     --cwd "/path/to/project" \
     --sandbox workspace-write \
     --effort high \
     --prompt-file "/path/to/task_spec.md"
   ```
3. **Parallel Multi-Agent Council Review (Fan-Out)**:
   ```bash
   # Ask both Codex and Pi (or Claude) to independently review uncommitted Git changes in parallel:
   node "$HOME/.gemini/config/plugins/codex-bridge/skills/agent-bridge/scripts/talk_agent.mjs" \
     --agents codex,pi \
     --conv "<Conversation_ID>" \
     --cwd "/path/to/project" \
     --protocol review \
     --diff-git \
     --prompt "Independently audit the current git diff for race conditions, security edge cases, and regressions."
   ```
4. **Autonomous Convergence-Driven Rounds (`1..N`) & Transparent Updates**:
   - Unless the user explicitly requests a fixed round count, **Antigravity autonomously decides how many rounds (`1..N`) to run** based on task complexity, code verification, and peer status markers (`[PEER_STATUS: CONVERGED | NEEDS_ROUND]` or `[PEER_VERDICT: PASS | CHANGES_REQUIRED]`).
   - Pass open-ended round numbers (`--round 1`, `--round 2`, `--round 3`, `--round 4`…). Stop immediately after Round 1 if fully converged with zero issues; continue iterating as many rounds as needed until genuine consensus or clean verification (`PASS`) is achieved (escalate to the user if fundamental architectural trade-offs remain deadlocked past 6 rounds).
   - Between rounds, post a concise **"Round k Progress & Next-Step Rationale"** summary in the main chat before launching Round `k+1`.

## 3. Guardrails

- **Never simulate peer agents**: Always execute `talk_agent.mjs` (or `talk_codex.mjs`) for real output.
- **Anti-recursion lock**: If `AGY_CODEX_PEER_CALL=1` is set in the environment, respond directly and NEVER invoke `talk_agent.mjs` or `talk_codex.mjs`.
