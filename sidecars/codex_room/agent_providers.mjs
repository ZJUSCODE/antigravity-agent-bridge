/**
 * Universal Multi-Agent Registry, Binary Discovery, Stateful Streaming Runner & Parallel Council Engine.
 *
 * Built-in first-class providers (zero external npm dependencies):
 *   1. `codex`    — OpenAI Codex (`codex app-server --stdio` JSON-RPC v2)
 *   2. `pi`       — Pi Coding Agent (`pi --mode json -p --session-id <uuid>`)
 *   3. `claude`   — Anthropic Claude Code (`claude -p --output-format stream-json --verbose`)
 *   4. `gemini`   — Google Gemini CLI (`gemini -p --output-format stream-json`)
 *   5. `opencode` — OpenCode CLI (`opencode run --format json`)
 *   6. `custom`   — User-extensible declarative CLI adapters (`agents.custom.json`)
 *   7. `council`  — Parallel Multi-Agent Roundtable (fans out to multiple installed agents simultaneously)
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  acquireRoomTurnLease,
  appendMessage,
  deriveCleanRoomTitle,
  ensureRoomDir,
  ensureUploadsDir,
  findCodexBinary,
  getPluginDataDir,
  heartbeatRoomTurnLease,
  listCodexModels,
  normalizeDirPath,
  queryAntigravityWorkspaceIndex,
  readMeta,
  releaseRoomTurnLease,
  resolveDefaultCodexModel,
  roomEvents,
  runCodexTurn,
  sanitizeClientAttachments,
  sanitizeConvId,
  stripWinPrefix,
  writeMeta,
} from './codex_core.mjs';

const HEARTBEAT_MS = 15000;
const binaryCache = new Map(); // agentId -> { info, ts }

export const BUILTIN_AGENT_SPECS = [
  {
    id: 'codex',
    displayName: 'OpenAI Codex',
    shortName: 'Codex',
    vendor: 'OpenAI',
    envVar: 'CODEX_BIN',
    defaultModels: [], // dynamically populated from listCodexModels()
  },
  {
    id: 'pi',
    displayName: 'Pi Agent',
    shortName: 'Pi',
    vendor: 'Pi',
    envVar: 'PI_BIN',
    defaultModels: [
      { slug: 'auto', displayName: 'Auto (Pi Default)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { slug: 'anthropic/claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5 (via Pi)', efforts: ['low', 'medium', 'high', 'max'] },
      { slug: 'openai/gpt-5.4', displayName: 'GPT-5.4 (via Pi)', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { slug: 'google/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro (via Pi)', efforts: ['low', 'medium', 'high'] },
    ],
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    shortName: 'Claude',
    vendor: 'Anthropic',
    envVar: 'CLAUDE_BIN',
    defaultModels: [
      { slug: 'auto', displayName: 'Auto (Claude Default)', efforts: ['low', 'medium', 'high', 'max'] },
      { slug: 'sonnet', displayName: 'Claude Sonnet', efforts: ['low', 'medium', 'high', 'max'] },
      { slug: 'opus', displayName: 'Claude Opus', efforts: ['low', 'medium', 'high', 'max'] },
      { slug: 'haiku', displayName: 'Claude Haiku', efforts: ['low', 'medium'] },
    ],
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    shortName: 'Gemini',
    vendor: 'Google',
    envVar: 'GEMINI_BIN',
    defaultModels: [
      { slug: 'auto', displayName: 'Auto (Gemini Default)', efforts: ['low', 'medium', 'high'] },
      { slug: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', efforts: ['low', 'medium', 'high'] },
      { slug: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', efforts: ['low', 'medium'] },
    ],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    shortName: 'OpenCode',
    vendor: 'SST',
    envVar: 'OPENCODE_BIN',
    defaultModels: [
      { slug: 'auto', displayName: 'Auto (OpenCode Default)', efforts: ['low', 'medium', 'high'] },
    ],
  },
];

export function loadCustomAgentSpecs() {
  const paths = [
    process.env.AGENT_BRIDGE_CUSTOM_CONFIG || '',
    join(getPluginDataDir(), '..', 'agents.custom.json'),
  ].filter(Boolean);

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      const arr = Array.isArray(parsed) ? parsed : (parsed.agents || []);
      return arr
        .filter((a) => a && typeof a.id === 'string' && /^[a-z0-9_-]{2,32}$/i.test(a.id) && a.bin)
        .map((a) => ({
          id: a.id.toLowerCase(),
          displayName: a.displayName || a.id,
          shortName: a.shortName || a.displayName || a.id,
          vendor: a.vendor || 'Custom',
          isCustom: true,
          bin: a.bin,
          argsTemplate: Array.isArray(a.args) ? a.args : ['-p', '{{prompt}}'],
          outputFormat: a.outputFormat === 'jsonl' ? 'jsonl' : 'text',
          defaultModels: [{ slug: 'auto', displayName: `Auto (${a.displayName || a.id})`, efforts: ['medium', 'high'] }],
        }));
    } catch {}
  }
  return [];
}

function whichBinary(cmdName) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const out = execFileSync(finder, [cmdName], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      windowsHide: true,
    });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && existsSync(l));
    if (process.platform === 'win32') {
      // Prefer .exe / .cmd / .js over extensionless POSIX shell shims on Windows
      const winPreferred = lines.find((l) => /\.(exe|cmd|cjs|mjs|js)$/i.test(l));
      return winPreferred || lines[0] || null;
    }
    return lines[0] || null;
  } catch {
    return null;
  }
}

export function findAgentBinary(agentId, { forceRefresh = false } = {}) {
  const id = String(agentId || 'codex').toLowerCase();
  if (id === 'codex') {
    return findCodexBinary({ forceRefresh });
  }

  const cached = binaryCache.get(id);
  if (!forceRefresh && cached && Date.now() - cached.ts < 30000 && existsSync(cached.info.exe)) {
    return cached.info;
  }

  const home = homedir();
  const isWin = process.platform === 'win32';
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');

  const customSpecs = loadCustomAgentSpecs();
  const customHit = customSpecs.find((c) => c.id === id);
  if (customHit) {
    const direct = existsSync(customHit.bin) ? customHit.bin : whichBinary(customHit.bin);
    if (!direct) throw new Error(`未找到自定义 Agent (${customHit.displayName}) 可执行文件: ${customHit.bin}`);
    const info = { exe: direct, extraPathDirs: [dirname(direct)] };
    binaryCache.set(id, { info, ts: Date.now() });
    return info;
  }

  const spec = BUILTIN_AGENT_SPECS.find((s) => s.id === id);
  if (spec?.envVar && process.env[spec.envVar] && existsSync(process.env[spec.envVar])) {
    const exe = process.env[spec.envVar];
    const info = { exe, extraPathDirs: [dirname(exe)] };
    binaryCache.set(id, { info, ts: Date.now() });
    return info;
  }

  const candidates = [];
  if (id === 'pi') {
    if (isWin) {
      candidates.push(
        join(home, '.pi', 'agent', 'bin', 'pi-launcher.js'),
        join(home, '.pi', 'agent', 'bin', 'pi.cmd'),
        join(appData, 'npm', 'pi.cmd')
      );
    } else {
      candidates.push(
        join(home, '.pi', 'agent', 'bin', 'pi'),
        join(home, '.local', 'bin', 'pi'),
        '/opt/homebrew/bin/pi',
        '/usr/local/bin/pi'
      );
    }
  } else if (id === 'claude') {
    if (isWin) {
      candidates.push(
        join(home, '.local', 'bin', 'claude.exe'),
        join(localAppData, 'AnthropicClaude', 'claude.exe'),
        join(appData, 'npm', 'claude.cmd')
      );
    } else {
      candidates.push(
        join(home, '.claude', 'local', 'claude'),
        join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude'
      );
    }
  } else if (id === 'gemini') {
    if (isWin) {
      candidates.push(join(appData, 'npm', 'gemini.cmd'));
    } else {
      candidates.push(
        join(home, '.local', 'bin', 'gemini'),
        join(home, '.npm-global', 'bin', 'gemini'),
        '/opt/homebrew/bin/gemini',
        '/usr/local/bin/gemini'
      );
    }
  } else if (id === 'opencode') {
    if (isWin) {
      candidates.push(
        join(home, '.opencode', 'bin', 'opencode.exe'),
        join(appData, 'npm', 'opencode.cmd')
      );
    } else {
      candidates.push(
        join(home, '.opencode', 'bin', 'opencode'),
        join(home, '.local', 'bin', 'opencode'),
        '/opt/homebrew/bin/opencode',
        '/usr/local/bin/opencode'
      );
    }
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      const info = { exe: c, extraPathDirs: [dirname(c)] };
      binaryCache.set(id, { info, ts: Date.now() });
      return info;
    }
  }

  const fromPath = whichBinary(id);
  if (fromPath) {
    const info = { exe: fromPath, extraPathDirs: [dirname(fromPath)] };
    binaryCache.set(id, { info, ts: Date.now() });
    return info;
  }

  throw new Error(`未检测到本地 ${spec?.displayName || id} CLI，请先安装或配置 ${spec?.envVar || 'PATH'}。`);
}

/**
 * Resolves Windows `.cmd` Node shims (`pi.cmd`, npm global `claude.cmd`, `gemini.cmd`, etc.)
 * directly to `node <entry.js>` so `spawn()` NEVER hits Windows CVE-2024-27980 `EINVAL`
 * and NEVER mangles multi-line prompts through `cmd.exe`!
 */
