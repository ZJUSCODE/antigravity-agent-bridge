/**
 * Enterprise Antigravity ↔ Codex Native Aux-Pane Sidecar Backend.
 * Powered by persistent `codex app-server --stdio` (AppServerBridge),
 * event-driven long-polling (`waitForRoomChange`), and Dual-AI Orchestration.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  addCustomProject,
  appendMessage,
  assertValidExplicitRoomId,
  createNewRoom,
  deleteRoom,
  exportRoomMarkdown,
  findCodexBinary,
  getActiveRoomForHost,
  getPluginDataDir,
  getProjectThreadTree,
  getRoomSnapshot,
  importNativeCodexSession,
  listAvailableProjects,
  listCodexModels,
  listNativeCodexSessions,
  listRecentRooms,
  registerInProcessBusyChecker,
  removeUploadedFile,
  renameRoom,
  resetCodexThread,
  resolveSafeUploadPath,
  sanitizeClientAttachments,
  sanitizeConvId,
  saveUploadedFile,
  setActiveRoomForHost,
  switchToProject,
  togglePinRoom,
  waitForRoomChange,
  writeMeta,
} from './codex_core.mjs';
import { AppServerBridge } from './app_server_bridge.mjs';

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
    return {
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
      model: data.model || 'gpt-6.2-astra',
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
    const uiVersion = getUiVersion();
    const fullEtag = `${snap.etag}:${uiVersion}`;
    if (data.etag && data.etag === fullEtag) {
      return { conversationId: roomId, unchanged: true, etag: fullEtag, uiVersion };
    }
    return { ...snap, etag: fullEtag, uiVersion };
  }, 'GET');

  app.api('/api/settings', (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const patch = {};
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
    const rounds = Number(data.rounds) || 2;
    const verifiedAttachments = sanitizeClientAttachments(roomId, data.attachments);
    if (!topic && verifiedAttachments.length === 0) {
      throw new Error('请输入讨论议题或添加有效附件。');
    }
    appendMessage(roomId, {
      sender: 'user',
      senderLabel: '你（发起议题）',
      text: `${topic || '请分析附件内容'}（双 AI 自动讨论 ${rounds} 轮）`,
      attachments: verifiedAttachments,
    });
    writeMeta(roomId, { lastError: null });
    return { ok: true, roomId, verifiedAttachments };
  }, 'POST');

  app.api('/api/ask-codex', async (data) => {
    const roomId = resolveRoomId(data, app.config.conversationId);
    const verifiedAttachments = sanitizeClientAttachments(roomId, data.attachments);
    const prompt = String(data.prompt || '').trim();
    if (!prompt && verifiedAttachments.length === 0) {
      throw new Error('请输入内容或添加有效附件。');
    }

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
  }, 'POST');

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

  return { app, bridge };
}

if (process.env.CODEX_BRIDGE_TEST_MODE !== '1') {
  const { app } = buildSidecarApp();
  app.run();
}
