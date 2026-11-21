#!/usr/bin/env node
/**
 * Safe Cross-Platform Uninstaller (`npm run uninstall-bridge`).
 * Cleanly removes peer skills installed into `~/.codex`, `~/.pi`, and `~/.claude`,
 * and strips ONLY the Antigravity peer rule block from `~/.codex/AGENTS.md`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const codexHome = process.env.CODEX_HOME || join(home, '.codex');
const skillPaths = [
  join(codexHome, 'skills', 'antigravity-chat'),
  join(home, '.pi', 'agent', 'skills', 'antigravity-chat'),
  join(home, '.claude', 'skills', 'antigravity-chat'),
];

for (const sp of skillPaths) {
  if (existsSync(sp)) {
    rmSync(sp, { recursive: true, force: true });
    console.log(`[uninstall] Removed peer skill -> ${sp}`);
  }
}

const codexAgentsMd = join(codexHome, 'AGENTS.md');
const beginMarker = '<!-- BEGIN ANTIGRAVITY PEER EXCHANGE -->';
const endMarker = '<!-- END ANTIGRAVITY PEER EXCHANGE -->';

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

console.log('[uninstall] Note: To disable or remove the Antigravity plugin itself, open Customizations -> Plugins in Antigravity.');