export function resolveSpawnCommand(exePath, args) {
  const lower = exePath.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return { command: process.execPath, spawnArgs: [exePath, ...args], shell: false };
  }

  if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    const dir = dirname(exePath);
    const piLauncher = join(dir, 'pi-launcher.js');
    if (basename(lower, '.cmd') === 'pi' && existsSync(piLauncher)) {
      return { command: process.execPath, spawnArgs: [piLauncher, ...args], shell: false };
    }
    try {
      const raw = readFileSync(exePath, 'utf-8');
      const m = /(?:%~?dp0%?[\\/])([^\r\n"]+\.(?:c?m?js))/i.exec(raw);
      if (m && m[1]) {
        const jsCandidate = resolve(dir, m[1].replace(/\\/g, '/'));
        if (existsSync(jsCandidate)) {
          return { command: process.execPath, spawnArgs: [jsCandidate, ...args], shell: false };
        }
      }
    } catch {}
    return { command: exePath, spawnArgs: args, shell: true };
  }

  return { command: exePath, spawnArgs: args, shell: false };
}

export function listSupportedAgents() {
  const allSpecs = [...BUILTIN_AGENT_SPECS, ...loadCustomAgentSpecs()];
  const providers = allSpecs.map((spec) => {
    let installed = false;
    let binPath = null;
    try {
      const found = findAgentBinary(spec.id);
      installed = Boolean(found?.exe);
      binPath = found?.exe || null;
    } catch {}

    const models = spec.id === 'codex' ? listCodexModels() : spec.defaultModels;
    const defaultModel = spec.id === 'codex' ? resolveDefaultCodexModel() : (models[0]?.slug || 'auto');

    return {
      id: spec.id,
      displayName: spec.displayName,
      shortName: spec.shortName,
      vendor: spec.vendor,
      isCustom: Boolean(spec.isCustom),
      installed,
      binPath,
      models,
      defaultModel,
      supportsInteractiveApproval: spec.id === 'codex',
    };
  });

  const installedIds = providers.filter((p) => p.installed).map((p) => p.id);
  providers.push({
    id: 'council',
    displayName: '多智能体圆桌 (Council)',
    shortName: '圆桌群聊',
    vendor: 'Multi-Agent',
    isCouncil: true,
    installed: installedIds.length >= 1,
    memberIds: installedIds,
    binPath: null,
    models: [{ slug: 'auto', displayName: '各智能体默认模型并行', efforts: ['low', 'medium', 'high', 'xhigh'] }],
    defaultModel: 'auto',
    supportsInteractiveApproval: false,
  });

  return providers;
}

