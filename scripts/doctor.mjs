#!/usr/bin/env node
/**
 * `antigravity-agent-bridge` Environment & Multi-Agent Doctor (`npm run doctor`).
 * Verifies Node.js >=22.5, built-in SQLite, Antigravity CLI, and all supported peer agents
 * (OpenAI Codex, Pi Agent, Claude Code, Gemini CLI, OpenCode, and Custom CLI adapters).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const ciMode = process.argv.includes('--ci');

const core = await import(pathToFileURL(join(repoRoot, 'sidecars', 'codex_room', 'codex_core.mjs')).href);
const providers = await import(pathToFileURL(join(repoRoot, 'sidecars', 'codex_room', 'agent_providers.mjs')).href);

const checks = [];
function record(ok, label, detail, optional = false) {
  checks.push({ ok, optional, label, detail });
  const icon = ok ? '✔' : (optional ? '○' : '✖');
  console.log(`  ${icon} ${label}: ${detail}`);
}

console.log(`\nantigravity-agent-bridge Doctor (${platform()}/${arch()})\n`);

// 1. Node.js >= 22.5.0 + node:sqlite
const [maj, min] = process.versions.node.split('.').map(Number);
const nodeOk = maj > 22 || (maj === 22 && min >= 5);
record(nodeOk, 'Node.js Runtime', `v${process.versions.node} (requires >=22.5.0)`);

let sqliteOk = false;
try {
  const { DatabaseSync } = await import('node:sqlite');
  const mem = new DatabaseSync(':memory:');
  mem.close();
  sqliteOk = true;
} catch {}
record(sqliteOk, 'Built-in node:sqlite', sqliteOk ? 'Available (zero C++ native addon needed)' : 'Unavailable');

// 2. Multi-Agent CLI Discovery
console.log('\n  Detected Coding Agents:');
const agentCatalog = providers.listSupportedAgents().filter((a) => !a.isCouncil);
let installedAgentCount = 0;
for (const ag of agentCatalog) {
  if (ag.installed) {
    installedAgentCount += 1;
    record(true, `  ${ag.displayName}`, ag.binPath, true);
  } else {
    record(false, `  ${ag.displayName}`, 'not installed (auto-enabled once installed)', true);
  }
}
record(installedAgentCount > 0, 'Active Peer Agents', `${installedAgentCount} coding agent(s) ready`, ciMode);

try {
  const agyExe = core.findAgyBinary();
  record(true, 'Antigravity CLI (agy)', agyExe, true);
} catch {
  record(false, 'Antigravity CLI (agy)', 'not on PATH (optional: needed only for reverse $antigravity-chat)', true);
}

// 3. Plugin & Skill Wiring
const home = homedir();
const pluginCandidates = [
  join(home, '.gemini', 'config', 'plugins', 'codex-bridge', 'plugin.json'),
  join(home, '.gemini', 'config', 'plugins', 'antigravity-agent-bridge', 'plugin.json'),
  join(home, '.gemini', 'config', 'plugins', 'antigravity-codex-bridge', 'plugin.json'),
];
const foundPluginManifest = pluginCandidates.find((p) => existsSync(p)) || pluginCandidates[0];
record(existsSync(foundPluginManifest), 'Antigravity Plugin', foundPluginManifest, ciMode);

const codexHome = core.getCodexHome();
const codexAgentsMd = join(codexHome, 'AGENTS.md');
const hasMarker = existsSync(codexAgentsMd) && readFileSync(codexAgentsMd, 'utf-8').includes('<!-- BEGIN ANTIGRAVITY PEER EXCHANGE -->');
record(hasMarker, 'Peer Anti-Recursion Guard', hasMarker ? 'Installed' : 'Run `npm run setup` to wire peer rules', ciMode);

const hardFailures = checks.filter((c) => !c.ok && !c.optional);
console.log('');
if (hardFailures.length > 0) {
  console.error(`Doctor found ${hardFailures.length} blocking issue(s). Run \`npm run setup\` or install at least one coding agent CLI.`);
  process.exit(1);
}
console.log('All required checks passed!\n');
