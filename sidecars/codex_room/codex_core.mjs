/**
 * Hardened Enterprise Storage, Cross-Process Locking, SQLite Index & Peer Execution Core (`codex-bridge` v3.1).
 *
 * Hardening highlights:
 * - Cross-process exclusive file locking (`withRoomFileLockSync`) with PID-liveness stale lock recovery
 * - Safe atomic NTFS metadata persistence (`flush: true` + bounded retry, zero destructive overwrite fallback)
 * - Bounded LRU caches (`metaCache`, `messagesCache`), self-cleaning write queues & demand-driven idle-closing `fs.watch`
 * - PID-alive + heartbeat turn leases (`acquireRoomTurnLease` / `isExternalOwnerAlive`) & epoch-guarded cancellation
 * - Symlink/junction-safe attachment resolution (`realpathSync` + `lstatSync`) & server-side attachment sanitization
 * - Private non-served spill directory for large peer prompts + collision-free `wx` Markdown export
 */
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const CONV_ID_RE = /^[a-z0-9_.-]{4,100}$/i;
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{13,55}$/i;
const STALE_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
const WATCHER_IDLE_TTL_MS = 30 * 1000;
const MAX_CACHE_ROOMS = 60;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_B64_CHARS = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 512;

export const roomEvents = new EventEmitter();
roomEvents.setMaxListeners(200);

// Bounded LRU caches & lifecycle maps
const metaCache = new Map();      // safeConv -> { mtimeMs, size, data }
const messagesCache = new Map();  // safeConv -> { mtimeMs, size, data }
const roomWatchers = new Map();   // safeConv -> { watcher, refCount, idleTimer }
const writeQueues = new Map();    // safeConv -> Promise
let activeInProcessCheck = () => false;

function lruSet(map, key, val) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > MAX_CACHE_ROOMS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function registerInProcessBusyChecker(fn) {
  if (typeof fn === 'function') activeInProcessCheck = fn;
}

export function closeAllRoomWatchers() {
  for (const [, entry] of roomWatchers) {
    clearTimeout(entry.idleTimer);
    try { entry.watcher.close(); } catch {}
  }
  roomWatchers.clear();
}

export function resetCoreCaches() {
  closeAllRoomWatchers();
  metaCache.clear();
  messagesCache.clear();
  stateDbCache = { key: '', ts: 0, value: { projects: [], threads: [] } };
}

process.once('exit', () => {
  closeAllRoomWatchers();
});

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function stripWinPrefix(p) {
  return String(p || '').trim().replace(/^\\\\\?\\/, '');
}

export function normalizeDirPath(p) {
  const clean = stripWinPrefix(p);
  if (!clean) return '';
  try {
    return resolve(clean);
  } catch {
    return clean;
  }
}

export function getBrainRoot() {
  const appData = process.env.ANTIGRAVITY_APP_DATA_DIR
    || join(homedir(), '.gemini', 'antigravity');
  return join(appData, 'brain');
}