function captureWorkspaceGitDiff(cwd) {
  if (!cwd || !existsSync(cwd)) return '';
  try {
    const out = execFileSync('git', ['diff', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      windowsHide: true,
    }).trim();
    return out.length > 60000 ? `${out.slice(0, 60000)}\n... [diff truncated]` : out;
  } catch {
    return '';
  }
}

function summarizeToolCall(toolName, argsObj) {
  const name = String(toolName || 'tool');
  if (!argsObj || typeof argsObj !== 'object') return name;
  const cmd = argsObj.command || argsObj.cmd || argsObj.path || argsObj.file_path || argsObj.pattern || '';
  if (cmd) {
    const clean = String(cmd).replace(/\s+/g, ' ').trim();
    return `${name}: ${clean.length > 68 ? clean.slice(0, 65) + '...' : clean}`;
  }
  return name;
}

function buildCliAgentSpawnSpec({
  agentId,
  sessionMap,
  prompt,
  imagePaths,
  model,
  effort,
  sandbox,
  approvalPolicy,
  cwd,
  roomTitle,
  newThread,
}) {
  const explicitModel = model && model !== 'auto' ? model : '';
  const prevSessionId = !newThread ? (sessionMap?.[agentId] || '') : '';
  const isReadOnly = sandbox === 'read-only';

  if (agentId === 'pi') {
    const piSessionId = prevSessionId || randomUUID();
    const args = ['--mode', 'json', '-p', '--session-id', piSessionId];
    if (roomTitle) args.push('--name', `[双AI] ${roomTitle}`);
    if (explicitModel) args.push('--model', explicitModel);
    if (effort) {
      const piThinking = effort === 'ultra' ? 'max' : effort;
      args.push('--thinking', piThinking);
    }
    if (isReadOnly) {
      args.push('--tools', 'read,grep,find,ls');
    } else if (approvalPolicy === 'never') {
      args.push('--approve');
    }
    args.push('--');
    for (const img of imagePaths) {
      args.push(`@${img}`);
    }
    args.push(prompt);
    return { args, stdinText: null, initialSessionId: piSessionId, format: 'pi-jsonl' };
  }

  if (agentId === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--add-dir', cwd];
    if (prevSessionId) args.push('--resume', prevSessionId);
    if (explicitModel) args.push('--model', explicitModel);
    if (isReadOnly) {
      args.push('--permission-mode', 'plan');
    } else if (approvalPolicy === 'never') {
      args.push('--permission-mode', 'bypassPermissions');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }
    // Pass prompt safely via stdin so arbitrary length / quotes work identically on every OS
    return { args, stdinText: prompt, initialSessionId: prevSessionId || null, format: 'claude-jsonl' };
  }

  if (agentId === 'gemini') {
    const args = ['--output-format', 'stream-json'];
    if (prevSessionId) args.push('--resume', prevSessionId);
    if (explicitModel) args.push('--model', explicitModel);
    if (!isReadOnly && approvalPolicy === 'never') {
      args.push('--yolo');
    }
    args.push('-p', prompt);
    return { args, stdinText: null, initialSessionId: prevSessionId || null, format: 'gemini-jsonl' };
  }

  if (agentId === 'opencode') {
    const args = ['run', '--format', 'json'];
    if (prevSessionId) args.push('-s', prevSessionId);
    if (explicitModel) args.push('-m', explicitModel);
    args.push(prompt);
    return { args, stdinText: null, initialSessionId: prevSessionId || null, format: 'opencode-jsonl' };
  }

  // Custom declarative provider
  const custom = loadCustomAgentSpecs().find((c) => c.id === agentId);
  if (!custom) throw new Error(`未知的智能体类型: ${agentId}`);
  const args = custom.argsTemplate.map((tok) =>
    String(tok)
      .replace(/\{\{prompt\}\}/g, prompt)
      .replace(/\{\{cwd\}\}/g, cwd)
      .replace(/\{\{model\}\}/g, explicitModel)
  );
  return { args, stdinText: null, initialSessionId: null, format: custom.outputFormat };
}

