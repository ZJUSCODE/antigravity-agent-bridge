#!/usr/bin/env node
/**
 * OpenAI Codex -> Antigravity Peer Exchange CLI (`talk_antigravity.mjs`).
 * Enables Codex to conduct stateful multi-round technical collaboration, RFC debate,
 * and cross code review with local Google Antigravity (`agy`), while syncing every
 * turn live into Antigravity's shared `.codex_room` Sidecar UI!
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

if (process.env.AGY_CODEX_PEER_CALL === '1') {
  console.error('[Peer Guard] 当前处于同侪被调用回合（AGY_CODEX_PEER_CALL=1），请直接输出独立专业结论，禁止反向递归调用 talk_antigravity.mjs。');
  process.exit(2);
}

const corePath = join(
  homedir(),
  '.gemini',
  'config',
  'plugins',
  'codex-bridge',
  'sidecars',
  'codex_room',
  'codex_core.mjs'
);

const {
  buildPeerEnvelope,
  collectFilesContext,
  collectGitContext,
  resetAntigravityThread,
  runAntigravityTurn,
  sanitizeConvId,
} = await import(new URL(`file:///${corePath.replace(/\\/g, '/')}`).href);

function deriveProjectRoomId(cwdPath) {
  const norm = resolve(cwdPath || process.cwd());
  const base = basename(norm).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'workspace';
  const shortHash = createHash('sha1').update(norm.toLowerCase()).digest('hex').slice(0, 8);
  return sanitizeConvId(`peer_${base}_${shortHash}`);
}

function parseArgs(argv) {
  const out = {
    room: '',
    protocol: 'free',
    round: '',
    prompt: '',
    promptFile: '',
    stdin: false,
    diffGit: false,
    files: [],
    senderLabel: 'Codex',
    model: '',
    effort: 'medium',
    cwd: '',
    newThread: false,
    resetOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--room' || a === '--conv') && argv[i + 1]) out.room = argv[++i];
    else if (a === '--protocol' && argv[i + 1]) out.protocol = argv[++i].toLowerCase();
    else if (a === '--round' && argv[i + 1]) out.round = argv[++i];
    else if (a === '--prompt' && argv[i + 1]) out.prompt = argv[++i];
    else if (a === '--prompt-file' && argv[i + 1]) out.promptFile = argv[++i];
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--diff-git') out.diffGit = true;
    else if (a === '--file' && argv[i + 1]) out.files.push(argv[++i]);
    else if (a === '--from' && argv[i + 1]) out.senderLabel = argv[++i];
    else if (a === '--model' && argv[i + 1]) out.model = argv[++i];
    else if (a === '--effort' && argv[i + 1]) out.effort = argv[++i];
    else if (a === '--cwd' && argv[i + 1]) out.cwd = argv[++i];
    else if (a === '--new-thread') out.newThread = true;
    else if (a === '--reset') out.resetOnly = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const resolvedCwd = resolve(args.cwd || process.cwd());
const targetRoomId = args.room ? sanitizeConvId(args.room) : deriveProjectRoomId(resolvedCwd);

if (args.resetOnly) {
  const meta = resetAntigravityThread(targetRoomId);
  console.log(JSON.stringify({ reset: true, roomId: meta.conversationId }, null, 2));
  process.exit(0);
}

let rawBody = args.prompt;
if (args.promptFile) {
  rawBody = readFileSync(args.promptFile, 'utf-8');
} else if (args.stdin) {
  rawBody = readFileSync(0, 'utf-8');
}

if (!rawBody.trim() && args.files.length === 0) {
  console.error(
    'Usage: node talk_antigravity.mjs [--room <ROOM_ID>] [--cwd <DIR>] [--protocol rfc|review|debug|audit|free] [--round 1/2] [--diff-git] [--file <path>] (--prompt "<text>" | --prompt-file <path> | --stdin)'
  );
  process.exit(2);
}

const gitContext = args.diffGit ? collectGitContext(resolvedCwd) : '';
const { summaryNames, contextBlock: filesContext } = collectFilesContext(args.files);
const useEnvelope = args.protocol !== 'free' || Boolean(args.round) || Boolean(gitContext) || Boolean(filesContext);
const { displayText, wirePrompt } = useEnvelope
  ? buildPeerEnvelope({
      protocol: args.protocol,
      round: args.round,
      fromAgent: 'Codex',
      toAgent: 'Antigravity',
      body: rawBody || '请审阅附带文件。',
      gitContext,
      filesContext,
      attachedFileNames: summaryNames,
    })
  : { displayText: rawBody, wirePrompt: rawBody };

try {
  const res = await runAntigravityTurn({
    convId: targetRoomId,
    prompt: wirePrompt,
    displayText,
    sender: 'codex',
    senderLabel: args.senderLabel,
    model: args.model || undefined,
    effort: args.effort || 'medium',
    cwd: resolvedCwd,
    newThread: args.newThread,
  });
  console.log(`[peer: Codex -> Antigravity | roomId: ${res.conversationId} | agyConversationId: ${res.agyConversationId} | ${(res.durationMs / 1000).toFixed(1)}s]`);
  console.log(res.reply);
} catch (err) {
  console.error(`[Antigravity Peer Error] ${err.message}`);
  process.exit(1);
}