export function getCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function getPluginDataDir() {
  const dir = process.env.CODEX_BRIDGE_DATA_DIR
    || join(homedir(), '.gemini', 'config', 'plugins', 'codex-bridge', '.data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createIsolatedPromptSpillDir() {
  const root = join(getPluginDataDir(), 'tmp_prompts');
  mkdirSync(root, { recursive: true });
  // Sweep only orphaned subdirectories whose owner PID has already exited
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      const sub = join(root, d.name);
      try {
        if (!d.isDirectory()) {
          rmSync(sub, { force: true });
          continue;
        }
        const m = /^turn_(\d+)_/.exec(d.name);
        const ownerPid = m ? Number(m[1]) : 0;
        if (!ownerPid || !isPidAlive(ownerPid)) {
          rmSync(sub, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
  const turnDir = join(root, `turn_${process.pid}_${Date.now()}_${randomUUID().slice(0, 6)}`);
  mkdirSync(turnDir, { recursive: true });
  return turnDir;
}

export function getDefaultOutputsDir() {
  const eRoot = 'E:\\';
  if (process.platform === 'win32' && existsSync(eRoot)) {
    const out = 'E:\\Antigravity\\Outputs\\Codex-Room';
    mkdirSync(out, { recursive: true });
    return out;
  }
  const fallback = join(getPluginDataDir(), 'exports');
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

export function isValidExplicitRoomId(convId) {
  const s = String(convId || '').trim();
  return Boolean(s && s !== 'auto' && CONV_ID_RE.test(s));
}

export function assertValidExplicitRoomId(convId) {
  const s = String(convId || '').trim();
  if (!isValidExplicitRoomId(s)) {
    throw new Error(`无效的目标会话 ID: ${String(convId || '(空)')}`);
  }
  return s;
}

export function sanitizeConvId(convId) {
  const s = String(convId || '').trim();
  return CONV_ID_RE.test(s) ? s : 'global-default';
}

export function getRoomDir(convId) {
  const safe = sanitizeConvId(convId);
  return join(getBrainRoot(), safe, '.codex_room');
}

export function ensureRoomDir(convId) {
  const safe = sanitizeConvId(convId);
  const dir = getRoomDir(safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureUploadsDir(convId) {
  const dir = join(ensureRoomDir(convId), 'uploads');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function retainDirWatcher(safeConv) {
  const dirPath = getRoomDir(safeConv);
  if (!existsSync(dirPath)) return () => {};

  let entry = roomWatchers.get(safeConv);
  if (!entry) {
    try {
      const watcher = watch(dirPath, { persistent: false }, () => {
        roomEvents.emit(`change:${safeConv}`);
      });
      watcher.on('error', () => {
        const cur = roomWatchers.get(safeConv);
        if (cur) {
          clearTimeout(cur.idleTimer);
          roomWatchers.delete(safeConv);
        }
        try { watcher.close(); } catch {}
      });
      entry = { watcher, refCount: 0, idleTimer: null };
      roomWatchers.set(safeConv, entry);
    } catch {
      return () => {};
    }
  }

  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  entry.refCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = roomWatchers.get(safeConv);
    if (!cur) return;
    cur.refCount = Math.max(0, cur.refCount - 1);
    if (cur.refCount === 0) {
      clearTimeout(cur.idleTimer);
      cur.idleTimer = setTimeout(() => {
        const latest = roomWatchers.get(safeConv);
        if (latest && latest.refCount === 0) {
          try { latest.watcher.close(); } catch {}
          roomWatchers.delete(safeConv);
        }
      }, WATCHER_IDLE_TTL_MS);
      if (typeof cur.idleTimer.unref === 'function') cur.idleTimer.unref();
    }
  };
}

function notifyRoomChanged(safeConv) {
  roomEvents.emit(`change:${safeConv}`);
}

function enqueueWrite(safeConv, fn) {
  const prev = writeQueues.get(safeConv) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.catch(() => {}).finally(() => {
    if (writeQueues.get(safeConv) === tracked) {
      writeQueues.delete(safeConv);
    }
  });
  writeQueues.set(safeConv, tracked);
  return next;
}

function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin fallback */ }
  }
}

/**
 * Owner-verified cross-process exclusive lock (`<dirPath>/.room.lock`).
 * - Never steals a lock held by a live PID.
 * - Recovers crashed/unpopulated lock files safely.
 * - Releases in `finally` ONLY if the lock token still belongs to this invocation.
 */
function withRoomFileLockSync(dirPath, fn) {
  mkdirSync(dirPath, { recursive: true });
  const lockPath = join(dirPath, '.room.lock');
  const ownerToken = `${process.pid}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  let acquired = false;

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      writeFileSync(lockPath, ownerToken, { encoding: 'utf-8', flag: 'wx', flush: true });
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const st = statSync(lockPath);
        const raw = readFileSync(lockPath, 'utf-8').trim();
        const [pidStr] = raw.split(':');
        const holderPid = Number(pidStr);
        if (holderPid > 0) {
          if (!isPidAlive(holderPid)) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } else if (Date.now() - st.mtimeMs > 3000) {
          // Empty/corrupted lock file from a process killed mid-create >3s ago
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(Math.min(45, 4 + attempt * 2));
    }
  }

  if (!acquired) {
    throw new Error('房间存储锁繁忙，请稍后重试');
  }

  try {
    return fn();
  } finally {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, 'utf-8').trim() === ownerToken) {
        rmSync(lockPath, { force: true });
      }
    } catch {}
  }
}

/**
 * Safe atomic JSON replacement: flushes temp file in same directory, retries transient
 * NTFS rename contention, and NEVER truncates the destination file on failure.
 */
function writeJsonAtomicSync(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true });
  const text = JSON.stringify(obj, null, 2);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  writeFileSync(tmpPath, text, { encoding: 'utf-8', flush: true });

  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmpPath, filePath);
      try { writeFileSync(`${filePath}.bak`, text, 'utf-8'); } catch {}
      return;
    } catch (err) {
      lastErr = err;
      if (err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EBUSY') {
        sleepSync(8 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  try { rmSync(tmpPath, { force: true }); } catch {}
  throw lastErr || new Error(`原子写入失败: ${filePath}`);
}

function readJsonWithBackupSync(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (primaryErr) {
    const bakPath = `${filePath}.bak`;
    if (existsSync(bakPath)) {
      try {
        return JSON.parse(readFileSync(bakPath, 'utf-8'));
      } catch {}
    }
    throw primaryErr;
  }
}

let cachedBinaryInfo = null;
let cachedBinaryCheckedAt = 0;

function parseWinAppsCodexVersion(dirName) {
  const verStr = String(dirName || '').replace(/^OpenAI\.Codex_/, '').split('_')[0] || '';
  return verStr.split('.').map((n) => parseInt(n, 10) || 0);
}

function compareVerTuplesDesc(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (b[i] || 0) - (a[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function findCodexBinary() {
  if (cachedBinaryInfo && Date.now() - cachedBinaryCheckedAt < 30000 && existsSync(cachedBinaryInfo.exe)) {
    return cachedBinaryInfo;
  }

  // 1. Explicit CODEX_BIN override
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) {
    cachedBinaryInfo = {
      exe: process.env.CODEX_BIN,
      extraPathDirs: [dirname(process.env.CODEX_BIN)],
    };
    cachedBinaryCheckedAt = Date.now();
    return cachedBinaryInfo;
  }

  // 2. Newest WindowsApps OpenAI.Codex_*\app\resources\codex.exe
  if (process.platform === 'win32') {
    const winApps = 'C:\\Program Files\\WindowsApps';
    const winAppCandidates = [];
    try {
      if (existsSync(winApps)) {
        for (const d of readdirSync(winApps)) {
          if (!d.startsWith('OpenAI.Codex_')) continue;
          const exePath = join(winApps, d, 'app', 'resources', 'codex.exe');
          if (existsSync(exePath)) {
            let mtimeMs = 0;
            try { mtimeMs = statSync(exePath).mtimeMs; } catch {}
            winAppCandidates.push({
              exePath,
              ver: parseWinAppsCodexVersion(d),
              mtimeMs,
            });
          }
        }
      }
    } catch {
      // Standard user tokens may get EPERM on WindowsApps scandir; fallback to Get-AppxPackage
      try {
        const loc = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-Command', "(Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
        ).trim();
        if (loc) {
          const exePath = join(loc, 'app', 'resources', 'codex.exe');
          if (existsSync(exePath)) {
            winAppCandidates.push({ exePath, ver: [999], mtimeMs: Date.now() });
          }
        }
      } catch {}
    }
    if (winAppCandidates.length > 0) {
      winAppCandidates.sort((a, b) => compareVerTuplesDesc(a.ver, b.ver) || (b.mtimeMs - a.mtimeMs));
      const best = winAppCandidates[0].exePath;
      cachedBinaryInfo = { exe: best, extraPathDirs: [dirname(best)] };
      cachedBinaryCheckedAt = Date.now();
      return cachedBinaryInfo;
    }
  }

  // 3. Newest %LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const codexBinRoot = join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (existsSync(codexBinRoot)) {
    const extraPathDirs = [];
    const candidates = [];
    for (const entry of readdirSync(codexBinRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subDir = join(codexBinRoot, entry.name);
      extraPathDirs.push(subDir);
      const exePath = join(subDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
      if (existsSync(exePath)) {
        try {
          candidates.push({ exePath, mtimeMs: statSync(exePath).mtimeMs });
        } catch {
          candidates.push({ exePath, mtimeMs: 0 });
        }
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      cachedBinaryInfo = { exe: candidates[0].exePath, extraPathDirs };
      cachedBinaryCheckedAt = Date.now();
      return cachedBinaryInfo;
    }
  }

  // 4. PATH
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(cmd, ['codex'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l));
    if (first) {
      cachedBinaryInfo = { exe: first, extraPathDirs: [dirname(first)] };
      cachedBinaryCheckedAt = Date.now();
      return cachedBinaryInfo;
    }
  } catch {}

  // 5. Fallback .sandbox-bin
  const sandboxBin = join(getCodexHome(), '.sandbox-bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (existsSync(sandboxBin)) {
    cachedBinaryInfo = { exe: sandboxBin, extraPathDirs: [dirname(sandboxBin)] };
    cachedBinaryCheckedAt = Date.now();
    return cachedBinaryInfo;
  }

  throw new Error('未找到本地 codex 可执行文件，请确认已安装 OpenAI Codex。');
}

export function getActiveRoomForHost(hostConvId) {
  const mapFile = join(getPluginDataDir(), 'host_room_map.json');
  const safeHost = sanitizeConvId(hostConvId);
  if (existsSync(mapFile)) {
    try {
      const map = readJsonWithBackupSync(mapFile) || {};
      if (map[safeHost] && CONV_ID_RE.test(map[safeHost])) {
        return map[safeHost];
      }
    } catch {}
  }
  return safeHost;
}

export function setActiveRoomForHost(hostConvId, targetRoomId) {
  const dataDir = getPluginDataDir();
  const mapFile = join(dataDir, 'host_room_map.json');
  const safeHost = sanitizeConvId(hostConvId);
  const safeTarget = assertValidExplicitRoomId(targetRoomId);
  withRoomFileLockSync(dataDir, () => {
    const map = readJsonWithBackupSync(mapFile) || {};
    map[safeHost] = safeTarget;
    writeJsonAtomicSync(mapFile, map);
  });
  return safeTarget;
}

function buildFallbackMeta(safeConv) {
  return {
    conversationId: safeConv,
    rev: 0,
    roomEpoch: 1,
    title: '新对话',
    pinned: false,
    messageCount: null,
    importCompleted: false,
    importSourceSessionId: null,
    codexThreadId: null,
    agyConversationId: null,
    needsForkOnNextTurn: false,
    forkFromSessionId: null,
    model: 'gpt-6.2-astra',
    effort: 'medium',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    mode: 'dual-2',
    cwd: null,
    status: 'idle',
    turnLease: null,
    activeTurn: null,
    tokenUsage: null,
    rateLimitPercent: null,
    cancelRequestedAt: 0,
    lastError: null,
    updatedAt: 0,
  };
}

/**
 * Checks whether a room has a live owner process holding an active turn lease.
 */
export function isExternalOwnerAlive(meta) {
  if (!meta || (meta.status !== 'thinking' && meta.status !== 'awaiting_approval')) {
    return false;
  }
  const lease = meta.turnLease;
  if (lease?.ownerPid) {
    if (!isPidAlive(lease.ownerPid)) return false;
    const hb = Number(lease.heartbeatAt) || Number(meta.updatedAt) || 0;
    return hb > 0 && Date.now() - hb <= STALE_TURN_TIMEOUT_MS;
  }
  return meta.updatedAt > 0 && Date.now() - meta.updatedAt <= STALE_TURN_TIMEOUT_MS;
}

export function acquireRoomTurnLease(convId, source = 'cli') {
  const safeConv = sanitizeConvId(convId);
  const dir = ensureRoomDir(safeConv);
  const leaseId = `lease_${process.pid}_${Date.now()}_${randomUUID().slice(0, 6)}`;

  const meta = withRoomFileLockSync(dir, () => {
    const metaPath = join(dir, 'meta.json');
    const current = readJsonWithBackupSync(metaPath) || {};
    const merged = { ...buildFallbackMeta(safeConv), ...current };

    const busyInProc = activeInProcessCheck(safeConv);
    const busyCrossProc = isExternalOwnerAlive(merged);
    if (busyInProc || busyCrossProc) {
      throw new Error('当前对话正在执行中，请等待完成或点击停止。');
    }

    const now = Date.now();
    const prevUpdated = Number(merged.updatedAt) || 0;
    const next = {
      ...merged,
      conversationId: safeConv,
      status: 'thinking',
      turnLease: {
        leaseId,
        ownerPid: process.pid,
        source,
        startedAt: now,
        heartbeatAt: now,
      },
      lastError: null,
      rev: (Number(merged.rev) || 0) + 1,
      updatedAt: now > prevUpdated ? now : prevUpdated + 1,
    };
    if (next.cwd) next.cwd = normalizeDirPath(next.cwd);
    writeJsonAtomicSync(metaPath, next);
    try {
      const st = statSync(metaPath);
      lruSet(metaCache, safeConv, { mtimeMs: st.mtimeMs, size: st.size, data: next });
    } catch {
      metaCache.delete(safeConv);
    }
    return next;
  });

  notifyRoomChanged(safeConv);
  return { leaseId, roomEpoch: meta.roomEpoch || 1, meta };
}

export function heartbeatRoomTurnLease(convId, leaseId) {
  const safeConv = sanitizeConvId(convId);
  const dir = getRoomDir(safeConv);
  if (!existsSync(dir)) return false;
  let updated = false;
  try {
    withRoomFileLockSync(dir, () => {
      const metaPath = join(dir, 'meta.json');
      if (!existsSync(metaPath)) return;
      const cur = readJsonWithBackupSync(metaPath);
      if (!cur || cur.turnLease?.leaseId !== leaseId) return;
      const now = Date.now();
      cur.turnLease = { ...cur.turnLease, heartbeatAt: now };
      cur.rev = (Number(cur.rev) || 0) + 1;
      cur.updatedAt = Math.max(now, (Number(cur.updatedAt) || 0) + 1);
      writeJsonAtomicSync(metaPath, cur);
      try {
        const st = statSync(metaPath);
        lruSet(metaCache, safeConv, { mtimeMs: st.mtimeMs, size: st.size, data: cur });
      } catch {
        metaCache.delete(safeConv);
      }
      updated = true;
    });
  } catch {}
  if (updated) notifyRoomChanged(safeConv);
  return updated;
}

export function releaseRoomTurnLease(convId, leaseId, finalPatch = {}) {
  const safeConv = sanitizeConvId(convId);
  const dir = getRoomDir(safeConv);
  if (!existsSync(dir)) return null;
  let result = null;
  withRoomFileLockSync(dir, () => {
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) return;
    const cur = readJsonWithBackupSync(metaPath);
    if (!cur || cur.turnLease?.leaseId !== leaseId) return;
    const now = Date.now();
    const next = {
      ...buildFallbackMeta(safeConv),
      ...cur,
      ...finalPatch,
      conversationId: safeConv,
      turnLease: null,
      rev: (Number(cur.rev) || 0) + 1,
      updatedAt: Math.max(now, (Number(cur.updatedAt) || 0) + 1),
    };
    if (next.cwd) next.cwd = normalizeDirPath(next.cwd);
    writeJsonAtomicSync(metaPath, next);
    try {
      const st = statSync(metaPath);
      lruSet(metaCache, safeConv, { mtimeMs: st.mtimeMs, size: st.size, data: next });
    } catch {
      metaCache.delete(safeConv);
    }
    result = next;
  });
  if (result) notifyRoomChanged(safeConv);
  return result;
}

export function readMeta(convId) {
  const safeConv = sanitizeConvId(convId);
  const dir = getRoomDir(safeConv);
  const metaPath = join(dir, 'meta.json');
  const fallback = buildFallbackMeta(safeConv);
  if (!existsSync(metaPath)) return fallback;

  try {
    const st = statSync(metaPath);
    const hit = metaCache.get(safeConv);
    let data;
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      data = hit.data;
    } else {
      const parsed = readJsonWithBackupSync(metaPath);
      if (!parsed) return fallback;
      if (parsed.cwd) parsed.cwd = normalizeDirPath(parsed.cwd);
      data = { ...fallback, ...parsed, conversationId: safeConv };
      lruSet(metaCache, safeConv, { mtimeMs: st.mtimeMs, size: st.size, data });
    }

    // Stale / Dead-Owner Watchdog (re-verifies stale leaseId inside lock so a newly acquired lease is NEVER clobbered!)
    if (
      (data.status === 'thinking' || data.status === 'awaiting_approval') &&
      !activeInProcessCheck(safeConv) &&
      !isExternalOwnerAlive(data)
    ) {
      const staleLeaseId = data.turnLease?.leaseId ?? null;
      let recovered = null;
      withRoomFileLockSync(dir, () => {
        const fresh = readJsonWithBackupSync(metaPath);
        if (!fresh) return;
        const curMerged = { ...fallback, ...fresh, conversationId: safeConv };
        const curLeaseId = curMerged.turnLease?.leaseId ?? null;
        if (
          curLeaseId === staleLeaseId &&
          (curMerged.status === 'thinking' || curMerged.status === 'awaiting_approval') &&
          !isExternalOwnerAlive(curMerged)
        ) {
          const now = Date.now();
          recovered = {
            ...curMerged,
            status: 'idle',
            turnLease: null,
            activeTurn: null,
            lastError: '上一次后台对话已超时或进程退出，已自动恢复就绪',
            rev: (Number(curMerged.rev) || 0) + 1,
            updatedAt: Math.max(now, (Number(curMerged.updatedAt) || 0) + 1),
          };
          writeJsonAtomicSync(metaPath, recovered);
          try {
            const mst = statSync(metaPath);
            lruSet(metaCache, safeConv, { mtimeMs: mst.mtimeMs, size: mst.size, data: recovered });
          } catch {
            metaCache.delete(safeConv);
          }
        }
      });
      if (recovered) {
        notifyRoomChanged(safeConv);
        return recovered;
      }
    }
    return data;
  } catch {
    return metaCache.get(safeConv)?.data || fallback;
  }
}

export function writeMeta(convId, patch, { expectedEpoch = null, expectedLeaseId = null, requireExists = false } = {}) {
  const safeConv = sanitizeConvId(convId);
  const dir = getRoomDir(safeConv);
  if (requireExists && !existsSync(dir)) return null;
  ensureRoomDir(safeConv);

  let next = null;
  withRoomFileLockSync(dir, () => {
    const metaPath = join(dir, 'meta.json');
    if ((requireExists || expectedEpoch !== null || expectedLeaseId !== null) && !existsSync(metaPath)) return;
    const current = readJsonWithBackupSync(metaPath) || {};
    if (expectedEpoch !== null && (current.roomEpoch || 1) !== expectedEpoch) {
      return;
    }
    if (expectedLeaseId !== null && current.turnLease?.leaseId !== expectedLeaseId) {
      return;
    }

    const now = Date.now();
    const prevUpdated = Number(current.updatedAt) || 0;
    const mergedLease = ('turnLease' in patch)
      ? patch.turnLease
      : (current.turnLease ? { ...current.turnLease, heartbeatAt: now } : null);

    next = {
      ...buildFallbackMeta(safeConv),
      ...current,
      ...patch,
      turnLease: mergedLease,
      conversationId: safeConv,
      rev: (Number(current.rev) || 0) + 1,
      updatedAt: now > prevUpdated ? now : prevUpdated + 1,
    };
    if (next.cwd) next.cwd = normalizeDirPath(next.cwd);

    writeJsonAtomicSync(metaPath, next);
    try {
      const st = statSync(metaPath);
      lruSet(metaCache, safeConv, { mtimeMs: st.mtimeMs, size: st.size, data: next });
    } catch {
      metaCache.delete(safeConv);
    }
  });

  if (next) notifyRoomChanged(safeConv);
  return next;
}

export function readMessages(convId) {
  const safeConv = sanitizeConvId(convId);
  const dir = getRoomDir(safeConv);
  const msgPath = join(dir, 'messages.jsonl');
  if (!existsSync(msgPath)) return [];

  try {
    const st = statSync(msgPath);
    const hit = messagesCache.get(safeConv);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit.data;
    }

    const raw = readFileSync(msgPath, 'utf-8');
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { out.push(JSON.parse(trimmed)); } catch {}
    }
    lruSet(messagesCache, safeConv, { mtimeMs: st.mtimeMs, size: st.size, data: out });
    return out;
  } catch {
    return [];
  }
}

export function appendMessage(convId, msg, { expectedEpoch = null, expectedLeaseId = null, requireExists = false } = {}) {
  const safeConv = sanitizeConvId(convId);
  const dir = getRoomDir(safeConv);
  if (requireExists && !existsSync(dir)) return null;
  ensureRoomDir(safeConv);

  let entry = null;
  withRoomFileLockSync(dir, () => {
    const metaPath = join(dir, 'meta.json');
    if ((requireExists || expectedEpoch !== null || expectedLeaseId !== null) && !existsSync(metaPath)) return;
    const curMeta = readJsonWithBackupSync(metaPath) || {};
    if (expectedEpoch !== null && (curMeta.roomEpoch || 1) !== expectedEpoch) {
      return;
    }
    if (expectedLeaseId !== null && curMeta.turnLease?.leaseId !== expectedLeaseId) {
      return;
    }

    const msgPath = join(dir, 'messages.jsonl');
    const existing = readMessages(safeConv);
    const seq = existing.length > 0 ? (Number(existing[existing.length - 1].seq) || existing.length) + 1 : 1;

    entry = {
      id: msg.id || `msg_${randomUUID().slice(0, 12)}`,
      seq,
      ts: msg.ts || new Date().toISOString(),
      sender: msg.sender || 'antigravity',
      senderLabel: msg.senderLabel || (msg.sender === 'codex' ? 'Codex' : msg.sender === 'user' ? '你' : 'Antigravity'),
      text: String(msg.text || ''),
      attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
      diff: msg.diff ? String(msg.diff) : '',
      reasoningSummary: msg.reasoningSummary ? String(msg.reasoningSummary) : '',
      plan: Array.isArray(msg.plan) ? msg.plan : [],
      codexThreadId: msg.codexThreadId || null,
      model: msg.model || null,
      effort: msg.effort || null,
      durationMs: msg.durationMs ?? null,
      tokenCount: msg.tokenCount ?? null,
      steps: Array.isArray(msg.steps) ? msg.steps : [],
    };

    const preSize = existsSync(msgPath) ? statSync(msgPath).size : 0;
    const serialized = JSON.stringify(entry) + '\n';
    appendFileSync(msgPath, serialized, 'utf-8');

    try {
      const st = statSync(msgPath);
      const expectedSize = preSize + Buffer.byteLength(serialized, 'utf-8');
      if (st.size === expectedSize) {
        lruSet(messagesCache, safeConv, { mtimeMs: st.mtimeMs, size: st.size, data: [...existing, entry] });
      } else {
        messagesCache.delete(safeConv);
      }
    } catch {
      messagesCache.delete(safeConv);
    }

    const now = Date.now();
    const prevUpdated = Number(curMeta.updatedAt) || 0;
    let nextTitle = curMeta.title || '新对话';
    if ((!nextTitle || nextTitle === '新对话' || nextTitle === 'Antigravity ↔ Codex 对讲室') && entry.text && entry.sender !== 'system') {
      const cleanTitle = entry.text
        .replace(/^\*\*\[[^\]]+\]\*\*\s*/, '')
        .replace(/\s+/g, ' ')
        .replace(/（.*?讨论 \d+ 轮）$/, '')
        .trim()
        .slice(0, 36);
      if (cleanTitle) nextTitle = cleanTitle;
    }

    const nextMeta = {
      ...buildFallbackMeta(safeConv),
      ...curMeta,
      conversationId: safeConv,
      title: nextTitle,
      messageCount: existing.length + 1,
      rev: (Number(curMeta.rev) || 0) + 1,
      updatedAt: now > prevUpdated ? now : prevUpdated + 1,
    };
    if (nextMeta.cwd) nextMeta.cwd = normalizeDirPath(nextMeta.cwd);
    writeJsonAtomicSync(metaPath, nextMeta);
    try {
      const mst = statSync(metaPath);
      lruSet(metaCache, safeConv, { mtimeMs: mst.mtimeMs, size: mst.size, data: nextMeta });
    } catch {
      metaCache.delete(safeConv);
    }
  });

  if (entry) notifyRoomChanged(safeConv);
  return entry;
}

export function getRoomSnapshot(convId) {
  const safeConv = sanitizeConvId(convId);
  ensureRoomDir(safeConv);
  const meta = readMeta(safeConv);
  const messages = readMessages(safeConv);
  const lastSeq = messages.length ? messages[messages.length - 1].seq : 0;
  const activeKey = meta.activeTurn
    ? [
        meta.activeTurn.liveStatus || '',
        (meta.activeTurn.streamingText || '').length,
        (meta.activeTurn.reasoningSummary || '').length,
        (meta.activeTurn.liveCommandOutput || '').length,
        (meta.activeTurn.diff || '').length,
        (meta.activeTurn.steps || []).length,
        (meta.activeTurn.plan || []).length,
        (meta.activeTurn.pendingApprovals || []).map((p) => String(p.rpcId)).join(','),
      ].join('|')
    : 'idle';
  const etag = `${safeConv}:${meta.rev || 0}:${meta.roomEpoch || 1}:${meta.status}:${meta.title}:${meta.pinned ? 1 : 0}:${meta.model}:${meta.effort}:${meta.approvalPolicy}:${meta.mode}:${meta.cwd || ''}:${meta.codexThreadId || 'none'}:${lastSeq}:${activeKey}:${meta.updatedAt}`;
  return {
    conversationId: safeConv,
    meta,
    messages,
    etag,
  };
}

export async function waitForRoomChange(convId, clientEtag, getUiVersionFn, timeoutMs = 8000) {
  const safeConv = sanitizeConvId(convId);
  ensureRoomDir(safeConv);

  const buildFullSnap = () => {
    const snap = getRoomSnapshot(safeConv);
    const uiVersion = getUiVersionFn ? getUiVersionFn() : '1';
    const fullEtag = `${snap.etag}:${uiVersion}`;
    return { snap, uiVersion, fullEtag };
  };

  const initial = buildFullSnap();
  if (!clientEtag || initial.fullEtag !== clientEtag) {
    return { ...initial.snap, etag: initial.fullEtag, uiVersion: initial.uiVersion };
  }

  const releaseWatcher = retainDirWatcher(safeConv);
  const clampedMs = Math.min(12000, Math.max(500, Number(timeoutMs) || 8000));
  try {
    await new Promise((resolveWait) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        roomEvents.off(`change:${safeConv}`, onEvent);
        resolveWait();
      };
      const onEvent = () => {
        const cur = buildFullSnap();
        if (cur.fullEtag !== clientEtag) finish();
      };
      const timer = setTimeout(finish, clampedMs);
      roomEvents.on(`change:${safeConv}`, onEvent);
    });
  } finally {
    releaseWatcher();
  }

  const after = buildFullSnap();
  if (clientEtag && after.fullEtag === clientEtag) {
    return { conversationId: safeConv, unchanged: true, etag: after.fullEtag, uiVersion: after.uiVersion };
  }
  return { ...after.snap, etag: after.fullEtag, uiVersion: after.uiVersion };
}

export function createNewRoom({ cwd, model, effort, mode, approvalPolicy } = {}) {
  const roomId = `thread_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  return writeMeta(roomId, {
    title: '新对话',
    pinned: false,
    messageCount: 0,
    codexThreadId: null,
    agyConversationId: null,
    needsForkOnNextTurn: false,
    forkFromSessionId: null,
    model: model || 'gpt-6.2-astra',
    effort: effort || 'medium',
    approvalPolicy: approvalPolicy || 'on-request',
    mode: mode || 'dual-2',
    cwd: cwd ? normalizeDirPath(cwd) : null,
    status: 'idle',
    turnLease: null,
    activeTurn: null,
    lastError: null,
  });
}

export function renameRoom(convId, newTitle) {
  const safe = assertValidExplicitRoomId(convId);
  const clean = String(newTitle || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) throw new Error('标题不能为空');
  return writeMeta(safe, { title: clean });
}

export function togglePinRoom(convId) {
  const safe = assertValidExplicitRoomId(convId);
  const cur = readMeta(safe);
  return writeMeta(safe, { pinned: !cur.pinned });
}

export function deleteRoom(convId) {
  const safe = assertValidExplicitRoomId(convId);
  const w = roomWatchers.get(safe);
  if (w) {
    clearTimeout(w.idleTimer);
    try { w.watcher.close(); } catch {}
    roomWatchers.delete(safe);
  }
  metaCache.delete(safe);
  messagesCache.delete(safe);

  const dir = getRoomDir(safe);
  if (existsSync(dir)) {
    // Signal any external CLI watching this room before deleting directory
    try {
      writeMeta(safe, {
        roomEpoch: (readMeta(safe).roomEpoch || 1) + 1,
        cancelRequestedAt: Date.now(),
        status: 'idle',
        turnLease: null,
        activeTurn: null,
      });
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
  return { deleted: safe };
}

export function listRecentRooms(limit = 80) {
  const brain = getBrainRoot();
  if (!existsSync(brain)) return [];
  const candidates = [];

  for (const entry of readdirSync(brain, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(brain, entry.name, '.codex_room', 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = readMeta(entry.name);
      candidates.push({ name: entry.name, meta });
    } catch {}
  }

  candidates.sort((a, b) => {
    if (Boolean(a.meta.pinned) !== Boolean(b.meta.pinned)) return a.meta.pinned ? -1 : 1;
    return (b.meta.updatedAt || 0) - (a.meta.updatedAt || 0);
  });

  const rooms = [];
  for (const { name, meta } of candidates.slice(0, limit)) {
    try {
      let msgCount = typeof meta.messageCount === 'number' && meta.messageCount >= 0
        ? meta.messageCount
        : readMessages(name).length;
      let title = meta.title || '';
      if (!title || title === 'Antigravity ↔ Codex 对讲室') {
        const msgs = readMessages(name);
        msgCount = msgs.length;
        const firstMsg = msgs.find((m) => m.sender !== 'system' && m.text);
        title = firstMsg ? String(firstMsg.text).replace(/\s+/g, ' ').slice(0, 34) : '新对话';
      }
      const normCwd = meta.cwd ? normalizeDirPath(meta.cwd) : null;
      const isInternalScratch = normCwd && normCwd.toLowerCase().includes('\\.gemini\\antigravity\\brain\\');
      rooms.push({
        conversationId: name,
        title,
        pinned: Boolean(meta.pinned),
        codexThreadId: meta.codexThreadId || null,
        importSourceSessionId: meta.importSourceSessionId || null,
        forkFromSessionId: meta.forkFromSessionId || null,
        cwd: isInternalScratch ? null : normCwd,
        projectName: (!isInternalScratch && normCwd) ? basename(normCwd) : null,
        model: meta.model || 'gpt-6.2-astra',
        status: meta.status || 'idle',
        messageCount: msgCount,
        updatedAt: meta.updatedAt || 0,
      });
    } catch {}
  }
  return rooms;
}

// ---------------------------------------------------------------------------
// Cached WAL-aware Read-Only `state_5.sqlite` Indexer
// ---------------------------------------------------------------------------
let stateDbCache = { key: '', ts: 0, value: { projects: [], threads: [] } };

function cleanThreadTitle(name, rawTitle) {
  if (name && String(name).trim()) return String(name).trim();
  let t = String(rawTitle || '').trim();
  const reqIdx = t.indexOf('## My request:');
  if (reqIdx !== -1) t = t.slice(reqIdx + '## My request:'.length).trim();
  t = t.replace(/^\[([^\]]+)\]\([^)]+\)\s*/, '$1 ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 44) || '未命名对话';
}

export function queryCodexStateDb() {
  const dbPath = join(getCodexHome(), 'state_5.sqlite');
  if (!existsSync(dbPath)) return { projects: [], threads: [] };

  try {
    const mainMtime = statSync(dbPath).mtimeMs;
    const walPath = `${dbPath}-wal`;
    const walMtime = existsSync(walPath) ? statSync(walPath).mtimeMs : 0;
    const cacheKey = `${mainMtime}:${walMtime}`;
    if (stateDbCache.key === cacheKey && Date.now() - stateDbCache.ts < 15000) {
      return stateDbCache.value;
    }

    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1500 });
      const projRows = db.prepare(`
        SELECT p.id, p.name, p.position, pr.path
        FROM projects p
        JOIN project_roots pr ON pr.project_id = p.id
        ORDER BY p.position ASC, pr.position ASC
      `).all();

      const projects = [];
      const seenPaths = new Set();
      for (const r of projRows) {
        const norm = normalizeDirPath(r.path);
        if (!norm || !existsSync(norm)) continue;
        const key = norm.toLowerCase();
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        projects.push({
          id: r.id,
          name: r.name || basename(norm),
          path: norm,
          position: r.position ?? 999,
        });
      }

      const threadRows = db.prepare(`
        SELECT id, name, title, cwd, rollout_path, model, reasoning_effort, updated_at
        FROM threads
        WHERE archived = 0
        ORDER BY updated_at DESC
        LIMIT 160
      `).all();

      const threads = [];
      for (const t of threadRows) {
        const normCwd = normalizeDirPath(t.cwd);
        const lowerCwd = normCwd.toLowerCase();
        if (lowerCwd.includes('\\.gemini\\antigravity\\brain\\')) continue;
        threads.push({
          sessionId: t.id,
          title: cleanThreadTitle(t.name, t.title),
          cwd: normCwd || null,
          rolloutPath: stripWinPrefix(t.rollout_path || ''),
          model: t.model || null,
          effort: t.reasoning_effort || null,
          updatedAtSec: Number(t.updated_at) || 0,
        });
      }

      const result = { projects, threads };
      stateDbCache = { key: cacheKey, ts: Date.now(), value: result };
      return result;
    } finally {
      try { db?.close(); } catch {}
    }
  } catch {
    return stateDbCache.value || { projects: [], threads: [] };
  }
}

export function listNativeCodexSessions(limit = 40) {
  const { threads } = queryCodexStateDb();
  return threads.slice(0, limit).map((t) => ({
    sessionId: t.sessionId,
    title: t.title,
    cwd: t.cwd,
    updatedAt: t.updatedAtSec ? new Date(t.updatedAtSec * 1000).toISOString() : '',
  }));
}

export function getProjectThreadTree(extraWorkspacePaths = [], preloadedRooms = null) {
  const projects = listAvailableProjects(extraWorkspacePaths);
  const bridgeRooms = Array.isArray(preloadedRooms) ? preloadedRooms : listRecentRooms(80);
  const { threads: nativeThreads } = queryCodexStateDb();

  const importedSessionIds = new Set();
  for (const r of bridgeRooms) {
    if (r.forkFromSessionId) importedSessionIds.add(r.forkFromSessionId);
    if (r.codexThreadId) importedSessionIds.add(r.codexThreadId);
  }

  const groupsByKey = new Map();
  for (const p of projects) {
    const key = p.path.toLowerCase();
    groupsByKey.set(key, {
      name: p.name,
      path: p.path,
      group: p.group,
      items: [],
    });
  }

  const ungrouped = [];

  for (const r of bridgeRooms) {
    const key = r.cwd ? r.cwd.toLowerCase() : '';
    const item = {
      kind: 'bridge',
      roomId: r.conversationId,
      title: r.title || '新对话',
      pinned: Boolean(r.pinned),
      status: r.status || 'idle',
      cwd: r.cwd,
      messageCount: r.messageCount,
      sortTs: r.updatedAt || 0,
    };
    if (key && groupsByKey.has(key)) {
      groupsByKey.get(key).items.push(item);
    } else if (r.cwd) {
      groupsByKey.set(key, {
        name: basename(r.cwd),
        path: r.cwd,
        group: '其他项目',
        items: [item],
      });
    } else {
      ungrouped.push(item);
    }
  }

  for (const nt of nativeThreads) {
    if (importedSessionIds.has(nt.sessionId)) continue;
    const key = nt.cwd ? nt.cwd.toLowerCase() : '';
    if (key.includes('codex-default\\')) continue;
    const item = {
      kind: 'native',
      sessionId: nt.sessionId,
      title: nt.title,
      pinned: false,
      status: 'idle',
      cwd: nt.cwd,
      sortTs: (nt.updatedAtSec || 0) * 1000,
    };
    if (key && groupsByKey.has(key)) {
      groupsByKey.get(key).items.push(item);
    }
  }

  const projectGroups = [...groupsByKey.values()].map((g) => {
    g.items.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.sortTs - a.sortTs;
    });
    g.items = g.items.slice(0, 20);
    return g;
  });

  ungrouped.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.sortTs - a.sortTs;
  });

  return {
    projectGroups,
    ungrouped: ungrouped.slice(0, 20),
    bridgeRooms,
  };
}

