#!/usr/bin/env node
/**
 * Safe Cross-Platform Uninstaller (`npm run uninstall-bridge`).
 * Cleanly removes the Codex-side skill and rule block while preserving all user conversation history
 * and any unrelated rules in `~/.codex/AGENTS.md`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const codexHome = process.env.CODEX_HOME || join(home, '.codex');
const dstCodexSkill = join(codexHome, 'skills', 'antigravity-chat');
const codexAgentsMd = join(codexHome, 'AGENTS.md');
const beginMarker = '<!-- BEGIN ANTIGRAVITY PEER EXCHANGE -->';
const endMarker = '<!-- END ANTIGRAVITY PEER EXCHANGE -->';

if (existsSync(dstCodexSkill)) {
  rmSync(dstCodexSkill, { recursive: true, force: true });
  console.log(`[uninstall] Removed Codex skill -> ${dstCodexSkill}`);
} else {
  console.log(`[uninstall] Codex skill already absent -> ${dstCodexSkill}`);
}

if (existsSync(codexAgentsMd)) {
  const raw = readFileSync(codexAgentsMd, 'utf-8');
  if (raw.includes(beginMarker) && raw.includes(endMarker)) {
    const startIdx = raw.indexOf(beginMarker);
    const endIdx = raw.indexOf(endMarker) + endMarker.length;
    const cleaned = `${raw.slice(0, startIdx).trimEnd()}\n${raw.slice(endIdx).trimStart()}`.trim();
    writeFileSync(codexAgentsMd, cleaned ? `${cleaned}\n` : '', 'utf-8');
    console.log(`[uninstall] Removed Antigravity peer block from -> ${codexAgentsMd}`);
  }
}

console.log('[uninstall] Note: To disable or remove the Antigravity plugin itself, open Customizations -> Plugins -> Codex 对讲室 in Antigravity.');
