#!/usr/bin/env node
/**
 * Universal Antigravity -> Multi-Agent Peer Orchestration CLI (`talk_agent.mjs`).
 *
 * Supports:
 *   --agent codex|pi|claude|gemini|opencode|council|<customId>
 *   --agents codex,pi,claude   (parallel Multi-Agent Council fan-out!)
 *   --protocol rfc|review|debug|audit|free
 *   --round 1/2
 *   --sandbox read-only|workspace-write
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.AGY_CODEX_PEER_CALL === '1') {
  console.error('[Peer Guard] 当前处于被调用同侪回合（AGY_CODEX_PEER_CALL=1），请直接输出独立结论，禁止递归调用 talk_agent.mjs。');
  process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePath = join(__dirname, '..', '..', '..', 'sidecars', 'codex_room', 'codex_core.mjs');
const providersPath = join(__dirname, '..', '..', '..', 'sidecars', 'codex_room', 'agent_providers.mjs');

const {
  buildPeerEnvelope,
  collectFilesContext,
  collectGitContext,
  getActiveRoomForHost,
  resetCodexThread,
} = await import(pathToFileURL(corePath).href);

const {
  listSupportedAgents,
  runAgentTurn,
  runCouncilTurn,
} = await import(pathToFileURL(providersPath).href);

function parseArgs(argv) {
  const out = {
    conv: process.env.ANTIGRAVITY_CONVERSATION_ID || 'global-default',
    room: '',
    agent: 'codex',
    agents: [],
    listAgents: false,
    protocol: 'free',
    round: '',
    prompt: '',
    promptFile: '',
    stdin: false,
    diffGit: false,
    files: [],
    images: [],
    senderLabel: 'Antigravity',
    model: '',
    effort: 'medium',
    sandbox: 'read-only',
    cwd: '',
    newThread: false,
    resetOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list-agents') out.listAgents = true;
    else if (a === '--agent' && argv[i + 1]) out.agent = argv[++i].toLowerCase();
    else if (a === '--agents' && argv[i + 1]) {
      out.agents = argv[++i].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      out.agent = 'council';
    } else if (a === '--conv' && argv[i + 1]) out.conv = argv[++i];
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
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.listAgents) {
  console.log(JSON.stringify(listSupportedAgents(), null, 2));
  process.exit(0);
}

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
    'Usage: node talk_agent.mjs [--agent codex|pi|claude|gemini|opencode|council] [--agents codex,pi] [--room <ID>] [--cwd <DIR>] [--protocol rfc|review|debug|audit|free] [--round 1/2] [--sandbox read-only|workspace-write] [--diff-git] [--file <path>] (--prompt "<text>" | --prompt-file <path> | --stdin)'
  );
  process.exit(2);
}

const resolvedCwd = args.cwd ? resolve(args.cwd) : process.cwd();
const gitContext = args.diffGit ? collectGitContext(resolvedCwd) : '';
const { summaryNames, contextBlock: filesContext } = collectFilesContext(args.files);
const toLabel = args.agents.length > 0 ? `Council(${args.agents.join(',')})` : args.agent.toUpperCase();
const useEnvelope = args.protocol !== 'free' || Boolean(args.round) || Boolean(gitContext) || Boolean(filesContext);

const { displayText, wirePrompt } = useEnvelope
  ? buildPeerEnvelope({
      protocol: args.protocol,
      round: args.round,
      fromAgent: 'Antigravity',
      toAgent: toLabel,
      body: rawBody || '请审阅附带内容。',
      gitContext,
      filesContext,
      attachedFileNames: summaryNames,
    })
  : { displayText: rawBody, wirePrompt: rawBody };

try {
  if (args.agent === 'council' || args.agents.length > 0) {
    const councilRes = await runCouncilTurn({
      convId: targetRoomId,
      agents: args.agents.length > 0 ? args.agents : null,
      prompt: wirePrompt,
      displayText,
      imagePaths: args.images.map((p) => resolve(p)),
      sender: 'antigravity',
      senderLabel: args.senderLabel,
      effort: args.effort || 'medium',
      sandbox: args.sandbox || 'read-only',
      cwd: args.cwd ? resolvedCwd : undefined,
    });
    console.log(`[council | roomId: ${councilRes.conversationId} | agents: ${councilRes.results.map((r) => r.agentId).join(', ')}]`);
    for (const r of councilRes.results) {
      console.log(`\n=== [${r.agentId.toUpperCase()}] ${r.ok ? `(${(r.durationMs / 1000).toFixed(1)}s)` : '(ERROR)'} ===\n${r.reply || r.error}`);
    }
  } else {
    const res = await runAgentTurn({
      convId: targetRoomId,
      agentId: args.agent,
      prompt: wirePrompt,
      displayText,
      imagePaths: args.images.map((p) => resolve(p)),
      sender: 'antigravity',
      senderLabel: args.senderLabel,
      model: args.model || undefined,
      effort: args.effort || 'medium',
      sandbox: args.sandbox || 'read-only',
      cwd: args.cwd ? resolvedCwd : undefined,
      newThread: args.newThread,
    });
    console.log(`[peer: Antigravity -> ${args.agent} | roomId: ${res.conversationId} | ${(res.durationMs / 1000).toFixed(1)}s]`);
    console.log(res.reply);
  }
} catch (err) {
  console.error(`[Agent Bridge Error] ${err.message}`);
  process.exit(1);
}
