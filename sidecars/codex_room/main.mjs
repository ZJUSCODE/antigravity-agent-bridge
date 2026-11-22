/**
 * Enterprise Antigravity ↔ Codex Native Aux-Pane Sidecar Backend.
 * Powered by persistent `codex app-server --stdio` (AppServerBridge),
 * event-driven long-polling (`waitForRoomChange`), and Dual-AI Orchestration.
 */
import { execFile, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  addCustomProject,
  appendMessage,
  assertValidExplicitRoomId,
  backfillCodexDesktopCatalog,
  createNewRoom,
  deleteRoom,
  deriveCleanRoomTitle,
  exportRoomMarkdown,
  findCodexBinary,
  findMirroredHubConvInDb,
  formatCodexDesktopThreadName,
  getActiveRoomForHost,
  getCodexDesktopProjectMatch,
  getGlobalLiveDiscussion,
  getPluginDataDir,
  getProjectThreadTree,
  getRoomDir,
  getRoomSnapshot,
  importNativeCodexSession,
  listAvailableProjects,
  listCodexModels,
  listNativeCodexSessions,
  listRecentRooms,
  normalizeDirPath,
  queryAntigravityWorkspaceIndex,
  readMessages,
  readMeta,
  registerInProcessBusyChecker,
  removeUploadedFile,
  renameRoom,
  resetCodexThread,
  resolveDefaultCodexModel,
  resolveSafeUploadPath,
  roomEvents,
  sanitizeClientAttachments,
  sanitizeConvId,
  saveUploadedFile,
  setActiveRoomForHost,
  switchToProject,
  syncCodexDesktopCatalogEntry,
  togglePinRoom,
  waitForRoomChange,
  writeMeta,
} from './codex_core.mjs';
import { AppServerBridge } from './app_server_bridge.mjs';
import { listSupportedAgents, runAgentTurn } from './agent_providers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
const codexFonts = loadLocalCodexFonts();