function findRolloutFileBySessionId(sessionId) {
  const { threads } = queryCodexStateDb();
  const hit = threads.find((t) => t.sessionId === sessionId);
  if (hit?.rolloutPath && existsSync(hit.rolloutPath)) {
    return hit.rolloutPath;
  }

  const sessionsRoot = join(getCodexHome(), 'sessions');
  if (!existsSync(sessionsRoot)) return null;
  const suffixA = `-${sessionId}.jsonl`.toLowerCase();
  const exactB = `${sessionId}.jsonl`.toLowerCase();

  const years = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  for (const y of years) {
    const yDir = join(sessionsRoot, y);
    const months = readdirSync(yDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
    for (const m of months) {
      const mDir = join(yDir, m);
      const days = readdirSync(mDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
      for (const d of days) {
        const dDir = join(mDir, d);
        for (const f of readdirSync(dDir)) {
          const lower = f.toLowerCase();
          if (lower === exactB || lower.endsWith(suffixA)) {
            return join(dDir, f);
          }
        }
      }
    }
  }
  return null;
}

export function importNativeCodexSession(sessionId, titleHint = '') {
  const cleanId = String(sessionId || '').trim();
  if (!SESSION_UUID_RE.test(cleanId)) {
    throw new Error('无效的完整 Codex 会话 UUID');
  }
  const roomId = `codex_${cleanId}`;
  const prevMeta = readMeta(roomId);
  // Immutable `importSourceSessionId` stays set even after a fork clears `forkFromSessionId`!
  if (prevMeta.importCompleted && (prevMeta.importSourceSessionId === cleanId || prevMeta.forkFromSessionId === cleanId)) {
    return getRoomSnapshot(roomId);
  }
  if (activeInProcessCheck(roomId) || isExternalOwnerAlive(prevMeta)) {
    throw new Error('目标历史会话正在执行中，请稍后重试');
  }

  // Read & parse native rollout BEFORE touching existing room files!
  const { threads } = queryCodexStateDb();
  const dbRow = threads.find((t) => t.sessionId === cleanId);
  const rolloutPath = dbRow?.rolloutPath && existsSync(dbRow.rolloutPath)
    ? dbRow.rolloutPath
    : findRolloutFileBySessionId(cleanId);

  let sessionCwd = dbRow?.cwd || null;
  let sessionModel = dbRow?.model || 'gpt-6.2-astra';
  const imported = [];

  if (rolloutPath && existsSync(rolloutPath)) {
    const raw = readFileSync(rolloutPath, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'session_meta' && ev.payload) {
          const metaCwd = normalizeDirPath(ev.payload.cwd);
          if (metaCwd && existsSync(metaCwd)) sessionCwd = metaCwd;
          const provModel = ev.payload.base_instructions?.provenance?.model;
          if (provModel) sessionModel = provModel;
        } else if (ev.type === 'response_item' && ev.payload?.type === 'message') {
          const role = ev.payload.role;
          const contentArr = Array.isArray(ev.payload.content) ? ev.payload.content : [];
          let text = contentArr
            .filter((c) => c && (c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string')
            .map((c) => c.text.trim())
            .filter(Boolean)
            .join('\n\n');
          if (!text) continue;

          if (role === 'user') {
            if (
              text.startsWith('# AGENTS.md instructions') ||
              text.startsWith('<environment_context>') ||
              text.startsWith('<INSTRUCTIONS>') ||
              text.startsWith('<permissions instructions>')
            ) {
              continue;
            }
            const myReqIdx = text.indexOf('## My request:');
            if (myReqIdx !== -1) {
              text = text.slice(myReqIdx + '## My request:'.length).trim();
            }
            if (text) imported.push({ sender: 'user', senderLabel: '你', text, ts: ev.timestamp });
          } else if (role === 'assistant') {
            imported.push({ sender: 'codex', senderLabel: 'Codex', text, ts: ev.timestamp });
          }
        }
      } catch {}
    }
  }

  const dir = ensureRoomDir(roomId);
  try { rmSync(join(dir, 'messages.jsonl'), { force: true }); } catch {}
  messagesCache.delete(roomId);

  const slice = imported.slice(-80);
  for (const m of slice) {
    appendMessage(roomId, { ...m, codexThreadId: cleanId, model: sessionModel });
  }

  writeMeta(roomId, {
    title: titleHint || dbRow?.title || (slice[0]?.text?.slice(0, 34) || `Codex ${cleanId.slice(0, 8)}`),
    messageCount: slice.length,
    importCompleted: true,
    importSourceSessionId: cleanId,
    codexThreadId: cleanId,
    needsForkOnNextTurn: true,
    forkFromSessionId: cleanId,
    cwd: sessionCwd,
    model: sessionModel,
    effort: dbRow?.effort || 'medium',
    mode: 'direct',
    status: 'idle',
  });

  return getRoomSnapshot(roomId);
}

export function switchToProject(hostConvId, projectPath, currentPrefs = {}) {
  const norm = normalizeDirPath(projectPath);
  if (!norm || !existsSync(norm)) {
    throw new Error(`项目目录不存在: ${projectPath}`);
  }
  const targetKey = norm.toLowerCase();

  const bridgeRooms = listRecentRooms(80).filter((r) => r.cwd && r.cwd.toLowerCase() === targetKey);
  const { threads: nativeThreads } = queryCodexStateDb();
  const matchingNative = nativeThreads.filter((t) => t.cwd && t.cwd.toLowerCase() === targetKey);

  const latestBridgeTs = bridgeRooms[0]?.updatedAt || 0;
  const latestNativeTs = (matchingNative[0]?.updatedAtSec || 0) * 1000;

  if (bridgeRooms.length > 0 && latestBridgeTs >= latestNativeTs) {
    const roomId = setActiveRoomForHost(hostConvId, bridgeRooms[0].conversationId);
    return { action: 'switched_bridge_thread', roomId, snap: getRoomSnapshot(roomId) };
  }

  if (matchingNative.length > 0) {
    const snap = importNativeCodexSession(matchingNative[0].sessionId, matchingNative[0].title);
    const roomId = setActiveRoomForHost(hostConvId, snap.conversationId);
    return { action: 'imported_project_thread', roomId, snap };
  }

  const freshMeta = createNewRoom({
    cwd: norm,
    model: currentPrefs.model || 'gpt-6.2-astra',
    effort: currentPrefs.effort || 'medium',
    mode: currentPrefs.mode || 'dual-2',
    approvalPolicy: currentPrefs.approvalPolicy || 'on-request',
  });
  const roomId = setActiveRoomForHost(hostConvId, freshMeta.conversationId);
  return { action: 'created_project_thread', roomId, snap: getRoomSnapshot(roomId) };
}

export function listCodexModels() {
  const fallback = [
    { slug: 'gpt-6.2-astra', displayName: 'GPT-6.2-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { slug: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { slug: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { slug: 'gpt-6-astra', displayName: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  ];
  const cacheFile = join(getCodexHome(), 'models_cache.json');
  if (!existsSync(cacheFile)) return fallback;
  try {
    const data = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    const rawModels = Array.isArray(data) ? data : (data.models || []);
    const visible = rawModels
      .filter((m) => m && m.visibility === 'list' && (m.slug || m.id))
      .map((m) => {
        const slug = m.slug || m.id;
        const displayName = m.display_name || m.title || slug;
        const efforts = (m.supported_reasoning_levels || m.reasoning_efforts || [])
          .map((e) => (typeof e === 'string' ? e : e?.effort))
          .filter(Boolean);
        return {
          slug,
          displayName,
          efforts: efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh'],
        };
      });
    return visible.length > 0 ? visible : fallback;
  } catch {
    return fallback;
  }
}

export function listAvailableProjects(extraPaths = []) {
  const seen = new Map();
  const addDir = (rawPath, group, customName) => {
    if (!rawPath || typeof rawPath !== 'string') return;
    let p = rawPath.trim();
    if (p.startsWith('file:///')) {
      try { p = decodeURIComponent(new URL(p).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\'); } catch {}
    }
    const norm = normalizeDirPath(p);
    if (!norm || !existsSync(norm)) return;
    try { if (!statSync(norm).isDirectory()) return; } catch { return; }
    const key = norm.toLowerCase();
    if (key.includes('codex-default\\2026-')) return;
    if (!seen.has(key)) {
      seen.set(key, { name: customName || basename(norm) || norm, path: norm, group });
    }
  };

  for (const ep of extraPaths) addDir(ep, '当前工作区');

  const { projects: dbProjects } = queryCodexStateDb();
  for (const dp of dbProjects) {
    addDir(dp.path, 'Codex 项目', dp.name);
  }

  const customFile = join(getPluginDataDir(), 'custom_projects.json');
  if (existsSync(customFile)) {
    try {
      const arr = readJsonWithBackupSync(customFile);
      if (Array.isArray(arr)) arr.forEach((p) => addDir(p, '常用目录'));
    } catch {}
  }

  const agyProjRoot = 'E:\\Antigravity\\Projects';
  if (existsSync(agyProjRoot)) {
    for (const d of readdirSync(agyProjRoot, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) {
        addDir(join(agyProjRoot, d.name), 'Antigravity 项目');
      }
    }
  }

  const cfgPath = join(getCodexHome(), 'config.toml');
  if (existsSync(cfgPath)) {
    try {
      const toml = readFileSync(cfgPath, 'utf-8');
      const re = /\[projects\.['"]([^'"]+)['"]\]/g;
      let m;
      while ((m = re.exec(toml)) !== null) {
        addDir(m[1], 'Codex 项目');
      }
    } catch {}
  }

  return [...seen.values()].slice(0, 40);
}

export function addCustomProject(dirPath) {
  const clean = normalizeDirPath(String(dirPath || '').trim().replace(/^["']|["']$/g, ''));
  if (!clean || !existsSync(clean) || !statSync(clean).isDirectory()) {
    throw new Error(`目录不存在或不可访问: ${clean}`);
  }
  const dataDir = getPluginDataDir();
  const customFile = join(dataDir, 'custom_projects.json');
  withRoomFileLockSync(dataDir, () => {
    const arr = Array.isArray(readJsonWithBackupSync(customFile)) ? readJsonWithBackupSync(customFile) : [];
    const next = [clean, ...arr.filter((x) => String(x).toLowerCase() !== clean.toLowerCase())].slice(0, 25);
    writeJsonAtomicSync(customFile, next);
  });
  return { name: basename(clean) || clean, path: clean };
}

// ---------------------------------------------------------------------------
// Symlink-Safe File Uploads, Server-Side Attachment Verification & Export
// ---------------------------------------------------------------------------
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export function resolveSafeUploadPath(convId, fileName) {
  const safeConv = sanitizeConvId(convId);
  const rawName = String(fileName || '').trim();
  if (!rawName || rawName.includes('/') || rawName.includes('\\') || rawName === '.' || rawName === '..') {
    return null;
  }

  try {
    const brainRoot = getBrainRoot();
    mkdirSync(brainRoot, { recursive: true });
    const realBrain = realpathSync(brainRoot);

    const convDir = join(realBrain, safeConv);
    const roomDir = join(convDir, '.codex_room');
    const uploadsDir = join(roomDir, 'uploads');
    mkdirSync(uploadsDir, { recursive: true });

    // Reject symlinks/junctions at EVERY directory hop below trusted `realBrain`!
    for (const hop of [convDir, roomDir, uploadsDir]) {
      const lst = lstatSync(hop);
      if (lst.isSymbolicLink() || !lst.isDirectory()) return null;
    }

    const realUploads = realpathSync(uploadsDir);
    const expectedUploadsPrefix = join(realBrain, safeConv, '.codex_room', 'uploads');
    if (realUploads.toLowerCase() !== expectedUploadsPrefix.toLowerCase()) {
      return null;
    }

    const rootWithSep = realUploads.endsWith(sep) ? realUploads : realUploads + sep;
    const candidate = resolve(realUploads, rawName);
    if (!candidate.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
      return null;
    }

    if (existsSync(candidate)) {
      const lst = lstatSync(candidate);
      if (lst.isSymbolicLink() || !lst.isFile()) return null;
      const realCandidate = realpathSync(candidate);
      if (!realCandidate.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
        return null;
      }
      return realCandidate;
    }
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Reconstructs verified attachment descriptors strictly from server-owned files
 * inside `<room>/uploads/`, ignoring any untrusted client-supplied `path` or `isImage`.
 */
export function sanitizeClientAttachments(convId, clientAttachments) {
  if (!Array.isArray(clientAttachments) || clientAttachments.length === 0) return [];
  const verified = [];
  for (const raw of clientAttachments.slice(0, 16)) {
    const storedName = String(raw?.storedName || '').trim();
    if (!storedName) continue;
    const safePath = resolveSafeUploadPath(convId, storedName);
    if (!safePath || !existsSync(safePath)) continue;
    try {
      const st = statSync(safePath);
      if (!st.isFile()) continue;
      const ext = extname(safePath).toLowerCase();
      const displayName = basename(String(raw?.name || storedName)).slice(0, 80);
      verified.push({
        name: displayName,
        storedName,
        path: safePath,
        size: st.size,
        isImage: IMAGE_EXTS.has(ext),
      });
    } catch {}
  }
  return verified;
}

export function saveUploadedFile(convId, { fileName, mimeType, dataBase64 }) {
  const cleanB64 = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!cleanB64) throw new Error('附件内容为空');
  if (cleanB64.length > MAX_UPLOAD_B64_CHARS) {
    throw new Error('单个附件最大支持 20MB');
  }

  const buf = Buffer.from(cleanB64, 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error('单个附件最大支持 20MB');
  }

  const uploadsDir = ensureUploadsDir(convId);
  const rawBase = basename(String(fileName || 'attachment')).replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_');
  const ext = (extname(rawBase) || (String(mimeType || '').startsWith('image/') ? '.png' : '.bin')).toLowerCase();
  const stem = rawBase.slice(0, Math.max(1, rawBase.length - extname(rawBase).length)).slice(0, 48);
  const storedName = `${Date.now()}_${randomUUID().slice(0, 6)}_${stem}${ext}`;
  const fullPath = resolveSafeUploadPath(convId, storedName);
  if (!fullPath) throw new Error('非法的附件保存路径');

  writeFileSync(fullPath, buf, { flag: 'wx' });

  return {
    id: `att_${randomUUID().slice(0, 8)}`,
    name: rawBase,
    storedName,
    path: fullPath,
    size: buf.length,
    mimeType: mimeType || 'application/octet-stream',
    isImage: IMAGE_EXTS.has(ext),
  };
}

export function removeUploadedFile(convId, storedName) {
  const target = resolveSafeUploadPath(convId, storedName);
  if (target && existsSync(target)) {
    try { rmSync(target, { force: true }); } catch {}
    return { removed: true };
  }
  return { removed: false };
}

export function exportRoomMarkdown(convId, { saveToDisk = true } = {}) {
  const snap = getRoomSnapshot(convId);
  const meta = snap.meta;
  const lines = [
    `# ${meta.title || 'Codex 对话记录'}`,
    '',
    `- **项目目录**: ${meta.cwd || '通用（未指定）'}`,
    `- **模型与强度**: \`${meta.model || 'gpt-6.2-astra'}\` (${meta.effort || 'medium'})`,
    `- **Codex 线程 ID**: \`${meta.codexThreadId || '无'}\``,
    `- **导出时间**: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '---',
    '',
  ];

  for (const m of snap.messages) {
    if (m.sender === 'system') {
      lines.push(`> *${m.text}*`, '');
      continue;
    }
    const who = m.sender === 'codex'
      ? `### Codex${m.durationMs ? ` (${(m.durationMs / 1000).toFixed(1)}s)` : ''}`
      : m.sender === 'antigravity'
        ? '### Antigravity'
        : `### ${m.senderLabel || '用户'}`;
    lines.push(who, '', m.text || '');
    if (m.reasoningSummary) {
      lines.push('', '<details><summary>思考摘要</summary>', '', m.reasoningSummary, '', '</details>');
    }
    if (Array.isArray(m.plan) && m.plan.length > 0) {
      lines.push('', '<details><summary>执行计划</summary>', '');
      for (const p of m.plan) {
        const mark = p.status === 'completed' ? '[x]' : p.status === 'inProgress' ? '[-]' : '[ ]';
        lines.push(`- ${mark} ${p.step}`);
      }
      lines.push('', '</details>');
    }
    if (Array.isArray(m.steps) && m.steps.length > 0) {
      lines.push('', '<details><summary>执行步骤</summary>', '');
      for (const s of m.steps) {
        lines.push(`- \`${s.kind}\`: ${s.label}${s.exitCode !== undefined && s.exitCode !== null ? ` (exit ${s.exitCode})` : ''}`);
      }
      lines.push('', '</details>');
    }
    if (m.diff) {
      lines.push('', '```diff', m.diff, '```');
    }
    lines.push('', '---', '');
  }

  const markdown = lines.join('\n');
  let savedPath = null;
  if (saveToDisk) {
    const outDir = getDefaultOutputsDir();
    const safeTitle = (meta.title || '对话记录').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 32);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    for (let idx = 0; idx < 100; idx++) {
      const suffix = idx === 0 ? '' : `_${idx}`;
      const candidate = join(outDir, `${safeTitle}_${stamp}${suffix}.md`);
      try {
        writeFileSync(candidate, markdown, { encoding: 'utf-8', flag: 'wx' });
        savedPath = candidate;
        break;
      } catch (err) {
        if (err?.code === 'EEXIST') continue;
        throw err;
      }
    }
  }
  return { markdown, savedPath };
}

export function resetCodexThread(convId, { clearHistory = false } = {}) {
  const safeConv = sanitizeConvId(convId);
  const dir = ensureRoomDir(safeConv);
  const prev = readMeta(safeConv);
  const nextEpoch = (Number(prev.roomEpoch) || 1) + 1;

  if (clearHistory) {
    try { rmSync(join(dir, 'messages.jsonl'), { force: true }); } catch {}
    messagesCache.delete(safeConv);
  } else {
    appendMessage(safeConv, {
      sender: 'system',
      senderLabel: '系统',
      text: '已开启新的 Codex 上下文',
    });
  }
  return writeMeta(safeConv, {
    roomEpoch: nextEpoch,
    messageCount: clearHistory ? 0 : readMessages(safeConv).length,
    codexThreadId: null,
    needsForkOnNextTurn: false,
    forkFromSessionId: null,
    cancelRequestedAt: Date.now(),
    status: 'idle',
    turnLease: null,
    activeTurn: null,
    lastError: null,
  });
}

function summarizeCommand(cmd) {
  const clean = String(cmd || '').replace(/\s+/g, ' ').trim();
  return clean.length > 76 ? clean.slice(0, 73) + '...' : clean;
}

// ---------------------------------------------------------------------------
// Standalone CLI Runner (`talk_codex.mjs`: Antigravity -> Codex)
// ---------------------------------------------------------------------------
export async function runCodexTurn({
  convId,
  prompt,
  displayText,
  attachments = [],
  imagePaths = [],
  sender = 'antigravity',
  senderLabel,
  model,
  effort,
  sandbox,
  cwd,
  newThread = false,
  useUserConfig = false,
  persistPrefs = false,
  allowPeerRecursion = false,
  onChild,
}) {
  if (!allowPeerRecursion && process.env.AGY_CODEX_PEER_CALL === '1') {
    throw new Error('[Peer Guard] 当前已处于双 AI 同侪被调用回合（AGY_CODEX_PEER_CALL=1），请直接给出独立结论，禁止反向递归调用 talk_codex.mjs。');
  }
  const safeConv = sanitizeConvId(convId);
  return enqueueWrite(safeConv, async () => {
    const rawText = String(prompt || '').trim();
    const bubbleText = String(displayText || prompt || '').trim();
    const verifiedAtts = sanitizeClientAttachments(safeConv, attachments);
    if (!rawText && verifiedAtts.length === 0 && imagePaths.length === 0) {
      throw new Error('发送内容不能为空。');
    }

    const { leaseId, roomEpoch, meta: prevMeta } = acquireRoomTurnLease(safeConv, 'codex-cli');
    const releaseWatcher = retainDirWatcher(safeConv);
    const hbTimer = setInterval(() => heartbeatRoomTurnLease(safeConv, leaseId), HEARTBEAT_INTERVAL_MS);
    if (typeof hbTimer.unref === 'function') hbTimer.unref();

    try {
      const chosenModel = model || prevMeta.model || 'gpt-6.2-astra';
      const chosenEffort = effort || prevMeta.effort || 'medium';
      const chosenSandbox = sandbox || prevMeta.sandbox || 'workspace-write';
      const chosenCwd = normalizeDirPath(cwd || prevMeta.cwd || ensureRoomDir(safeConv));
      mkdirSync(chosenCwd, { recursive: true });

      const cwdChanged = prevMeta.cwd && normalizeDirPath(prevMeta.cwd).toLowerCase() !== chosenCwd.toLowerCase();
      const shouldFork = !newThread && !cwdChanged && Boolean(prevMeta.needsForkOnNextTurn && prevMeta.forkFromSessionId);
      const threadToResume = (newThread || cwdChanged || shouldFork) ? null : (prevMeta.codexThreadId || null);
      const forkSourceId = shouldFork ? prevMeta.forkFromSessionId : null;
      const { exe, extraPathDirs } = findCodexBinary();

      const allImages = imagePaths.filter((p) => p && existsSync(p));
      const nonImageFiles = [];
      for (const att of verifiedAtts) {
        if (att.isImage) allImages.push(att.path);
        else nonImageFiles.push(att);
      }

      appendMessage(safeConv, {
        sender,
        senderLabel: senderLabel || (sender === 'user' ? '你' : 'Antigravity'),
        text: bubbleText || (verifiedAtts.length ? `已发送 ${verifiedAtts.length} 个附件` : ''),
        attachments: verifiedAtts,
        codexThreadId: threadToResume || forkSourceId,
        model: chosenModel,
        effort: chosenEffort,
      }, { expectedEpoch: roomEpoch, requireExists: true });

      let effectivePrompt = rawText || '请查看并分析所附图片/文件内容。';
      if (nonImageFiles.length > 0) {
        const fileLines = nonImageFiles.map((f) => `- ${f.name}: ${f.path}`).join('\n');
        effectivePrompt += `\n\n[附加本地文件，可直接读取分析：\n${fileLines}\n]`;
      }

      const startedAt = Date.now();
      const activeTurn = {
        id: `turn_${randomUUID().slice(0, 8)}`,
        startedAt,
        sender,
        liveStatus: 'Thinking',
        reasoningSummary: '',
        streamingText: '',
        diff: '',
        plan: [],
        pendingApprovals: [],
        steps: [],
      };

      // Keep fork source intact until child confirms new forked thread_id!
      const prefPatch = persistPrefs
        ? { model: chosenModel, effort: chosenEffort, sandbox: chosenSandbox, cwd: chosenCwd }
        : { cwd: prevMeta.cwd || chosenCwd };

      writeMeta(safeConv, {
        ...prefPatch,
        status: 'thinking',
        activeTurn,
        lastError: null,
      }, { expectedEpoch: roomEpoch, requireExists: true });

      const outFile = join(tmpdir(), `agy-codex-last-${process.pid}-${Date.now()}.txt`);
      const imageFlags = [];
      for (const img of allImages) imageFlags.push('-i', img);
      const uploadsDir = ensureUploadsDir(safeConv);

      // Headless `codex exec` has no interactive UI, so set approval_policy="never" while strictly enforcing sandbox_mode
      const commonOverrides = [
        ...(useUserConfig ? [] : ['--ignore-user-config']),
        '-m', chosenModel,
        '-c', `model_reasoning_effort="${chosenEffort}"`,
        '-c', 'approval_policy="never"',
        '--skip-git-repo-check',
      ];

      let args;
      if (shouldFork && forkSourceId) {
        args = [
          'exec', 'fork',
          ...commonOverrides,
          '-c', `sandbox_mode="${chosenSandbox}"`,
          ...imageFlags,
          '-o', outFile, '--json', forkSourceId, '-',
        ];
      } else if (threadToResume) {
        args = [
          'exec', 'resume',
          ...commonOverrides,
          '-c', `sandbox_mode="${chosenSandbox}"`,
          ...imageFlags,
          '-o', outFile, '--json', threadToResume, '-',
        ];
      } else {
        args = [
          'exec',
          ...commonOverrides,
          '-s', chosenSandbox,
          '-C', chosenCwd,
          '--add-dir', uploadsDir,
          ...imageFlags,
          '-o', outFile, '--json', '-',
        ];
      }

      const childEnv = { ...process.env, AGY_CODEX_PEER_CALL: '1' };
      delete childEnv.NODE_OPTIONS;
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const currentPath = childEnv.PATH || childEnv.Path || '';
      childEnv.PATH = [...extraPathDirs, currentPath].filter(Boolean).join(pathSep);
      if ('Path' in childEnv) childEnv.Path = childEnv.PATH;

      return await new Promise((resolveTurn, rejectTurn) => {
        let resolvedThreadId = threadToResume;
        let forkRecorded = false;
        let lastAgentMessage = '';
        let streamErrorMsg = '';
        let stderrBuf = '';
        let stdoutRemainder = '';
        let wasCancelled = false;

        const child = spawn(exe, args, {
          cwd: chosenCwd,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        if (typeof onChild === 'function') onChild(child);

        const checkExternalCancel = () => {
          try {
            if (!existsSync(getRoomDir(safeConv))) {
              wasCancelled = true;
              try { child.kill(); } catch {}
              return;
            }
            const cur = readMeta(safeConv);
            if (((cur.cancelRequestedAt && cur.cancelRequestedAt >= startedAt) || (cur.roomEpoch || 1) !== roomEpoch) && !wasCancelled) {
              wasCancelled = true;
              try { child.kill(); } catch {}
            }
          } catch {}
        };
        roomEvents.on(`change:${safeConv}`, checkExternalCancel);

        child.stdin.write(effectivePrompt, 'utf-8');
        child.stdin.end();

        const syncActive = () => {
          if (wasCancelled) return;
          writeMeta(safeConv, {
            ...(resolvedThreadId ? { codexThreadId: resolvedThreadId, needsForkOnNextTurn: false, forkFromSessionId: null } : {}),
            status: 'thinking',
            activeTurn: { ...activeTurn },
          }, { expectedEpoch: roomEpoch, requireExists: true });
        };

        const handleJsonEvent = (ev) => {
          if (!ev || typeof ev !== 'object') return;
          if (ev.type === 'thread.started' && ev.thread_id) {
            resolvedThreadId = ev.thread_id;
            if (shouldFork && forkSourceId && !forkRecorded) {
              forkRecorded = true;
              appendMessage(safeConv, {
                sender: 'system',
                senderLabel: '系统',
                text: `已从历史会话 (${forkSourceId.slice(0, 8)}…) 成功创建安全分支`,
              }, { expectedEpoch: roomEpoch, requireExists: true });
            }
            syncActive();
            return;
          }
          if ((ev.type === 'error' || ev.type === 'turn.failed') && (ev.message || ev.error?.message)) {
            streamErrorMsg = String(ev.message || ev.error?.message);
            return;
          }
          const item = ev.item;
          if (item && typeof item === 'object') {
            if (item.type === 'reasoning') {
              if (typeof item.text === 'string' && item.text.trim()) {
                activeTurn.reasoningSummary = item.text.trim();
              } else if (Array.isArray(item.summary) && item.summary.length) {
                activeTurn.reasoningSummary = item.summary.join('\n').trim();
              }
              activeTurn.liveStatus = 'Thinking';
              syncActive();
            } else if (item.type === 'command_execution') {
              const fullCmd = String(item.command || item.cmd || '');
              const cmdLabel = summarizeCommand(fullCmd);
              if (ev.type === 'item.started') {
                activeTurn.liveStatus = `Running ${cmdLabel}`;
              } else if (ev.type === 'item.completed') {
                const outTail = String(item.aggregated_output || item.output || '').trim().slice(-1200);
                activeTurn.steps.push({
                  kind: 'command',
                  label: cmdLabel,
                  command: fullCmd.slice(0, 300),
                  output: outTail,
                  exitCode: item.exit_code ?? 0,
                });
                activeTurn.liveStatus = 'Thinking';
              }
              syncActive();
            } else if (item.type === 'file_change' && ev.type === 'item.completed') {
              const files = Array.isArray(item.changes) ? item.changes.map((c) => basename(c.path || '')).filter(Boolean) : [];
              activeTurn.steps.push({
                kind: 'fileChange',
                label: files.length ? `修改文件: ${files.join(', ')}` : '应用文件修改',
              });
              syncActive();
            } else if (item.type === 'mcp_tool_call' && ev.type === 'item.completed') {
              activeTurn.steps.push({
                kind: 'mcp',
                label: `${item.server || 'mcp'}/${item.tool || 'tool'}`,
              });
              syncActive();
            } else if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
              lastAgentMessage = item.text;
              activeTurn.streamingText = item.text;
              activeTurn.liveStatus = 'Responding';
              syncActive();
            }
          }
        };

        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => {
          stdoutRemainder += chunk;
          const lines = stdoutRemainder.split(/\r?\n/);
          stdoutRemainder = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) continue;
            try { handleJsonEvent(JSON.parse(trimmed)); } catch {}
          }
        });

        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

        child.on('error', (err) => {
          roomEvents.off(`change:${safeConv}`, checkExternalCancel);
          try { rmSync(outFile, { force: true }); } catch {}
          releaseRoomTurnLease(safeConv, leaseId, { status: 'error', activeTurn: null, lastError: err.message });
          rejectTurn(err);
        });

        child.on('close', (code) => {
          roomEvents.off(`change:${safeConv}`, checkExternalCancel);
          if (stdoutRemainder.trim().startsWith('{')) {
            try { handleJsonEvent(JSON.parse(stdoutRemainder.trim())); } catch {}
          }
          let finalReply = '';
          if (existsSync(outFile)) {
            try { finalReply = readFileSync(outFile, 'utf-8').trim(); } catch {}
            try { rmSync(outFile, { force: true }); } catch {}
          }
          if (!finalReply) finalReply = lastAgentMessage.trim();

          const durationMs = Date.now() - startedAt;

          if (wasCancelled) {
            const replyEntry = appendMessage(safeConv, {
              sender: 'codex',
              senderLabel: 'Codex',
              text: finalReply ? `${finalReply}\n\n*(已手动中止)*` : '*(回合已手动中止)*',
              reasoningSummary: activeTurn.reasoningSummary,
              codexThreadId: resolvedThreadId,
              model: chosenModel,
              effort: chosenEffort,
              durationMs,
              steps: activeTurn.steps,
            }, { expectedEpoch: roomEpoch, requireExists: true });
            const finalMeta = releaseRoomTurnLease(safeConv, leaseId, {
              ...(resolvedThreadId ? { codexThreadId: resolvedThreadId } : {}),
              status: 'idle',
              activeTurn: null,
              lastError: null,
            });
            resolveTurn({
              conversationId: safeConv,
              codexThreadId: resolvedThreadId,
              reply: replyEntry?.text || '*(回合已手动中止)*',
              cancelled: true,
              durationMs,
              steps: activeTurn.steps,
              meta: finalMeta,
            });
            return;
          }

          if (code !== 0 || streamErrorMsg) {
            const errMsg = (streamErrorMsg || stderrBuf || `Codex exited with code ${code}`).trim().slice(-600);
            if (finalReply) {
              appendMessage(safeConv, {
                sender: 'codex',
                senderLabel: 'Codex',
                text: `${finalReply}\n\n*(执行异常中断: ${errMsg})*`,
                reasoningSummary: activeTurn.reasoningSummary,
                codexThreadId: resolvedThreadId,
                model: chosenModel,
                effort: chosenEffort,
                durationMs,
                steps: activeTurn.steps,
              }, { expectedEpoch: roomEpoch, requireExists: true });
            }
            releaseRoomTurnLease(safeConv, leaseId, {
              ...(resolvedThreadId ? { codexThreadId: resolvedThreadId, needsForkOnNextTurn: false, forkFromSessionId: null } : {}),
              status: 'error',
              activeTurn: null,
              lastError: errMsg,
            });
            rejectTurn(new Error(errMsg));
            return;
          }

          const replyEntry = appendMessage(safeConv, {
            sender: 'codex',
            senderLabel: 'Codex',
            text: finalReply || '（无输出内容）',
            reasoningSummary: activeTurn.reasoningSummary,
            codexThreadId: resolvedThreadId,
            model: chosenModel,
            effort: chosenEffort,
            durationMs,
            steps: activeTurn.steps,
          }, { expectedEpoch: roomEpoch, requireExists: true });

          const finalMeta = releaseRoomTurnLease(safeConv, leaseId, {
            ...(resolvedThreadId ? { codexThreadId: resolvedThreadId, needsForkOnNextTurn: false, forkFromSessionId: null } : {}),
            status: 'idle',
            activeTurn: null,
            lastError: null,
          });

          resolveTurn({
            conversationId: safeConv,
            codexThreadId: resolvedThreadId,
            reply: replyEntry?.text || finalReply,
            durationMs,
            steps: activeTurn.steps,
            meta: finalMeta,
          });
        });
      });
    } catch (err) {
      releaseRoomTurnLease(safeConv, leaseId, { status: 'error', activeTurn: null, lastError: err.message });
      throw err;
    } finally {
      clearInterval(hbTimer);
      releaseWatcher();
    }
  });
}

// ---------------------------------------------------------------------------
// Bidirectional Peer Exchange Protocol & Codex -> Antigravity Runner (`agy`)
// ---------------------------------------------------------------------------
export const PEER_PROTOCOLS = {
  rfc: {
    tag: '架构方案碰撞',
    guide: [
      '1. 独立审视对方提出的前提假设、数据流边界与故障面，禁止礼貌性附和。',
      '2. 明确列出你认同的部分、反对或存疑的部分（说明具体技术依据），以及更优替代设计或折中契约。',
      '3. 回复末尾必须附带状态行：`[PEER_STATUS: CONVERGED]`（双方核心设计已无分歧，可进入实现）或 `[PEER_STATUS: NEEDS_ROUND]`（仍有关键分歧待收敛）。',
    ].join('\n'),
  },
  review: {
    tag: '对抗式代码审查',
    guide: [
      '1. 按缺陷严重度分级输出：`[P0 致命/安全/丢数据]`、`[P1 逻辑错误/竞态/越界]`、`[P2 边界隐患/性能退化]`、`[P3 可维护性建议]`。',
      '2. 每一条问题必须给出准确的 `文件路径:行号`（或函数名）、触发条件与最小修复方向；无实质缺陷时直接写“未发现 P0-P2 缺陷”，不凑数、不寒暄。',
      '3. 回复末尾必须附带裁决行：`[PEER_VERDICT: PASS]`（零 P0/P1）或 `[PEER_VERDICT: CHANGES_REQUIRED]`（存在必改项）。',
    ].join('\n'),
  },
  debug: {
    tag: '双盲根因排障',
    guide: [
      '1. 严格区分「已验证事实（Verified Facts）」与「待证伪假设（Hypotheses）」，禁止把猜测当结论。',
      '2. 针对现象提出你独立判断的 Top 1-2 可疑根因，并给出单步成本最低的验证/证伪实验命令或断点位置。',
      '3. 回复末尾附带：`[PEER_STATUS: CONVERGED]` 或 `[PEER_STATUS: NEEDS_ROUND]`。',
    ].join('\n'),
  },
  audit: {
    tag: '洁净室独立验收',
    guide: [
      '1. 不预设实现者的合理性，直接对照用户原始需求、权限安全边界与变更 Diff 做独立验收核对。',
      '2. 检查是否存在“只过编译未闭环逻辑”、“遗漏回退/异常分支”或“越界修改无关模块”的情况。',
      '3. 回复末尾必须附带：`[PEER_VERDICT: PASS]` 或 `[PEER_VERDICT: CHANGES_REQUIRED]`。',
    ].join('\n'),
  },
  free: {
    tag: '自由技术协商',
    guide: '请直接给出高信息密度的专业判断、反例或改进建议，省去客套铺垫。',
  },
};

export function collectGitContext(cwd, maxChars = 24000) {
  if (!cwd || !existsSync(cwd)) return '';
  try {
    const status = execFileSync('git', ['status', '--short'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    const diff = execFileSync('git', ['diff', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    if (!status && !diff) return '';
    const clipped = diff.length > maxChars ? `${diff.slice(0, maxChars)}\n... [git diff truncated at ${maxChars} chars]` : diff;
    return [
      '### 当前工作区 Git 变更快照',
      status ? `\`\`\`text\n${status}\n\`\`\`` : '',
      clipped ? `\`\`\`diff\n${clipped}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

export function collectFilesContext(filePaths = [], maxTotalChars = 280000) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return { summaryNames: [], contextBlock: '' };
  const blocks = [];
  const summaryNames = [];
  let used = 0;

  for (const raw of filePaths) {
    const full = normalizeDirPath(raw);
    if (!full || !existsSync(full)) continue;
    const name = basename(full);
    const remain = maxTotalChars - used;
    if (remain <= 256) {
      blocks.push(`#### FILE: ${name} (${full})\n> [已超出单次总上下文额度省略]`);
      continue;
    }
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      // Bounded byte read so huge files never trigger full-memory allocation
      const byteCap = Math.min(st.size, remain * 3);
      const buf = Buffer.alloc(byteCap);
      const fd = openSync(full, 'r');
      let bytesRead = 0;
      try {
        bytesRead = readSync(fd, buf, 0, byteCap, 0);
      } finally {
        closeSync(fd);
      }
      const rawText = buf.subarray(0, bytesRead).toString('utf-8');
      const numbered = rawText
        .split(/\r?\n/)
        .map((l, idx) => `${idx + 1}: ${l}`)
        .join('\n');
      const wasClipped = bytesRead < st.size || numbered.length > remain;
      const slice = numbered.length > remain ? `${numbered.slice(0, remain)}\n... [truncated at budget]` : numbered;
      used += slice.length;
      summaryNames.push(wasClipped ? `${name}(截断)` : name);
      blocks.push(`#### FILE: ${name} (${full})\n\`\`\`\n${slice}${bytesRead < st.size && numbered.length <= remain ? '\n... [truncated]' : ''}\n\`\`\``);
    } catch {}
  }

  return {
    summaryNames,
    contextBlock: blocks.length ? `### 附带带行号源码快照\n\n${blocks.join('\n\n')}` : '',
  };
}

export function buildPeerEnvelope({
  protocol = 'free',
  round = '',
  fromAgent = 'Antigravity',
  toAgent = 'Codex',
  body = '',
  gitContext = '',
  filesContext = '',
  attachedFileNames = [],
}) {
  const proto = PEER_PROTOCOLS[protocol] || PEER_PROTOCOLS.free;
  const roundLabel = round ? ` · 第 ${round} 轮` : '';
  const displayPrefix = protocol !== 'free' || round ? `**[${proto.tag}${roundLabel}]**\n\n` : '';
  const filesNote = attachedFileNames.length ? `\n\n*(已附带 ${attachedFileNames.length} 份带行号源码快照: ${attachedFileNames.join(', ')})*` : '';
  const cleanBody = String(body || '').trim();
  const displayBody = cleanBody.length > 4000 ? `${cleanBody.slice(0, 4000)}\n\n*(长上下文已折叠进后台协议载荷)*` : cleanBody;
  const displayText = `${displayPrefix}${displayBody}${filesNote}`;

  const wireParts = [
    `[PEER-EXCHANGE-FROM-${fromAgent.toUpperCase()} | TO: ${toAgent} | PROTOCOL: ${protocol.toUpperCase()}${round ? ` | ROUND: ${round}` : ''}]`,
    `你正在与本地同侪智能体 **${fromAgent}** 进行专业工程对等协商。注意：当前处于被调用端，请直接输出你的独立专业结论，**严禁**反向调用同侪桥接脚本（防止递归死循环）。`,
    `### 本轮协作规程（${proto.tag}）\n${proto.guide}`,
    `### ${fromAgent} 本轮发言\n${cleanBody}`,
  ];
  if (gitContext) wireParts.push(gitContext);
  if (filesContext) wireParts.push(filesContext);

  return {
    displayText,
    wirePrompt: wireParts.join('\n\n'),
  };
}

let cachedAgyBin = null;
let cachedAgyCheckedAt = 0;

export function findAgyBinary() {
  if (cachedAgyBin && Date.now() - cachedAgyCheckedAt < 30000 && existsSync(cachedAgyBin)) {
    return cachedAgyBin;
  }
  if (process.env.AGY_BIN && existsSync(process.env.AGY_BIN)) {
    cachedAgyBin = process.env.AGY_BIN;
    cachedAgyCheckedAt = Date.now();
    return cachedAgyBin;
  }

  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const candidates = [
    join(localAppData, 'agy', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
    join(localAppData, 'Programs', 'antigravity', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
    join(appData, 'Antigravity', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedAgyBin = c;
      cachedAgyCheckedAt = Date.now();
      return cachedAgyBin;
    }
  }

  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(cmd, ['agy'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l));
    if (first) {
      cachedAgyBin = first;
      cachedAgyCheckedAt = Date.now();
      return cachedAgyBin;
    }
  } catch {}

  throw new Error('未找到本地 Antigravity CLI (agy) 可执行文件。');
}

export function resetAntigravityThread(convId, { clearHistory = false } = {}) {
  const safeConv = sanitizeConvId(convId);
  const dir = ensureRoomDir(safeConv);
  const prev = readMeta(safeConv);
  const nextEpoch = (Number(prev.roomEpoch) || 1) + 1;

  if (clearHistory) {
    try { rmSync(join(dir, 'messages.jsonl'), { force: true }); } catch {}
    messagesCache.delete(safeConv);
  } else {
    appendMessage(safeConv, {
      sender: 'system',
      senderLabel: '系统',
      text: '已开启新的 Antigravity 协商上下文',
    });
  }
  return writeMeta(safeConv, {
    roomEpoch: nextEpoch,
    messageCount: clearHistory ? 0 : readMessages(safeConv).length,
    agyConversationId: null,
    cancelRequestedAt: Date.now(),
    status: 'idle',
    turnLease: null,
    activeTurn: null,
    lastError: null,
  });
}

export async function runAntigravityTurn({
  convId,
  prompt,
  displayText,
  sender = 'codex',
  senderLabel = 'Codex',
  model,
  effort = 'medium',
  cwd,
  newThread = false,
  allowPeerRecursion = false,
  onChild,
}) {
  if (!allowPeerRecursion && process.env.AGY_CODEX_PEER_CALL === '1') {
    throw new Error('[Peer Guard] 当前已处于双 AI 同侪被调用回合（AGY_CODEX_PEER_CALL=1），请直接给出独立结论，禁止反向递归调用 talk_antigravity.mjs。');
  }

  const safeConv = sanitizeConvId(convId);
  return enqueueWrite(safeConv, async () => {
    const rawText = String(prompt || '').trim();
    const bubbleText = String(displayText || prompt || '').trim();
    if (!rawText) throw new Error('发送内容不能为空。');

    const agyExe = findAgyBinary();
    const { leaseId, roomEpoch, meta: prevMeta } = acquireRoomTurnLease(safeConv, 'agy-cli');
    const releaseWatcher = retainDirWatcher(safeConv);
    const hbTimer = setInterval(() => heartbeatRoomTurnLease(safeConv, leaseId), HEARTBEAT_INTERVAL_MS);
    if (typeof hbTimer.unref === 'function') hbTimer.unref();

    let spillDir = null;
    try {
      const chosenCwd = normalizeDirPath(cwd || prevMeta.cwd || ensureRoomDir(safeConv));
      mkdirSync(chosenCwd, { recursive: true });

      const cwdChanged = prevMeta.cwd && normalizeDirPath(prevMeta.cwd).toLowerCase() !== chosenCwd.toLowerCase();
      const agyConvToResume = (newThread || cwdChanged) ? null : (prevMeta.agyConversationId || null);

      appendMessage(safeConv, {
        sender,
        senderLabel,
        text: bubbleText,
        model: prevMeta.model || 'codex',
        effort,
      }, { expectedEpoch: roomEpoch, expectedLeaseId: leaseId, requireExists: true });

      const startedAt = Date.now();
      const activeTurn = {
        id: `turn_${randomUUID().slice(0, 8)}`,
        startedAt,
        sender,
        liveStatus: 'Waiting for Antigravity…',
        reasoningSummary: '',
        streamingText: '',
        diff: '',
        plan: [],
        pendingApprovals: [],
        steps: [],
      };

      writeMeta(safeConv, {
        cwd: prevMeta.cwd || chosenCwd,
        agyConversationId: agyConvToResume,
        status: 'thinking',
        activeTurn,
        lastError: null,
      }, { expectedEpoch: roomEpoch, expectedLeaseId: leaseId, requireExists: true });

      // Spill prompts >12KB into a per-turn isolated temp subdirectory (zero cross-room sharing!)
      let promptArg = rawText;
      if (rawText.length > 12000) {
        spillDir = createIsolatedPromptSpillDir();
        const tempPromptFile = join(spillDir, 'prompt.md');
        writeFileSync(tempPromptFile, rawText, { encoding: 'utf-8', mode: 0o600 });
        promptArg = `请完整读取文件 ${tempPromptFile} 中的同侪协商上下文与代码变更，并严格按照其中的协作规程直接回复。`;
      }

      const args = [
        '--output-format=json',
        '--disable-slash-commands',
        `--effort=${effort || 'medium'}`,
        `--add-dir=${chosenCwd}`,
      ];
      if (spillDir) args.push(`--add-dir=${spillDir}`);
      if (model) args.push(`--model=${model}`);
      if (agyConvToResume) args.push(`--conversation=${agyConvToResume}`);
      args.push(`--print=${promptArg}`);

      const childEnv = { ...process.env, AGY_CODEX_PEER_CALL: '1' };
      delete childEnv.NODE_OPTIONS;

      return await new Promise((resolveTurn, rejectTurn) => {
        let stdoutBuf = '';
        let stderrBuf = '';
        let wasCancelled = false;

        const child = spawn(agyExe, args, {
          cwd: chosenCwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        if (typeof onChild === 'function') onChild(child);

        const checkExternalCancel = () => {
          try {
            if (!existsSync(getRoomDir(safeConv))) {
              wasCancelled = true;
              try { child.kill(); } catch {}
              return;
            }
            const cur = readMeta(safeConv);
            if (((cur.cancelRequestedAt && cur.cancelRequestedAt >= startedAt) || (cur.roomEpoch || 1) !== roomEpoch) && !wasCancelled) {
              wasCancelled = true;
              try { child.kill(); } catch {}
            }
          } catch {}
        };
        roomEvents.on(`change:${safeConv}`, checkExternalCancel);

        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => { stdoutBuf += chunk; });

        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

        child.on('error', (err) => {
          roomEvents.off(`change:${safeConv}`, checkExternalCancel);
          releaseRoomTurnLease(safeConv, leaseId, { status: 'error', activeTurn: null, lastError: err.message });
          rejectTurn(err);
        });

        child.on('close', (code) => {
          roomEvents.off(`change:${safeConv}`, checkExternalCancel);
          const durationMs = Date.now() - startedAt;

          if (wasCancelled) {
            const cancelledEntry = appendMessage(safeConv, {
              sender: 'antigravity',
              senderLabel: 'Antigravity',
              text: '*(回合已手动中止)*',
              durationMs,
            }, { expectedEpoch: roomEpoch, requireExists: true });
            const finalMeta = releaseRoomTurnLease(safeConv, leaseId, { status: 'idle', activeTurn: null, lastError: null });
            resolveTurn({
              conversationId: safeConv,
              agyConversationId: agyConvToResume,
              reply: cancelledEntry?.text || '*(回合已手动中止)*',
              cancelled: true,
              durationMs,
              meta: finalMeta,
            });
            return;
          }

          let parsed = null;
          for (const line of stdoutBuf.trim().split(/\r?\n/).reverse()) {
            const t = line.trim();
            if (t.startsWith('{') && t.endsWith('}')) {
              try { parsed = JSON.parse(t); break; } catch {}
            }
          }

          const isSuccess = code === 0 && parsed && parsed.status === 'SUCCESS' && typeof parsed.response === 'string';
          const resolvedAgyConvId = parsed?.conversation_id || agyConvToResume || null;

          if (!isSuccess) {
            const errMsg = (parsed?.error || stderrBuf || stdoutBuf || `agy exited with code ${code}`).trim().slice(-600);
            releaseRoomTurnLease(safeConv, leaseId, {
              agyConversationId: resolvedAgyConvId,
              status: 'error',
              activeTurn: null,
              lastError: errMsg,
            });
            rejectTurn(new Error(errMsg));
            return;
          }

          const replyText = parsed.response.trim();
          const replyEntry = appendMessage(safeConv, {
            sender: 'antigravity',
            senderLabel: 'Antigravity',
            text: replyText || '（无输出内容）',
            durationMs,
            tokenCount: parsed.usage?.total_tokens ?? null,
          }, { expectedEpoch: roomEpoch, requireExists: true });

          const finalMeta = releaseRoomTurnLease(safeConv, leaseId, {
            agyConversationId: resolvedAgyConvId,
            status: 'idle',
            activeTurn: null,
            lastError: null,
          });

          resolveTurn({
            conversationId: safeConv,
            agyConversationId: resolvedAgyConvId,
            reply: replyEntry?.text || replyText,
            durationMs,
            tokenUsage: parsed.usage || null,
            meta: finalMeta,
          });
        });
      });
    } catch (err) {
      releaseRoomTurnLease(safeConv, leaseId, { status: 'error', activeTurn: null, lastError: err.message });
      throw err;
    } finally {
      clearInterval(hbTimer);
      releaseWatcher();
      if (spillDir) {
        try { rmSync(spillDir, { recursive: true, force: true }); } catch {}
      }
    }
  });
}
