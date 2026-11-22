#!/usr/bin/env node
/**
 * Antigravity -> OpenAI Codex Peer Exchange CLI (`talk_codex.mjs`).
 * Drives stateful multi-round technical collaboration, adversarial code review,
 * and root-cause debugging while streaming live into the Aux-Pane `codex_room`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.AGY_CODEX_PEER_CALL === '1') {
  console.error('[Peer Guard] 当前处于同侪被调用回合（AGY_CODEX_PEER_CALL=1），请直接输出独立专业结论，禁止反向递归调用 talk_codex.mjs。');
  process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePath = join(__dirname, '..', '..', '..', 'sidecars', 'codex_room', 'codex_core.mjs');
const {
  buildPeerEnvelope,
  collectFilesContext,
  collectGitContext,
  getActiveRoomForHost,
  resetCodexThread,
  runCodexTurn,
} = await import(pathToFileURL(corePath).href);

function parseArgs(argv) {
  const out = {
    conv: process.env.ANTIGRAVITY_CONVERSATION_ID || 'global-default',
    room: '',
    protocol: 'free',
    round: '',
    prompt: '',
    promptFile: '',
    stdin: false,
    diffGit: false,
    files: [],
    images: [],
    sender: 'antigravity',
    senderLabel: 'Antigravity',
    model: '',
    effort: '',
    sandbox: '',
    cwd: '',
    newThread: false,
    resetOnly: false,
    useUserConfig: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--conv' && argv[i + 1]) out.conv = argv[++i];
    else if (a === '--room' && argv[i + 1]) out.room = argv[++i];
    else if (a === '--protocol' && argv[i + 1]) out.protocol = argv[++i].toLowerCase();
    else if (a === '--round' && argv[i + 1]) out.round = argv[++i];
    else if (a === '--prompt' && argv[i + 1]) out.prompt = argv[++i];
    else if (a === '--prompt-file' && argv[i + 1]) out.promptFile = argv[++i];
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--diff-git') out.diffGit = true;
    else if (a === '--file' && argv[i + 1]) out.files.push(argv[++i]);
    else if (a === '--image' && argv[i + 1]) out.images.push(argv[++i]);
    else if (a === '--from' && argv[i + 1]) out.senderLabel = argv[++i];
    else if (a === '--model' && argv[i + 1]) out.model = argv[++i];
    else if (a === '--effort' && argv[i + 1]) out.effort = argv[++i];
    else if (a === '--sandbox' && argv[i + 1]) out.sandbox = argv[++i];
    else if (a === '--cwd' && argv[i + 1]) out.cwd = argv[++i];
    else if (a === '--new-thread') out.newThread = true;
    else if (a === '--reset') out.resetOnly = true;
    else if (a === '--with-user-config') out.useUserConfig = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const targetRoomId = args.room || getActiveRoomForHost(args.conv);

if (args.resetOnly) {
  const meta = resetCodexThread(targetRoomId);
  console.log(JSON.stringify({ reset: true, roomId: meta.conversationId }, null, 2));
  process.exit(0);
}

let rawBody = args.prompt;
if (args.promptFile) {
  rawBody = readFileSync(args.promptFile, 'utf-8');
} else if (args.stdin) {
  rawBody = readFileSync(0, 'utf-8');
}

if (!rawBody.trim() && args.images.length === 0 && args.files.length === 0) {
  console.error(
    'Usage: node talk_codex.mjs --conv <CONV_ID> [--room <ROOM_ID>] [--protocol rfc|review|debug|audit|free] [--round 1] [--diff-git] [--file <path>] (--prompt "<text>" | --prompt-file <path> | --stdin)'
  );
  process.exit(2);
}

const resolvedCwd = args.cwd ? resolve(args.cwd) : undefined;
const gitContext = args.diffGit && resolvedCwd ? collectGitContext(resolvedCwd) : '';
const { summaryNames, contextBlock: filesContext } = collectFilesContext(args.files);
const useEnvelope = args.protocol !== 'free' || Boolean(args.round) || Boolean(gitContext) || Boolean(filesContext);

const { displayText, wirePrompt } = useEnvelope
  ? buildPeerEnvelope({
      protocol: args.protocol,
      round: args.round,
      fromAgent: 'Antigravity',
      toAgent: 'Codex',
      body: rawBody || '请审阅附带文件。',
      gitContext,
      filesContext,
      attachedFileNames: summaryNames,
    })
  : { displayText: rawBody, wirePrompt: rawBody };

// Per-turn ephemeral read-only default for rfc/review/audit without overwriting saved room preferences!
const turnSandbox = args.sandbox || (args.protocol === 'rfc' || args.protocol === 'review' || args.protocol === 'audit' ? 'read-only' : undefined);

try {
  const res = await runCodexTurn({
    convId: targetRoomId,
    prompt: wirePrompt,
    displayText,
    imagePaths: args.images,
    sender: args.sender,
    senderLabel: args.senderLabel,
    model: args.model || undefined,
    effort: args.effort || undefined,
    sandbox: turnSandbox,
    cwd: resolvedCwd,
    newThread: args.newThread,
    useUserConfig: args.useUserConfig,
    persistPrefs: false,
  });
  console.log(`[peer: Antigravity -> Codex | roomId: ${res.conversationId} | codexThreadId: ${res.codexThreadId} | ${(res.durationMs / 1000).toFixed(1)}s]`);
  console.log(res.reply);
} catch (err) {
  console.error(`[Codex Peer Error] ${err.message}`);
  process.exit(1);
}