function resolveCodexAsarPath() {
  const winApps = 'C:\\Program Files\\WindowsApps';
  try {
    if (existsSync(winApps)) {
      const dirs = readdirSync(winApps).filter((d) => d.startsWith('OpenAI.Codex_')).sort().reverse();
      for (const d of dirs) {
        const candidate = join(winApps, d, 'app', 'resources', 'app.asar');
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // Standard user tokens get EPERM on WindowsApps root scandir; fallback to Get-AppxPackage below
  }

  if (process.platform === 'win32') {
    try {
      const loc = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation"],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      ).trim();
      if (loc) {
        const candidate = join(loc, 'app', 'resources', 'app.asar');
        if (existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  if (process.platform === 'darwin') {
    const macCandidates = [
      '/Applications/Codex.app/Contents/Resources/app.asar',
      join(process.env.HOME || '', 'Applications', 'Codex.app', 'Contents', 'Resources', 'app.asar'),
    ];
    for (const c of macCandidates) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

function loadLocalCodexFonts() {
  const out = new Map();
  const fontKeys = ['regular', 'medium', 'semibold'];
  const cacheDir = join(getPluginDataDir(), 'fonts');

  try {
    if (fontKeys.every((k) => existsSync(join(cacheDir, `openai-sans-${k}.woff2`)))) {
      for (const k of fontKeys) {
        out.set(k, readFileSync(join(cacheDir, `openai-sans-${k}.woff2`)));
      }
      return out;
    }
  } catch {}

  try {
    const asarPath = resolveCodexAsarPath();
    if (!asarPath) return out;

    const fd = openSync(asarPath, 'r');
    try {
      const pre = Buffer.alloc(16);
      readSync(fd, pre, 0, 16, 0);
      const headerSize = pre.readUInt32LE(4);
      const strSize = pre.readUInt32LE(12);
      const headerBuf = Buffer.alloc(strSize);
      readSync(fd, headerBuf, 0, strSize, 16);
      const header = JSON.parse(headerBuf.toString('utf-8'));
      const dataOffset = 8 + headerSize;
      const assets = header?.files?.webview?.files?.assets?.files || {};

      mkdirSync(cacheDir, { recursive: true });
      for (const [key, prefix] of [
        ['regular', 'OpenAISans-Regular'],
        ['medium', 'OpenAISans-Medium'],
        ['semibold', 'OpenAISans-Semibold'],
      ]) {
        const matchName = Object.keys(assets).find((k) => k.startsWith(prefix) && k.endsWith('.woff2'));
        if (matchName && !assets[matchName].unpacked) {
          const entry = assets[matchName];
          const buf = Buffer.alloc(entry.size);
          readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset));
          out.set(key, buf);
          try { writeFileSync(join(cacheDir, `openai-sans-${key}.woff2`), buf); } catch {}
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {}
  return out;
}

export function getUiVersion() {
  try {
    const t1 = statSync(join(__dirname, 'index.html')).mtimeMs;
    const t2 = statSync(join(__dirname, 'styles.css')).mtimeMs;
    const t3 = statSync(join(__dirname, 'app.js')).mtimeMs;
    return `${Math.floor(t1)}-${Math.floor(t2)}-${Math.floor(t3)}`;
  } catch {
    return '1';
  }
}

function resolveRoomId(data, defaultHostConv) {
  if (data && 'roomId' in data && data.roomId !== undefined && data.roomId !== null && data.roomId !== '' && data.roomId !== 'auto') {
    return assertValidExplicitRoomId(data.roomId);
  }
  if (data && 'conversationId' in data && data.conversationId !== undefined && data.conversationId !== null && data.conversationId !== '' && data.conversationId !== 'auto') {
    const validHost = assertValidExplicitRoomId(data.conversationId);
    return getActiveRoomForHost(validHost);
  }
  return getActiveRoomForHost(sanitizeConvId(defaultHostConv || 'global-default'));
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function buildSidecarApp(bridge = new AppServerBridge()) {
  registerInProcessBusyChecker((id) => bridge.isRoomBusy(id));
  const app = new SidecarApp();

  app.page('/', () => {
    const v = getUiVersion();
    const html = readFileSync(join(__dirname, 'index.html'), 'utf-8')
      .replace('/styles.css?v=3', `/styles.css?v=${v}`)
      .replace('/app.js?v=3', `/app.js?v=${v}`);
    return new Response(html, { contentType: 'text/html; charset=utf-8', headers: NO_CACHE });
  });

  app.api('/styles.css', () => new Response(
    readFileSync(join(__dirname, 'styles.css'), 'utf-8'),
    { contentType: 'text/css; charset=utf-8', headers: NO_CACHE }
  ), 'GET');

  app.api('/app.js', () => new Response(
    readFileSync(join(__dirname, 'app.js'), 'utf-8'),
    { contentType: 'application/javascript; charset=utf-8', headers: NO_CACHE }
  ), 'GET');

  for (const key of ['regular', 'medium', 'semibold']) {
    app.api(`/fonts/openai-sans-${key}.woff2`, () => {
      const buf = codexFonts.get(key);
      if (!buf) return new Response('not found', { status: 404 });
      return new Response(buf, { contentType: 'font/woff2', headers: { 'Cache-Control': 'private, max-age=86400' } });
    }, 'GET');
  }

  app.api('/api/health', () => {
    try {
      const { exe } = findCodexBinary();
      return {
        ok: true,
        engine: 'app-server',
        codexExe: exe,
        fontsLoaded: codexFonts.size,
        uiVersion: getUiVersion(),
      };
    } catch (err) {
      return { ok: false, error: err.message, uiVersion: getUiVersion() };
    }
  }, 'GET');

  app.api('/api/diagnostics', () => {
    let codexExe = null;
    try { codexExe = findCodexBinary().exe; } catch {}
    return {
      ok: Boolean(codexExe),
      codexExe,
      fontsLoaded: codexFonts.size,
      uiVersion: getUiVersion(),
      bridge: bridge.getDiagnostics(),
    };
  }, 'GET');

  app.api('/api/catalog', (data) => {
    const wsPaths = data.workspaces ? String(data.workspaces).split('|').filter(Boolean) : [];
    const agents = listSupportedAgents();
    return {
      agents,
      models: listCodexModels(),
      projects: listAvailableProjects(wsPaths),
    };
  }, 'GET');

  app.api('/api/projects/add', (data) => {
    const proj = addCustomProject(data.path);
    return { ok: true, project: proj };
  }, 'POST');

  app.api('/api/projects/switch', (data) => {
    const hostId = sanitizeConvId(data.conversationId || app.config.conversationId || 'global-default');
    const res = switchToProject(hostId, data.path, {
      model: data.model,
      effort: data.effort,
      mode: data.mode,
      approvalPolicy: data.approvalPolicy,
    });
    return { ok: true, ...res };
  }, 'POST');

  app.api('/api/threads', (data) => {
    const hostId = sanitizeConvId(data.conversationId || app.config.conversationId || 'global-default');
    const wsPaths = data.workspaces ? String(data.workspaces).split('|').filter(Boolean) : [];
    const bridgeRooms = listRecentRooms(80);
    const tree = getProjectThreadTree(wsPaths, bridgeRooms);
    return {
      activeRoomId: getActiveRoomForHost(hostId),
      projectGroups: tree.projectGroups,
      ungrouped: tree.ungrouped,
      bridgeThreads: bridgeRooms.slice(0, 45),
      codexNativeThreads: listNativeCodexSessions(30),
    };
  }, 'GET');

  app.api('/api/threads/create', (data) => {
    const hostId = sanitizeConvId(data.conversationId || app.config.conversationId || 'global-default');
    const meta = createNewRoom({
      cwd: data.cwd || null,
      model: data.model || resolveDefaultCodexModel(),
      effort: data.effort || 'medium',
      mode: data.mode || 'dual-2',
      approvalPolicy: data.approvalPolicy || 'on-request',
    });
    setActiveRoomForHost(hostId, meta.conversationId);
    return { ok: true, roomId: meta.conversationId, meta };
  }, 'POST');

  app.api('/api/threads/select', (data) => {
    const hostId = sanitizeConvId(data.conversationId || app.config.conversationId || 'global-default');
    const target = assertValidExplicitRoomId(data.roomId);
    const roomId = setActiveRoomForHost(hostId, target);
    return { ok: true, roomId, snap: getRoomSnapshot(roomId) };
  }, 'POST');

  app.api('/api/threads/rename', (data) => {
    const target = data.roomId
      ? assertValidExplicitRoomId(data.roomId)
      : assertValidExplicitRoomId(resolveRoomId(data, app.config.conversationId));
    const meta = renameRoom(target, data.title);
    return { ok: true, roomId: target, meta };
  }, 'POST');

  app.api('/api/threads/pin', (data) => {
    const target = data.roomId
      ? assertValidExplicitRoomId(data.roomId)
      : assertValidExplicitRoomId(resolveRoomId(data, app.config.conversationId));
    const meta = togglePinRoom(target);
    return { ok: true, roomId: target, meta };
  }, 'POST');

  app.api('/api/threads/import-codex', (data) => {
    const hostId = sanitizeConvId(data.conversationId || app.config.conversationId || 'global-default');
    const snap = importNativeCodexSession(data.sessionId, data.title || '');
    setActiveRoomForHost(hostId, snap.conversationId);
    return { ok: true, roomId: snap.conversationId, snap };
  }, 'POST');

  app.api('/api/threads/delete', async (data) => {
    const hostId = sanitizeConvId(data.conversationId || app.config.conversationId || 'global-default');
    const target = assertValidExplicitRoomId(data.roomId);
    await bridge.cancelRoomTurn(target).catch(() => {});
    deleteRoom(target);
    if (getActiveRoomForHost(hostId) === target) {
      const remaining = listRecentRooms(1);
      if (remaining.length > 0) {
        setActiveRoomForHost(hostId, remaining[0].conversationId);
      } else {
        const fresh = createNewRoom();
        setActiveRoomForHost(hostId, fresh.conversationId);
      }
    }
    return { ok: true, activeRoomId: getActiveRoomForHost(hostId) };
  }, 'POST');

  app.api('/api/room', async (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    if (data.wait === '1' && data.etag) {
      return waitForRoomChange(roomId, String(data.etag), getUiVersion, data.timeoutMs || 8000);
    }
    const snap = getRoomSnapshot(roomId);
    const liveDiscussion = getGlobalLiveDiscussion();
    const otherLiveSig = (liveDiscussion && liveDiscussion.roomId !== roomId)
      ? `${liveDiscussion.roomId}:${liveDiscussion.status}:${liveDiscussion.leaseStartedAt || 0}:${liveDiscussion.updatedAt || 0}`
      : 'self';
    const uiVersion = getUiVersion();
    const fullEtag = `${snap.etag}:${otherLiveSig}:${uiVersion}`;
    if (data.etag && data.etag === fullEtag) {
      return { conversationId: roomId, unchanged: true, liveDiscussion, etag: fullEtag, uiVersion };
    }
    return { ...snap, liveDiscussion, etag: fullEtag, uiVersion };
  }, 'GET');

  app.api('/api/settings', (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const patch = {};
    if (data.activeAgent) patch.activeAgent = String(data.activeAgent).toLowerCase();
    if (data.model) patch.model = String(data.model);
    if (data.effort) patch.effort = String(data.effort);
    if (data.mode) patch.mode = String(data.mode);
    if (data.approvalPolicy) patch.approvalPolicy = String(data.approvalPolicy);
    if ('cwd' in data) patch.cwd = data.cwd || null;
    if (data.sandbox) patch.sandbox = String(data.sandbox);
    const meta = writeMeta(roomId, patch);
    return { ok: true, meta };
  }, 'POST');

  app.api('/api/upload', (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const saved = saveUploadedFile(roomId, {
      fileName: data.fileName,
      mimeType: data.mimeType,
      dataBase64: data.dataBase64,
    });
    return { ok: true, attachment: saved, roomId };
  }, 'POST');

  app.api('/api/upload/remove', (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const res = removeUploadedFile(roomId, data.storedName);
    return { ok: true, ...res };
  }, 'POST');

  app.api('/api/attachment', (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const safePath = resolveSafeUploadPath(roomId, data.file);
    if (!safePath || !existsSync(safePath)) {
      return new Response('not found', { status: 404 });
    }
    const ext = extname(safePath).toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    return new Response(readFileSync(safePath), {
      contentType: mime,
      headers: {
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }, 'GET');

  app.api('/api/export', (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const res = exportRoomMarkdown(roomId, { saveToDisk: data.saveToDisk !== false });
    return { ok: true, roomId, ...res };
  }, 'POST');

  app.api('/api/announce-topic', (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const topic = String(data.topic || '').trim();
    const explicitRounds = Number(data.rounds);
    const mode = String(data.mode || 'auto');
    const verifiedAttachments = sanitizeClientAttachments(roomId, data.attachments);
    if (!topic && verifiedAttachments.length === 0) {
      throw new Error('请输入讨论议题或添加有效附件。');
    }
    const modeSuffix = Number.isInteger(explicitRounds) && explicitRounds > 0
      ? `（协同讨论 ${explicitRounds} 轮）`
      : mode === 'dispatch'
        ? '（主控决策 → 派工闭环验收）'
        : '（多智能体协同 · Antigravity 自主决策轮次）';
    appendMessage(roomId, {
      sender: 'user',
      senderLabel: '你（发起议题）',
      text: `${topic || '请分析附件内容'}${modeSuffix}`,
      attachments: verifiedAttachments,
    });
    writeMeta(roomId, { lastError: null });
    return { ok: true, roomId, verifiedAttachments };
  }, 'POST');

  const handleAskAgent = async (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const verifiedAttachments = sanitizeClientAttachments(roomId, data.attachments);
    const prompt = String(data.prompt || '').trim();
    if (!prompt && verifiedAttachments.length === 0) {
      throw new Error('请输入内容或添加有效附件。');
    }

    const curMeta = readMeta(roomId);
    const chosenAgent = String(data.agentId || data.activeAgent || curMeta.activeAgent || 'codex').toLowerCase();

    if (chosenAgent === 'codex') {
      return bridge.startInteractiveTurn({
        roomId,
        prompt,
        attachments: verifiedAttachments,
        sender: data.sender || 'user',
        senderLabel: data.senderLabel || '你',
        model: data.model || undefined,
        effort: data.effort || undefined,
        sandbox: data.sandbox || undefined,
        approvalPolicy: data.approvalPolicy || undefined,
        cwd: data.cwd || undefined,
        newThread: Boolean(data.newThread),
      });
    }

    // Fire-and-stream non-Codex CLI agents (Pi / Claude Code / Gemini CLI / OpenCode / Council)
    // asynchronously while streaming real-time progress into `.codex_room/meta.json`!
    runAgentTurn({
      convId: roomId,
      agentId: chosenAgent,
      prompt,
      attachments: verifiedAttachments,
      sender: data.sender || 'user',
      senderLabel: data.senderLabel || '你',
      model: data.model || undefined,
      effort: data.effort || undefined,
      sandbox: data.sandbox || 'workspace-write',
      approvalPolicy: data.approvalPolicy || undefined,
      cwd: data.cwd || undefined,
      newThread: Boolean(data.newThread),
      persistPrefs: true,
    }).catch((err) => {
      writeMeta(roomId, { status: 'error', activeTurn: null, lastError: err.message });
    });

    return { started: true, roomId, agentId: chosenAgent };
  };

  app.api('/api/ask-codex', handleAskAgent, 'POST');
  app.api('/api/ask-agent', handleAskAgent, 'POST');

  app.api('/api/approve', (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const decision = String(data.decision || '');
    return bridge.respondApproval(roomId, data.approvalToken || data.rpcId, decision);
  }, 'POST');

  app.api('/api/reset-thread', async (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    await bridge.cancelRoomTurn(roomId).catch(() => {});
    const meta = resetCodexThread(roomId, { clearHistory: data.clearHistory === true });
    return { ok: true, meta };
  }, 'POST');

  app.api('/api/cancel', async (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    await bridge.cancelRoomTurn(roomId);
    return { ok: true };
  }, 'POST');

  app.api('/api/open-in-codex', (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const meta = readMeta(roomId);
    const threadId = String(meta.codexThreadId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{13,55}$/i.test(threadId)) {
      throw new Error('当前对话尚未生成有效的 Codex 线程 UUID');
    }
    syncCodexDesktopCatalogEntry({
      threadId,
      title: meta.codexNamedTitle || formatCodexDesktopThreadName(meta.title, ''),
      cwd: meta.cwd || undefined,
    });
    const projectMatch = getCodexDesktopProjectMatch(meta.cwd || '');
    const deepUrl = `codex://threads/${encodeURIComponent(threadId)}?hostId=local`;
    if (process.platform === 'win32') {
      execFile('explorer.exe', [deepUrl], { windowsHide: true }, () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [deepUrl], () => {});
    } else {
      execFile('xdg-open', [deepUrl], () => {});
    }
    return {
      ok: true,
      url: deepUrl,
      codexThreadId: threadId,
      projectMatched: projectMatch.matched,
      projectName: projectMatch.projectName,
    };
  }, 'POST');

  return { app, bridge };
}

// ---------------------------------------------------------------------------
// Live Antigravity Workspace Folder Mirror (`agentapi` -> Left Sidebar Folder)
// Automatically surfaces every `[双AI]` peer discussion directly inside the
// matching workspace folder in Antigravity Desktop's left sidebar!
// ---------------------------------------------------------------------------
const activeMirrorJobs = new Set();
const knownMirrorConvIds = new Set();

function execAgentApiAsync(args, projectId) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  if (!exe) return Promise.resolve(null);
  const env = { ...process.env, AGY_CODEX_PEER_CALL: '1' };
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
  return new Promise((resolveOut, rejectOut) => {
    execFile(exe, ['agentapi', ...args], { encoding: 'utf-8', env, timeout: 25000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        rejectOut(new Error(stderr || err.message));
        return;
      }
      const trimmed = String(stdout || '').trim();
      try {
        resolveOut(trimmed ? JSON.parse(trimmed) : {});
      } catch {
        resolveOut({ raw: trimmed });
      }
    });
  });
}

function buildFolderMirrorPayload(roomId, hubTitle, deltaMessages, allCount, transcriptFileUrl) {
  const blocks = [];
  let charBudget = 7600;
  let truncatedCount = 0;

  const PEER_ROLE_ICONS = {
    codex: '🤖 **OpenAI Codex**',
    pi: '🥧 **Pi Agent**',
    claude: '🟠 **Claude Code**',
    gemini: '✦ **Gemini CLI**',
    opencode: '⚡ **OpenCode**',
    antigravity: '🧠 **Google Antigravity**',
  };

  for (const m of deltaMessages) {
    const roleLabel = PEER_ROLE_ICONS[m.sender]
      || (m.sender === 'user' ? `👤 **${m.senderLabel || '发起人'}**` : `🤖 **${m.senderLabel || m.sender}**`);
    const timeStr = m.ts ? new Date(m.ts).toLocaleString('zh-CN', { hour12: false }) : '';
    const rawBody = String(m.text || '').trim();
    if (charBudget <= 300) {
      truncatedCount += 1;
      continue;
    }
    const clipped = rawBody.length > Math.min(2600, charBudget)
      ? `${rawBody.slice(0, Math.min(2600, charBudget))}\n\n*(本条长文已在预览中折叠，完整原文见下方实录文件或右侧对讲室)*`
      : rawBody;
    charBudget -= clipped.length;
    blocks.push(`${roleLabel}${timeStr ? ` · \`${timeStr}\`` : ''}\n\n${clipped}`);
  }

  if (truncatedCount > 0) {
    blocks.push(`*(其余 ${truncatedCount} 条长发言已完整保存在下方实录文件中)*`);
  }

  return [
    `# ${hubTitle}`,
    `> **[双 AI 讨论归档同步 · 请勿调用任何工具]** 本会话由 \`codex-bridge\` 自动归档至当前项目文件夹，实时镜像 Antigravity ↔ Codex 的多轮协商过程。`,
    `> - 右侧交互面板：[Codex 对讲室](sidecar://codex-bridge/codex_room/?roomId=${roomId})`,
    `> - 完整无损实录：[dual_ai_transcript.md](${transcriptFileUrl})`,
    blocks.join('\n\n---\n\n'),
    `---`,
    `**[归档助手回复守则]**：请勿调用任何工具、终端命令或桥接脚本，仅直接回复一行：\`✅ 已同步归档双 AI 讨论实录（累计 ${allCount} 条发言）\`。`,
  ].join('\n\n');
}

async function syncRoomToAntigravityFolder(roomId) {
  if (!roomId || roomId.startsWith('codex_') || !process.env.ANTIGRAVITY_AGENTAPI_EXE) return;
  if (activeMirrorJobs.has(roomId) || knownMirrorConvIds.has(roomId)) return;

  const meta = readMeta(roomId);
  if (!meta || meta.status !== 'idle' || !meta.cwd) return;
  if (meta.mirroredHubConvId) knownMirrorConvIds.add(meta.mirroredHubConvId);

  const normCwd = normalizeDirPath(meta.cwd);
  const { projectIdByPath } = queryAntigravityWorkspaceIndex();
  const agyProjectId = projectIdByPath.get(normCwd.toLowerCase());
  if (!agyProjectId) return;

  const messages = readMessages(roomId).filter((m) => m.sender !== 'system' && String(m.text || '').trim());
  const hasExternalAgent = messages.some((m) => m.sender !== 'antigravity' && m.sender !== 'user');
  const hasInitiator = messages.some((m) => m.sender === 'antigravity' || m.sender === 'user');
  if (!hasExternalAgent || !hasInitiator || messages.length < 2) return;

  const maxSeq = Number(messages[messages.length - 1].seq) || messages.length;
  const mirroredSeq = Number(meta.mirroredHubSeq) || 0;
  if (meta.mirroredHubConvId && maxSeq <= mirroredSeq) return;

  const delta = meta.mirroredHubConvId
    ? messages.filter((m) => (Number(m.seq) || 0) > mirroredSeq)
    : messages;
  if (delta.length === 0) return;

  activeMirrorJobs.add(roomId);
  try {
    const cleanTitle = deriveCleanRoomTitle(meta.title, 44) || '双 AI 技术协商';
    const hubTitle = formatCodexDesktopThreadName(cleanTitle);

    // Save lossless full Markdown inside room directory for 1-click viewing
    const mdExport = exportRoomMarkdown(roomId, { saveToDisk: false });
    const transcriptPath = join(getRoomDir(roomId), 'dual_ai_transcript.md');
    writeFileSync(transcriptPath, mdExport.markdown, 'utf-8');
    const transcriptFileUrl = pathToFileURL(transcriptPath).href;

    let targetHubConvId = meta.mirroredHubConvId || findMirroredHubConvInDb(agyProjectId, hubTitle);
    const payload = buildFolderMirrorPayload(roomId, hubTitle, delta, messages.length, transcriptFileUrl);

    if (!targetHubConvId) {
      const created = await execAgentApiAsync(
        ['new-conversation', '--model=flash_lite', `--title=${hubTitle}`, payload],
        agyProjectId
      );
      const rawCreatedStr = JSON.stringify(created || '');
      const uuidMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(rawCreatedStr);
      const newConvId = created?.conversation_id
        || created?.conversationId
        || created?.cascade_id
        || created?.cascadeId
        || (uuidMatch ? uuidMatch[0] : null)
        || findMirroredHubConvInDb(agyProjectId, hubTitle);
      if (newConvId) {
        knownMirrorConvIds.add(newConvId);
        try { setActiveRoomForHost(newConvId, roomId); } catch {}
        writeMeta(roomId, {
          mirroredHubConvId: newConvId,
          mirroredHubSeq: maxSeq,
          mirroredAgyProjectId: agyProjectId,
        });
      }
    } else {
      knownMirrorConvIds.add(targetHubConvId);
      try { setActiveRoomForHost(targetHubConvId, roomId); } catch {}
      await execAgentApiAsync(
        ['send-message', `--title=${hubTitle}`, targetHubConvId, payload],
        agyProjectId
      );
      writeMeta(roomId, {
        mirroredHubConvId: targetHubConvId,
        mirroredHubSeq: maxSeq,
        mirroredAgyProjectId: agyProjectId,
      });
    }
  } catch (err) {
    console.error(`[codex-bridge] folder mirror error (${roomId}):`, err.message);
  } finally {
    activeMirrorJobs.delete(roomId);
  }
}

function startBackgroundFolderMirrorDaemon() {
  const pendingTimers = new Map();
  const scheduleSync = (roomId, delayMs = 900) => {
    if (!roomId || roomId.startsWith('codex_')) return;
    clearTimeout(pendingTimers.get(roomId));
    const t = setTimeout(() => {
      pendingTimers.delete(roomId);
      syncRoomToAntigravityFolder(roomId).catch(() => {});
    }, delayMs);
    if (typeof t.unref === 'function') t.unref();
    pendingTimers.set(roomId, t);
  };

  roomEvents.on('any-change', (changedRoomId) => {
    if (changedRoomId) scheduleSync(changedRoomId, 900);
  });

  try {
    const dataDir = getPluginDataDir();
    const w = watch(dataDir, { persistent: false }, (_ev, fname) => {
      if (!fname || String(fname).startsWith('last_active_room.json')) {
        const live = getGlobalLiveDiscussion();
        if (live?.roomId && live.status === 'idle') {
          scheduleSync(live.roomId, 700);
        }
      }
    });
    w.on('error', () => {});
  } catch {}

  // Startup sweep: reconcile Codex Desktop catalog DB & mirror completed discussions into Antigravity folders!
  const bootTimer = setTimeout(async () => {
    try {
      backfillCodexDesktopCatalog({ limit: 80 });
    } catch {}
    try {
      const rooms = listRecentRooms(15);
      for (const r of rooms) {
        if (!r.conversationId.startsWith('codex_')) {
          await syncRoomToAntigravityFolder(r.conversationId);
        }
      }
    } catch {}
  }, 1200);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();
}

if (process.env.CODEX_BRIDGE_TEST_MODE !== '1') {
  const { app } = buildSidecarApp();
  app.run().then(() => {
    startBackgroundFolderMirrorDaemon();
  });
}