async function executeStreamingCliAgent({
  safeConv,
  agentId,
  agentLabel,
  prompt,
  imagePaths,
  model,
  effort,
  sandbox,
  approvalPolicy,
  chosenCwd,
  roomTitle,
  sessionMap,
  newThread,
  roomEpoch,
  leaseId,
  onLivePatch,
}) {
  const { exe, extraPathDirs } = findAgentBinary(agentId);
  const spec = buildCliAgentSpawnSpec({
    agentId,
    sessionMap,
    prompt,
    imagePaths,
    model,
    effort,
    sandbox,
    approvalPolicy,
    cwd: chosenCwd,
    roomTitle,
    newThread,
  });

  const { command, spawnArgs, shell } = resolveSpawnCommand(exe, spec.args);
  const childEnv = { ...process.env, AGY_CODEX_PEER_CALL: '1' };
  delete childEnv.NODE_OPTIONS;
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const curPath = childEnv.PATH || childEnv.Path || '';
  childEnv.PATH = [...(extraPathDirs || []), curPath].filter(Boolean).join(pathSep);
  if ('Path' in childEnv) childEnv.Path = childEnv.PATH;

  const startedAt = Date.now();
  const preDiff = sandbox !== 'read-only' ? captureWorkspaceGitDiff(chosenCwd) : '';

  return new Promise((resolveRun, rejectRun) => {
    let resolvedSessionId = spec.initialSessionId;
    let streamingText = '';
    let reasoningSummary = '';
    let liveCommandOutput = '';
    let liveStatus = `${agentLabel} thinking…`;
    let streamErr = '';
    let stderrBuf = '';
    let rawPlainStdout = '';
    let stdoutRemainder = '';
    let tokenCount = null;
    let wasCancelled = false;
    let settled = false;
    const steps = [];
    const piBlocks = new Map();       // contentIndex -> text
    const piThinkBlocks = new Map();  // contentIndex -> thinking
    const activeTools = new Map();    // toolCallId -> { label, startedAt }

    const child = spawn(command, spawnArgs, {
      cwd: chosenCwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
      windowsHide: true,
    });

    if (spec.stdinText !== null) {
      try {
        child.stdin.write(spec.stdinText, 'utf-8');
      } catch {}
    }
    try { child.stdin.end(); } catch {}

    const emitLive = () => {
      if (typeof onLivePatch === 'function' && !settled && !wasCancelled) {
        onLivePatch({
          liveStatus,
          streamingText,
          reasoningSummary,
          liveCommandOutput,
          steps: [...steps],
        });
      }
    };

    const checkCancel = () => {
      try {
        const cur = readMeta(safeConv);
        if (((cur.cancelRequestedAt && cur.cancelRequestedAt >= startedAt) || (cur.roomEpoch || 1) !== roomEpoch) && !wasCancelled) {
          wasCancelled = true;
          try { child.kill(); } catch {}
        }
      } catch {}
    };
    roomEvents.on(`change:${safeConv}`, checkCancel);

    const handleJsonRecord = (ev) => {
      if (!ev || typeof ev !== 'object') return;

      // ---- 1. Pi Coding Agent (`--mode json`) ----
      if (spec.format === 'pi-jsonl') {
        if (ev.type === 'session' && ev.id) {
          resolvedSessionId = ev.id;
        } else if (ev.type === 'message_update' && ev.assistantMessageEvent) {
          const ae = ev.assistantMessageEvent;
          const idx = ae.contentIndex ?? 0;
          if (ae.type === 'text_delta' && typeof ae.delta === 'string') {
            piBlocks.set(idx, (piBlocks.get(idx) || '') + ae.delta);
            streamingText = [...piBlocks.values()].join('\n\n');
            liveStatus = `${agentLabel} responding…`;
            emitLive();
          } else if (ae.type === 'text_end' && typeof ae.content === 'string') {
            piBlocks.set(idx, ae.content);
            streamingText = [...piBlocks.values()].join('\n\n');
            emitLive();
          } else if (ae.type === 'thinking_delta' && typeof ae.delta === 'string') {
            piThinkBlocks.set(idx, (piThinkBlocks.get(idx) || '') + ae.delta);
            reasoningSummary = [...piThinkBlocks.values()].join('\n').trim();
            liveStatus = `${agentLabel} thinking…`;
            emitLive();
          } else if (ae.type === 'thinking_end' && typeof ae.content === 'string') {
            piThinkBlocks.set(idx, ae.content);
            reasoningSummary = [...piThinkBlocks.values()].join('\n').trim();
            emitLive();
          } else if (ae.type === 'toolcall_start') {
            liveStatus = `${agentLabel} calling ${ae.toolName || 'tool'}…`;
            emitLive();
          } else if (ae.type === 'error' && ae.error) {
            streamErr = String(ae.error?.message || ae.error);
          }
          if (ev.usage?.totalTokens) tokenCount = ev.usage.totalTokens;
        } else if (ev.type === 'tool_execution_start') {
          const label = summarizeToolCall(ev.toolName, ev.args);
          activeTools.set(ev.toolCallId || 'default', { label, startedAt: Date.now() });
          liveStatus = `${agentLabel}: ${label}`;
          liveCommandOutput = '';
          emitLive();
        } else if (ev.type === 'tool_execution_update') {
          const txt = ev.partialResult?.content?.map((c) => c?.text || '').join('') || '';
          if (txt) {
            liveCommandOutput = txt.slice(-1400);
            emitLive();
          }
        } else if (ev.type === 'tool_execution_end') {
          const tracked = activeTools.get(ev.toolCallId || 'default');
          activeTools.delete(ev.toolCallId || 'default');
          const outTxt = ev.result?.content?.map((c) => c?.text || '').join('') || '';
          liveCommandOutput = '';
          steps.push({
            kind: 'command',
            label: tracked?.label || summarizeToolCall(ev.toolName, null),
            output: outTxt.trim().slice(-1400),
            exitCode: ev.isError ? 1 : 0,
            durationMs: ev.durationMs ?? (tracked ? Date.now() - tracked.startedAt : null),
          });
          liveStatus = `${agentLabel} thinking…`;
          emitLive();
        } else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
          const contentArr = Array.isArray(ev.message.content) ? ev.message.content : [];
          const finalTxt = contentArr
            .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('\n\n')
            .trim();
          if (finalTxt) streamingText = finalTxt;
          if (ev.message.usage?.totalTokens) tokenCount = ev.message.usage.totalTokens;
          if (ev.message.errorMessage) streamErr = String(ev.message.errorMessage);
          emitLive();
        }
        return;
      }

      // ---- 2. Anthropic Claude Code (`--output-format stream-json`) ----
      if (spec.format === 'claude-jsonl') {
        if (ev.session_id) resolvedSessionId = ev.session_id;
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
          const delta = ev.event.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            streamingText += delta.text;
            liveStatus = `${agentLabel} responding…`;
            emitLive();
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            reasoningSummary += delta.thinking;
            liveStatus = `${agentLabel} thinking…`;
            emitLive();
          }
        } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          const texts = [];
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) texts.push(block.text);
            else if (block.type === 'thinking' && block.thinking && !reasoningSummary) reasoningSummary = block.thinking;
            else if (block.type === 'tool_use') {
              const label = summarizeToolCall(block.name, block.input);
              liveStatus = `${agentLabel}: ${label}`;
              steps.push({ kind: 'command', label, exitCode: 0 });
            }
          }
          if (texts.length > 0) streamingText = texts.join('\n\n');
          emitLive();
        } else if (ev.type === 'result') {
          if (typeof ev.result === 'string' && ev.result.trim()) {
            streamingText = ev.result.trim();
          }
          if (ev.is_error) {
            streamErr = String(ev.result || ev.error || 'Claude Code execution failed');
          }
        }
        return;
      }

      // ---- 3. Google Gemini CLI / OpenCode / Generic JSONL ----
      if (ev.session_id || ev.sessionId || ev.sessionID) {
        resolvedSessionId = ev.session_id || ev.sessionId || ev.sessionID;
      }
      if (ev.type === 'message' || ev.type === 'text') {
        const chunk = ev.content ?? ev.delta ?? ev.text ?? ev.part?.text ?? '';
        if (typeof chunk === 'string' && (ev.role === 'assistant' || ev.role === 'model' || !ev.role)) {
          if (ev.delta || ev.part) streamingText += chunk;
          else streamingText = chunk;
          liveStatus = `${agentLabel} responding…`;
          emitLive();
        }
      } else if (ev.type === 'tool_use' || ev.type === 'tool_call') {
        const label = summarizeToolCall(ev.name || ev.toolName, ev.input || ev.args);
        liveStatus = `${agentLabel}: ${label}`;
        steps.push({ kind: 'command', label, exitCode: 0 });
        emitLive();
      } else if (ev.type === 'error' && ev.message) {
        streamErr = String(ev.message);
      } else if (ev.type === 'result' && typeof ev.response === 'string' && ev.response.trim()) {
        streamingText = ev.response.trim();
      }
    };

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      if (spec.format === 'text') {
        rawPlainStdout += chunk;
        streamingText = rawPlainStdout.trim();
        liveStatus = `${agentLabel} responding…`;
        emitLive();
        return;
      }
      // Split strictly on LF (\n) per Pi JSONL specification
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split('\n');
      stdoutRemainder = lines.pop() || '';
      for (const rawLine of lines) {
        const trimmed = rawLine.replace(/\r$/, '').trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('{')) {
          try {
            handleJsonRecord(JSON.parse(trimmed));
            continue;
          } catch {}
        }
        rawPlainStdout += `${trimmed}\n`;
      }
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      roomEvents.off(`change:${safeConv}`, checkCancel);
      rejectRun(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      roomEvents.off(`change:${safeConv}`, checkCancel);

      if (stdoutRemainder.trim().startsWith('{')) {
        try { handleJsonRecord(JSON.parse(stdoutRemainder.trim())); } catch {}
      } else if (stdoutRemainder.trim()) {
        rawPlainStdout += stdoutRemainder;
      }

      const durationMs = Date.now() - startedAt;
      const postDiff = sandbox !== 'read-only' ? captureWorkspaceGitDiff(chosenCwd) : '';
      const netDiff = postDiff !== preDiff ? postDiff : '';

      if (wasCancelled) {
        resolveRun({
          cancelled: true,
          agentId,
          agentLabel,
          sessionId: resolvedSessionId,
          reply: streamingText ? `${streamingText.trim()}\n\n*(已手动中止)*` : '*(回合已手动中止)*',
          reasoningSummary: reasoningSummary.trim(),
          steps,
          diff: netDiff,
          tokenCount,
          durationMs,
        });
        return;
      }

      const finalReply = (streamingText || rawPlainStdout).trim();
      if (code !== 0 && !finalReply) {
        const errMsg = (streamErr || stderrBuf || `${agentLabel} exited with code ${code}`).trim().slice(-700);
        rejectRun(new Error(errMsg));
        return;
      }

      resolveRun({
        cancelled: false,
        agentId,
        agentLabel,
        sessionId: resolvedSessionId,
        reply: finalReply || (netDiff ? `已完成文件修改（见下方 Diff）` : '（已完成）'),
        reasoningSummary: reasoningSummary.trim(),
        steps,
        diff: netDiff,
        tokenCount,
        durationMs,
      });
    });
  });
}

