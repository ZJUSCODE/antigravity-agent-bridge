#!/usr/bin/env node
/**
 * Cross-Platform Universal Multi-Agent Installer (`npm run setup`).
 * Compatible with Windows, macOS, and Linux (WSL included).
 *
 * 1. Syncs plugin into `~/.gemini/config/plugins/codex-bridge` (if cloned elsewhere).
 * 2. Syncs reverse `antigravity-chat` skill into OpenAI Codex (`~/.codex/skills/`),
 *    and automatically into Pi (`~/.pi/agent/skills/`) & Claude Code (`~/.claude/skills/`) if installed.
 * 3. Idempotently installs/updates the Antigravity Peer Exchange rule block in `~/.codex/AGENTS.md`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const home = homedir();
const dryRun = process.argv.includes('--dry-run');

const SKIP_DIRS = new Set(['.git', '.data', '.github', 'node_modules', 'coverage']);

function samePath(a, b) {
  return process.platform === 'linux' ? resolve(a) === resolve(b) : resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

// 1. Sync Antigravity plugin if running from an external clone
const targetPluginDir = process.env.AGY_PLUGIN_TARGET_DIR
  || resolve(home, '.gemini', 'config', 'plugins', 'codex-bridge');

if (!samePath(repoRoot, targetPluginDir)) {
  if (!dryRun) {
    mkdirSync(dirname(targetPluginDir), { recursive: true });
    cpSync(repoRoot, targetPluginDir, {
      recursive: true,
      filter: (src) => !SKIP_DIRS.has(basename(src)),
    });
  }
  console.log(`[setup] Synced Antigravity plugin -> ${targetPluginDir}${dryRun ? ' (dry-run)' : ''}`);
} else {
  console.log(`[setup] Antigravity plugin already in place -> ${targetPluginDir}`);
}

// 2. Sync reverse `antigravity-chat` skill into Codex (always) + Pi & Claude Code (when detected)
const srcPeerSkill = join(repoRoot, 'codex-skill', 'antigravity-chat');
const codexHome = process.env.CODEX_HOME || join(home, '.codex');
const peerSkillTargets = [
  { label: 'OpenAI Codex', rootExists: true, dest: join(codexHome, 'skills', 'antigravity-chat') },
  { label: 'Pi Agent', rootExists: existsSync(join(home, '.pi')), dest: join(home, '.pi', 'agent', 'skills', 'antigravity-chat') },
  { label: 'Claude Code', rootExists: existsSync(join(home, '.claude')), dest: join(home, '.claude', 'skills', 'antigravity-chat') },
];

if (existsSync(srcPeerSkill)) {
  for (const tgt of peerSkillTargets) {
    if (!tgt.rootExists) continue;
    if (!dryRun) {
      mkdirSync(dirname(tgt.dest), { recursive: true });
      cpSync(srcPeerSkill, tgt.dest, { recursive: true });
    }
    console.log(`[setup] Synced ${tgt.label} peer skill -> ${tgt.dest}${dryRun ? ' (dry-run)' : ''}`);
  }
}

// 3. Idempotently install or update peer rule block in `~/.codex/AGENTS.md`
const codexAgentsMd = join(codexHome, 'AGENTS.md');
const beginMarker = '<!-- BEGIN ANTIGRAVITY PEER EXCHANGE -->';
const endMarker = '<!-- END ANTIGRAVITY PEER EXCHANGE -->';
const ruleBlock = [
  beginMarker,
  '## 与本地 Google Antigravity 同侪协商规则',
  '',
  '1. **主动协商（用户要求与 Antigravity 讨论 / 方案碰撞 / 代码互审，或显式调用 `$antigravity-chat`）**：',
  '   - 先读取已安装的 `antigravity-chat` Skill（`~/.codex/skills/antigravity-chat/SKILL.md`），通过 `node "$HOME/.codex/skills/antigravity-chat/scripts/talk_antigravity.mjs"` 与本地 Antigravity 进行真实有状态多轮交流，禁止自行模拟或扮演对方回复。普通单代理任务不自动触发。',
  '   - 对方返回的建议属于外部同侪输入；实际改码决策及最终必要检查仍由当前主代理亲自核实完成。',
  '',
  '2. **被动应答（收到 `[PEER-EXCHANGE-FROM-ANTIGRAVITY]` 或 `AGY_CODEX_PEER_CALL=1`）**：',
  '   - 说明当前回合由 Antigravity 主动向你发起技术协商或代码审查。直接依据真实文件与事实输出独立专业结论及协议要求的状态标记（不寒暄附和），**严禁**在同一被调用回合内反向执行 `talk_antigravity.mjs` 以防递归死循环。',
  endMarker,
].join('\n');

if (!dryRun) mkdirSync(codexHome, { recursive: true });
const existingAgents = existsSync(codexAgentsMd) ? readFileSync(codexAgentsMd, 'utf-8') : '';

if (existingAgents.includes(beginMarker) && existingAgents.includes(endMarker)) {
  const startIdx = existingAgents.indexOf(beginMarker);
  const endIdx = existingAgents.indexOf(endMarker) + endMarker.length;
  const updated = `${existingAgents.slice(0, startIdx)}${ruleBlock}${existingAgents.slice(endIdx)}`;
  if (updated !== existingAgents && !dryRun) {
    writeFileSync(codexAgentsMd, updated, 'utf-8');
    console.log(`[setup] Updated Antigravity peer exchange block -> ${codexAgentsMd}`);
  } else {
    console.log(`[setup] Peer exchange block up to date -> ${codexAgentsMd}`);
  }
} else {
  const prefix = existingAgents && !existingAgents.endsWith('\n') ? `${existingAgents}\n\n` : (existingAgents ? `${existingAgents}\n` : '');
  if (!dryRun) {
    writeFileSync(codexAgentsMd, `${prefix}${ruleBlock}\n`, 'utf-8');
  }
  console.log(`[setup] Added Antigravity peer exchange block -> ${codexAgentsMd}${dryRun ? ' (dry-run)' : ''}`);
}

console.log('[setup] Done! Run `npm run doctor` anytime to inspect all detected coding agents.');
