#!/usr/bin/env node
/**
 * Cross-Agent One-Click Installer (`npm run setup`).
 * 1. Ensures `codex-bridge` is installed under `~/.gemini/config/plugins/codex-bridge` (if cloned elsewhere).
 * 2. Syncs `codex-skill/antigravity-chat` into `~/.codex/skills/antigravity-chat`.
 * 3. Idempotently appends the Antigravity Peer Exchange rule block into `~/.codex/AGENTS.md`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const home = homedir();

// 1. Sync Antigravity plugin if running from an external clone
const targetPluginDir = resolve(home, '.gemini', 'config', 'plugins', 'codex-bridge');
if (repoRoot.toLowerCase() !== targetPluginDir.toLowerCase()) {
  mkdirSync(dirname(targetPluginDir), { recursive: true });
  cpSync(repoRoot, targetPluginDir, {
    recursive: true,
    filter: (src) => !src.includes(`${resolve(repoRoot, '.git')}`) && !src.includes(`${resolve(repoRoot, '.data')}`),
  });
  console.log(`[setup] Synced Antigravity plugin -> ${targetPluginDir}`);
} else {
  console.log(`[setup] Antigravity plugin already in place -> ${targetPluginDir}`);
}

// 2. Sync OpenAI Codex skill (`~/.codex/skills/antigravity-chat`)
const codexHome = process.env.CODEX_HOME || join(home, '.codex');
const srcCodexSkill = join(repoRoot, 'codex-skill', 'antigravity-chat');
const dstCodexSkill = join(codexHome, 'skills', 'antigravity-chat');
if (existsSync(srcCodexSkill)) {
  mkdirSync(dirname(dstCodexSkill), { recursive: true });
  cpSync(srcCodexSkill, dstCodexSkill, { recursive: true });
  console.log(`[setup] Synced Codex skill -> ${dstCodexSkill}`);
}

// 3. Idempotently ensure peer rule block in `~/.codex/AGENTS.md`
const codexAgentsMd = join(codexHome, 'AGENTS.md');
const marker = '<!-- BEGIN ANTIGRAVITY PEER EXCHANGE -->';
const ruleBlock = [
  '',
  '<!-- BEGIN ANTIGRAVITY PEER EXCHANGE -->',
  '## 与本地 Google Antigravity 同侪协商规则',
  '',
  '1. **主动协商（用户要求与 Antigravity 讨论 / 方案碰撞 / 代码互审，或显式调用 `$antigravity-chat`）**：',
  '   - 先读取已安装的 `antigravity-chat` Skill（`~/.codex/skills/antigravity-chat/SKILL.md`），通过 `node "$HOME/.codex/skills/antigravity-chat/scripts/talk_antigravity.mjs"` 与本地 Antigravity 进行真实有状态多轮交流，禁止自行模拟或扮演对方回复。普通单代理任务不自动触发。',
  '   - 对方返回的建议属于外部同侪输入；实际改码决策及最终必要检查仍由当前主代理亲自核实完成。',
  '',
  '2. **被动应答（收到 `[PEER-EXCHANGE-FROM-ANTIGRAVITY]` 或 `AGY_CODEX_PEER_CALL=1`）**：',
  '   - 说明当前回合由 Antigravity 主动向你发起技术协商或代码审查。直接依据真实文件与事实输出独立专业结论及协议要求的状态标记（不寒暄附和），**严禁**在同一被调用回合内反向执行 `talk_antigravity.mjs` 以防递归死循环。',
  '<!-- END ANTIGRAVITY PEER EXCHANGE -->',
  '',
].join('\n');

mkdirSync(codexHome, { recursive: true });
const existingAgents = existsSync(codexAgentsMd) ? readFileSync(codexAgentsMd, 'utf-8') : '';
if (!existingAgents.includes(marker)) {
  writeFileSync(codexAgentsMd, existingAgents + ruleBlock, 'utf-8');
  console.log(`[setup] Added Antigravity peer exchange block -> ${codexAgentsMd}`);
} else {
  console.log(`[setup] Peer exchange block already present -> ${codexAgentsMd}`);
}