/**
 * Unified single-agent turn runner supporting `codex`, `pi`, `claude`, `gemini`, `opencode`, and custom CLI agents.
 */
export async function runAgentTurn({
  convId,
  agentId = 'codex',
  prompt,
  displayText,
  attachments = [],
  imagePaths = [],
  sender = 'antigravity',
  senderLabel,
  model,
  effort = 'medium',
  sandbox = 'read-only',
  approvalPolicy = 'on-request',
  cwd,
  newThread = false,
  persistPrefs = false,
  allowPeerRecursion = false,
}) {
  const normalizedAgent = String(agentId || 'codex').toLowerCase();
  if (normalizedAgent === 'council') {
    return runCouncilTurn({
      convId,
      prompt,
      displayText,
      attachments,
      imagePaths,
      sender,
      senderLabel,
      effort,
      sandbox,
      cwd,
      allowPeerRecursion,
    });
  }

  if (normalizedAgent === 'codex') {
    return runCodexTurn({
      convId,
      prompt,
      displayText,
      attachments,
      imagePaths,
      sender,
      senderLabel,
      model,
      effort,
      sandbox,
      cwd,
      newThread,
      persistPrefs,
      allowPeerRecursion,
    });
  }

  if (!allowPeerRecursion && process.env.AGY_CODEX_PEER_CALL === '1') {
    throw new Error('[Peer Guard] 当前处于被调用同侪回合（AGY_CODEX_PEER_CALL=1），请直接输出独立结论，禁止递归派发。');
  }

  const safeConv = sanitizeConvId(convId);
  const spec = [...BUILTIN_AGENT_SPECS, ...loadCustomAgentSpecs()].find((s) => s.id === normalizedAgent);
  const agentLabel = spec?.displayName || normalizedAgent;

  const { leaseId, roomEpoch, meta: prevMeta } = acquireRoomTurnLease(safeConv, `${normalizedAgent}-cli`);
  const hbTimer = setInterval(() => heartbeatRoomTurnLease(safeConv, leaseId), HEARTBEAT_MS);
  if (typeof hbTimer.unref === 'function') hbTimer.unref();

  try {
    const verifiedAtts = sanitizeClientAttachments(safeConv, attachments);
    const rawText = String(prompt || '').trim();
    const bubbleText = String(displayText || prompt || '').trim();
    if (!rawText && verifiedAtts.length === 0 && imagePaths.length === 0) {
      throw new Error('发送内容不能为空。');
    }

    const inferredAgyCwd = (!cwd && !prevMeta.cwd)
      ? (queryAntigravityWorkspaceIndex().pathByConvId.get(safeConv) || null)
      : null;
    const chosenCwd = normalizeDirPath(cwd || prevMeta.cwd || inferredAgyCwd || ensureRoomDir(safeConv));
    mkdirSync(chosenCwd, { recursive: true });
    ensureUploadsDir(safeConv);

    const allImages = imagePaths.filter((p) => p && existsSync(p));
    const nonImgFiles = [];
    for (const att of verifiedAtts) {
      if (att.isImage) allImages.push(att.path);
      else nonImgFiles.push(att);
    }

    appendMessage(safeConv, {
      sender,
      senderLabel: senderLabel || (sender === 'user' ? '你' : 'Antigravity'),
      text: bubbleText || `已发送 ${verifiedAtts.length} 个附件`,
      attachments: verifiedAtts,
      model: model || 'auto',
      effort,
    }, { expectedEpoch: roomEpoch, expectedLeaseId: leaseId, requireExists: true });

    let effectivePrompt = rawText || '请分析附带的图片或文件内容。';
    if (nonImgFiles.length > 0) {
      effectivePrompt += `\n\n[附加本地文件：\n${nonImgFiles.map((f) => `- ${f.name}: ${f.path}`).join('\n')}\n]`;
    }
    if (allImages.length > 0 && normalizedAgent !== 'pi') {
      effectivePrompt += `\n\n[附加图片路径：\n${allImages.map((p) => `- ${p}`).join('\n')}\n]`;
    }

    const startedAt = Date.now();
    let lastFlush = 0;
    const activeTurn = {
      id: `turn_${randomUUID().slice(0, 8)}`,
      startedAt,
      sender,
      targetAgent: normalizedAgent,
      liveStatus: `${agentLabel} starting…`,
      reasoningSummary: '',
      liveCommandOutput: '',
      streamingText: '',
      diff: '',
      plan: [],
      pendingApprovals: [],
      steps: [],
    };

    writeMeta(safeConv, {
      ...(persistPrefs ? { activeAgent: normalizedAgent, effort, cwd: chosenCwd } : { cwd: prevMeta.cwd || chosenCwd }),
      status: 'thinking',
      activeTurn,
      lastError: null,
    }, { expectedEpoch: roomEpoch, expectedLeaseId: leaseId, requireExists: true });

    const roomTitle = deriveCleanRoomTitle(readMeta(safeConv).title || bubbleText, 44);
    const result = await executeStreamingCliAgent({
      safeConv,
      agentId: normalizedAgent,
      agentLabel,
      prompt: effectivePrompt,
      imagePaths: allImages,
      model,
      effort,
      sandbox,
      approvalPolicy,
      chosenCwd,
      roomTitle,
      sessionMap: prevMeta.agentSessions || {},
      newThread,
      roomEpoch,
      leaseId,
      onLivePatch: (patch) => {
        Object.assign(activeTurn, patch);
        if (Date.now() - lastFlush >= 90) {
          lastFlush = Date.now();
          writeMeta(safeConv, {
            status: 'thinking',
            activeTurn: { ...activeTurn },
          }, { expectedEpoch: roomEpoch, expectedLeaseId: leaseId, requireExists: true });
        }
      },
    });

    const replyEntry = appendMessage(safeConv, {
      sender: normalizedAgent,
      senderLabel: agentLabel,
      text: result.reply,
      diff: result.diff || '',
      reasoningSummary: result.reasoningSummary || '',
      model: model && model !== 'auto' ? model : normalizedAgent,
      effort,
      durationMs: result.durationMs,
      tokenCount: result.tokenCount,
      steps: result.steps || [],
    }, { expectedEpoch: roomEpoch, requireExists: true });

    const nextSessions = { ...(readMeta(safeConv).agentSessions || {}) };
    if (result.sessionId) nextSessions[normalizedAgent] = result.sessionId;

    const finalMeta = releaseRoomTurnLease(safeConv, leaseId, {
      agentSessions: nextSessions,
      status: 'idle',
      activeTurn: null,
      lastError: null,
    });

    return {
      conversationId: safeConv,
      agentId: normalizedAgent,
      sessionId: result.sessionId,
      reply: replyEntry?.text || result.reply,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      steps: result.steps,
      meta: finalMeta,
    };
  } catch (err) {
    releaseRoomTurnLease(safeConv, leaseId, {
      status: 'error',
      activeTurn: null,
      lastError: stripWinPrefix(err.message),
    });
    throw err;
  } finally {
    clearInterval(hbTimer);
  }
}

