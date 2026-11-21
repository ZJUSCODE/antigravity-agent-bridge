#!/usr/bin/env node
/**
 * `codex-bridge` Environment & Health Doctor (`npm run doctor`).
 * Verifies Node.js runtime, built-in SQLite, Antigravity & OpenAI Codex binaries,
 * plugin/skill installation, and automatic model resolution across Windows, macOS, and Linux.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const ciMode = process.argv.includes('--ci');

const coreUrl = pathToFileURL(join(repoRoot, 'sidecars', 'codex_room', 'codex_core.mjs')).href;
const core = await import(coreUrl);

const checks = [];
function record(ok, label, detail, optional = false) {
  checks.push({ ok, optional, label, detail });
  const icon = ok ? '✔' : (optional ? '⚠' : '✖');
  console.log(`  ${icon} ${label}: ${detail}`);
}

console.log(`\ncodex-bridge Environment Doctor (${platform()}/${arch()})\n`);

// 1. Node.js >= 22.5.0 + node:sqlite
const [maj, min] = process.versions.node.split('.').map(Number);
const nodeOk = maj > 22 || (maj === 22 && min >= 5);
record(nodeOk, 'Node.js Runtime', `v${process.versions.node} (requires >=22.5.0 for built-in node:sqlite)`);

let sqliteOk = false;
try {
  const { DatabaseSync } = await import('node:sqlite');
  const mem = new DatabaseSync(':memory:');
  mem.close();
  sqliteOk = true;
} catch {}
record(sqliteOk, 'Built-in node:sqlite', sqliteOk ? 'Available (zero native C++ addon compilation needed)' : 'Unavailable');

// 2. OpenAI Codex binary
try {
  const { exe } = core.findCodexBinary({ forceRefresh: true });
  let ver = '';
  try {
    ver = execFileSync(exe, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim();
  } catch {}
  record(true, 'OpenAI Codex Binary', `${exe}${ver ? ` (${ver})` : ''}`, ciMode);
} catch (err) {
  record(false, 'OpenAI Codex Binary', err.message, ciMode);
}

// 3. Google Antigravity CLI (`agy`)
try {
  const agyExe = core.findAgyBinary();
  record(true, 'Antigravity CLI (agy)', agyExe, true);
} catch (err) {
  record(false, 'Antigravity CLI (agy)', `${err.message} (optional: needed only when Codex initiates $antigravity-chat)`, true);
}

// 4. Default Codex Model Resolution
const resolvedModel = core.resolveDefaultCodexModel();
const models = core.listCodexModels();
record(true, 'Default Codex Model', `${resolvedModel} (${models.length} model entries available)`);

// 5. Plugin & Bidirectional Skill Wiring
const home = homedir();
const pluginManifest = join(home, '.gemini', 'config', 'plugins', 'codex-bridge', 'plugin.json');
record(existsSync(pluginManifest), 'Antigravity Plugin Dir', pluginManifest, ciMode);

const codexHome = core.getCodexHome();
const codexSkillMd = join(codexHome, 'skills', 'antigravity-chat', 'SKILL.md');
record(existsSync(codexSkillMd), 'Codex Peer Skill', codexSkillMd, ciMode);

const codexAgentsMd = join(codexHome, 'AGENTS.md');
const hasMarker = existsSync(codexAgentsMd) && readFileSync(codexAgentsMd, 'utf-8').includes('<!-- BEGIN ANTIGRAVITY PEER EXCHANGE -->');
record(hasMarker, 'Codex AGENTS.md Guard', hasMarker ? 'Installed' : 'Run `npm run setup` to wire Codex peer rules', ciMode);

const hardFailures = checks.filter((c) => !c.ok && !c.optional);
console.log('');
if (hardFailures.length > 0) {
  console.error(`Doctor found ${hardFailures.length} blocking issue(s). Run \`npm run setup\` or check missing binaries above.`);
  process.exit(1);
}
console.log('All required checks passed!\n');