/**
 * Parallel Multi-Agent Roundtable ("群策圆桌" Council Mode).
 * Dispatches the same prompt simultaneously across multiple installed CLI agents
 * (e.g., Codex + Pi + Claude Code + Gemini CLI) and streams their independent responses into the room!
 */
export async function runCouncilTurn({
  convId,
  agents = null,
  prompt,
  displayText,
  attachments = [],
  imagePaths = [],
  sender = 'antigravity',
  senderLabel,
  effort = 'medium',
  sandbox = 'read-only',
  cwd,
  allowPeerRecursion = false,
}) {
  if (!allowPeerRecursion && process.env.AGY_CODEX_PEER_CALL === '1') {
    throw new Error('[Peer Guard] 当前处于被调用同侪回合（AGY_CODEX_PEER_CALL=1），禁止递归发起圆桌广播。');
  }

  const catalog = listSupportedAgents().filter((a) => !a.isCouncil);
  const requestedIds = Array.isArray(agents) && agents.length > 0
    ? agents.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
    : catalog.filter((a) => a.installed).map((a) => a.id);

  if (requestedIds.length === 0) {
    throw new Error('未检测到任何已安装的本地智能体 CLI（Codex / Pi / Claude Code / Gemini CLI）。');
  }

  // Council mode defaults to safe read-only parallel analysis unless single-agent write is requested
  const effectiveSandbox = requestedIds.length > 1 ? 'read-only' : sandbox;
  const safeConv = sanitizeConvId(convId);
  const { leaseId, roomEpoch, meta: prevMeta } = acquireRoomTurnLease(safeConv, 'council');
  const hbTimer = setInterval(() => heartbeatRoomTurnLease(safeConv, leaseId), HEARTBEAT_MS);
  if (typeof hbTimer.unref === 'function') hbTimer.unref();

  try {
    const verifiedAtts = sanitizeClientAttachments(safeConv, attachments);
    const rawText = String(prompt || '').trim();
    const bubbleText = String(displayText || prompt || '').trim();
    if (!rawText && verifiedAtts.length === 0 && imagePaths.length === 0) {
      throw new Error('请输入圆桌讨论议题。');
    }

    const inferredAgyCwd = (!cwd && !prevMeta.cwd)
      ? (queryAntigravityWorkspaceIndex().pathByConvId.get(safeConv) || null)
      : null;
    const chosenCwd = normalizeDirPath(cwd || prevMeta.cwd || inferredAgyCwd || ensureRoomDir(safeConv));
    mkdirSync(chosenCwd, { recursive: true });
    ensureUploadsDir(safeConv);

    appendMessage(safeConv, {
      sender,
      senderLabel: senderLabel || (sender === 'user' ? '你（圆桌广播）' : 'Antigravity（圆桌召集）'),
      text: bubbleText || rawText,
      attachments: verifiedAtts,
      effort,
    }, { expectedEpoch: roomEpoch, expectedLeaseId: leaseId, requireExists: true });

    const startedAt = Date.now();
    const statusByAgent = new Map(requestedIds.map((id) => [id, 'running']));
    const syncCouncilBanner = () => {
      const summary = requestedIds.map((id) => {
        const st = statusByAgent.get(id);
        return `${id}${st === 'done' ? ' ✓' : st === 'err' ? ' ✖' : '…'}`;
      }).join(' · ');
      writeMeta(safeConv, {
        cwd: prevMeta.cwd || chosenCwd,
        status: 'thinking',
        activeTurn: {
          id: `council_${startedAt}`,
          startedAt,
          sender,
          liveStatus: `圆桌并行征询 (${summary})`,
          reasoningSummary: '',
          streamingText: '',
          diff: '',
          plan: [],
          pendingApprovals: [],
          steps: [],
        },
        lastError: null,
      }, { expectedEpoch: roomEpoch, expectedLeaseId: leaseId, requireExists: true });
    };
    syncCouncilBanner();

    const roomTitle = deriveCleanRoomTitle(readMeta(safeConv).title || bubbleText, 44);
    const nextSessions = { ...(prevMeta.agentSessions || {}) };

    const tasks = requestedIds.map(async (id) => {
      const spec = catalog.find((c) => c.id === id) || { id, displayName: id };
      try {
        if (id === 'codex') {
          // Run Codex via lightweight one-shot codex exec --json or app-server inside existing council lease
          const { exe, extraPathDirs } = findCodexBinary();
          const codexArgs = ['exec', '--json', '--skip-git-repo-check', '-s', effectiveSandbox, '-C', chosenCwd, rawText];
          const childEnv = { ...process.env, AGY_CODEX_PEER_CALL: '1' };
          delete childEnv.NODE_OPTIONS;
          const pathSep = process.platform === 'win32' ? ';' : ':';
          childEnv.PATH = [...(extraPathDirs || []), childEnv.PATH || ''].filter(Boolean).join(pathSep);

          const t0 = Date.now();
          const codexOut = await new Promise((resCodex, rejCodex) => {
            let outText = '';
            let errText = '';
            let rem = '';
            const c = spawn(exe, codexArgs, { cwd: chosenCwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            c.stdout.setEncoding('utf-8');
            c.stdout.on('data', (ch) => {
              rem += ch;
              const ls = rem.split('\n');
              rem = ls.pop() || '';
              for (const l of ls) {
                const t = l.trim();
                if (!t.startsWith('{')) continue;
                try {
                  const ev = JSON.parse(t);
                  if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
                    outText = ev.item.text;
                  }
                } catch {}
              }
            });
            c.stderr.setEncoding('utf-8');
            c.stderr.on('data', (ch) => { errText += ch; });
            c.on('error', rejCodex);
            c.on('close', (code) => {
              if (code !== 0 && !outText) rejCodex(new Error(errText.trim().slice(-400) || `Codex exited ${code}`));
              else resCodex({ reply: outText || '（已完成）', durationMs: Date.now() - t0 });
            });
          });
          statusByAgent.set(id, 'done');
          syncCouncilBanner();
          appendMessage(safeConv, {
            sender: 'codex',
            senderLabel: 'OpenAI Codex',
            text: codexOut.reply,
            effort,
            durationMs: codexOut.durationMs,
          }, { expectedEpoch: roomEpoch, requireExists: true });
          return { agentId: id, ok: true, reply: codexOut.reply, durationMs: codexOut.durationMs };
        }

        const out = await executeStreamingCliAgent({
          safeConv,
          agentId: id,
          agentLabel: spec.displayName,
          prompt: rawText,
          imagePaths: imagePaths.filter((p) => p && existsSync(p)),
          model: 'auto',
          effort,
          sandbox: effectiveSandbox,
          approvalPolicy: 'never',
          chosenCwd,
          roomTitle,
          sessionMap: nextSessions,
          newThread: false,
          roomEpoch,
          leaseId,
        });
        if (out.sessionId) nextSessions[id] = out.sessionId;
        statusByAgent.set(id, 'done');
        syncCouncilBanner();
        appendMessage(safeConv, {
          sender: id,
          senderLabel: spec.displayName,
          text: out.reply,
          reasoningSummary: out.reasoningSummary || '',
          effort,
          durationMs: out.durationMs,
          tokenCount: out.tokenCount,
          steps: out.steps || [],
        }, { expectedEpoch: roomEpoch, requireExists: true });
        return { agentId: id, ok: true, reply: out.reply, durationMs: out.durationMs };
      } catch (agentErr) {
        statusByAgent.set(id, 'err');
        syncCouncilBanner();
        appendMessage(safeConv, {
          sender: id,
          senderLabel: spec.displayName,
          text: `*(调用异常: ${stripWinPrefix(agentErr.message)})*`,
        }, { expectedEpoch: roomEpoch, requireExists: true });
        return { agentId: id, ok: false, error: agentErr.message };
      }
    });

    const results = await Promise.all(tasks);
    const finalMeta = releaseRoomTurnLease(safeConv, leaseId, {
      agentSessions: nextSessions,
      status: 'idle',
      activeTurn: null,
      lastError: null,
    });

    return {
      conversationId: safeConv,
      council: true,
      results,
      meta: finalMeta,
    };
  } catch (err) {
    releaseRoomTurnLease(safeConv, leaseId, {
      status: 'error',
      activeTurn: null,
      lastError: stripWinPrefix(err.message),
    });
    throw err;
  } finally {
    clearInterval(hbTimer);
  }
}
