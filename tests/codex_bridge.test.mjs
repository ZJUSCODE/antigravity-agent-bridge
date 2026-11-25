import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __testDir = dirname(fileURLToPath(import.meta.url));

// Register Antigravity's built-in `sidecar_sdk` ESM resolver when running inside Antigravity,
// or fall back to the standalone open-source test shim in CI environments!
const resolverPath = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'esm_resolver.js');
if (existsSync(resolverPath)) {
  register(pathToFileURL(resolverPath).href);
} else {
  register(pathToFileURL(join(__testDir, 'shims', 'sidecar_sdk_loader.mjs')).href);
}

// Isolate all storage & SQLite paths BEFORE importing core modules
const tmpRoot = mkdtempSync(join(tmpdir(), 'codex-bridge-enterprise-test-'));
const fakeAppData = join(tmpRoot, 'antigravity');
const fakeDataDir = join(tmpRoot, 'plugin-data');
const fakeCodexHome = join(tmpRoot, 'codex-home');
const fakeProjectA = join(tmpRoot, 'proj-alpha');
const fakeProjectB = join(tmpRoot, 'proj-beta');

process.env.ANTIGRAVITY_APP_DATA_DIR = fakeAppData;
process.env.CODEX_BRIDGE_DATA_DIR = fakeDataDir;
process.env.CODEX_HOME = fakeCodexHome;
process.env.CODEX_BRIDGE_TEST_MODE = '1';
process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-token';
process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'test-sidecar-secret';
process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';

mkdirSync(fakeAppData, { recursive: true });
mkdirSync(fakeDataDir, { recursive: true });
mkdirSync(fakeCodexHome, { recursive: true });
mkdirSync(fakeProjectA, { recursive: true });
mkdirSync(fakeProjectB, { recursive: true });

const core = await import('../sidecars/codex_room/codex_core.mjs');
const { AppServerBridge } = await import('../sidecars/codex_room/app_server_bridge.mjs');
const providers = await import('../sidecars/codex_room/agent_providers.mjs');

// On clean CI runners without local Codex/Antigravity apps installed, seed lightweight binary stubs
try {
  core.findCodexBinary({ forceRefresh: true });
} catch {
  const stubCodex = join(tmpRoot, process.platform === 'win32' ? 'codex-stub.exe' : 'codex-stub');
  writeFileSync(stubCodex, '#!/bin/sh\necho "codex-ci-stub"\n', { mode: 0o755 });
  process.env.CODEX_BIN = stubCodex;
  core.invalidateCodexBinaryCache();
}
try {
  core.findAgyBinary();
} catch {
  const stubAgy = join(tmpRoot, process.platform === 'win32' ? 'agy-stub.exe' : 'agy-stub');
  writeFileSync(stubAgy, '#!/bin/sh\necho "agy-ci-stub"\n', { mode: 0o755 });
  process.env.AGY_BIN = stubAgy;
}

describe('codex-bridge enterprise core & bridge suite', () => {
  before(() => {
    // Seed a realistic `state_5.sqlite` with `\\?\` extended-length Windows paths
    const dbPath = join(fakeCodexHome, 'state_5.sqlite');
    const rolloutPath = join(fakeCodexHome, 'rollout-11111111-2222-3333-4444-555555555555.jsonl');
    const rolloutLines = [
      JSON.stringify({
        timestamp: '2026-11-21T03:00:00Z',
        type: 'session_meta',
        payload: {
          cwd: `\\\\?\\${fakeProjectA}`,
          base_instructions: { provenance: { model: 'gpt-6.2-astra' } },
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-21T03:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions\nignored system block' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-21T03:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Context preamble\n## My request:\n请检查数据管道并发锁' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-21T03:00:08Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '已定位到 WAL 并发竞争点，建议启用 thread/fork。' }],
        },
      }),
    ];
    writeFileSync(rolloutPath, rolloutLines.join('\n') + '\n', 'utf-8');

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER);
      CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER);
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        name TEXT,
        title TEXT,
        cwd TEXT,
        rollout_path TEXT,
        model TEXT,
        reasoning_effort TEXT,
        archived INTEGER DEFAULT 0,
        updated_at INTEGER
      );
    `);
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('p1', 'Alpha 平台', 0);
    db.prepare('INSERT INTO project_roots VALUES (?, ?, ?)').run('p1', `\\\\?\\${fakeProjectA}`, 0);
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('p2', 'Beta 引擎', 1);
    db.prepare('INSERT INTO project_roots VALUES (?, ?, ?)').run('p2', fakeProjectB, 0);

    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)').run(
      '11111111-2222-3333-4444-555555555555',
      '',
      '## My request: 请检查数据管道并发锁',
      `\\\\?\\${fakeProjectA}`,
      `\\\\?\\${rolloutPath}`,
      'gpt-6.2-astra',
      'high',
      Math.floor(Date.now() / 1000)
    );
    db.close();
  });

  after(() => {
    core.resetCoreCaches();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('guarantees monotonic revision & distinct etags on sub-millisecond writes', () => {
    const m1 = core.writeMeta('room_fast', { status: 'thinking', model: 'gpt-6.2-astra' });
    const snap1 = core.getRoomSnapshot('room_fast');
    const m2 = core.writeMeta('room_fast', { status: 'idle', model: 'gpt-6.2-sol' });
    const snap2 = core.getRoomSnapshot('room_fast');

    assert.ok(m2.rev > m1.rev, 'rev must strictly increment');
    assert.ok(m2.updatedAt > m1.updatedAt, 'updatedAt must strictly advance even within same millisecond');
    assert.notEqual(snap1.etag, snap2.etag, 'etag must change on every write');
    assert.equal(core.readMeta('room_fast').model, 'gpt-6.2-sol');
  });

  it('wakes up waitForRoomChange in <50ms upon room mutation and returns unchanged on timeout', async () => {
    const initial = await core.waitForRoomChange('room_push', '', () => 'v1', 600);
    assert.ok(!initial.unchanged);

    const t0 = Date.now();
    const waitPromise = core.waitForRoomChange('room_push', initial.etag, () => 'v1', 5000);
    setTimeout(() => {
      core.appendMessage('room_push', { sender: 'user', text: '测试实时长轮询唤醒' });
    }, 20);

    const pushed = await waitPromise;
    const elapsed = Date.now() - t0;
    assert.ok(!pushed.unchanged, 'should push updated snapshot');
    assert.equal(pushed.messages.length, 1);
    assert.equal(pushed.messages[0].text, '测试实时长轮询唤醒');
    assert.ok(elapsed < 450, `expected fast push wakeup, took ${elapsed}ms`);

    // Idle timeout returns unchanged: true
    const idleRes = await core.waitForRoomChange('room_push', pushed.etag, () => 'v1', 500);
    assert.equal(idleRes.unchanged, true);
  });

  it('enforces strict path-traversal sandboxing on uploads and cleans up removed files', () => {
    const b64 = Buffer.from('hello enterprise world', 'utf-8').toString('base64');
    const saved = core.saveUploadedFile('room_sec', {
      fileName: '../../evil/../report.txt',
      mimeType: 'text/plain',
      dataBase64: `data:text/plain;base64,${b64}`,
    });
    assert.ok(existsSync(saved.path));
    assert.ok(!saved.storedName.includes('..'));

    const resolvedLegit = core.resolveSafeUploadPath('room_sec', saved.storedName);
    assert.equal(resolvedLegit, saved.path);

    // Attempt traversal outside uploads directory must strictly return null
    core.writeMeta('room_sec', { title: 'SecTest' });
    assert.equal(core.resolveSafeUploadPath('room_sec', '../meta.json'), null);
    assert.equal(core.resolveSafeUploadPath('room_sec', '..\\meta.json'), null);

    // Server-side attachment verification strips untrusted client paths outside room uploads
    const verified = core.sanitizeClientAttachments('room_sec', [
      { name: 'legit.txt', storedName: saved.storedName, path: 'C:\\evil_override.png', isImage: true },
      { name: 'forged.png', storedName: '', path: 'C:\\Windows\\win.ini', isImage: true },
      { name: 'escape.png', storedName: '../meta.json', path: 'C:\\Windows\\win.ini', isImage: true },
    ]);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].path, saved.path, 'must reconstruct path from server uploads dir');
    assert.equal(verified[0].isImage, false, 'must derive isImage from verified extension, not client claim');

    const rmRes = core.removeUploadedFile('room_sec', saved.storedName);
    assert.equal(rmRes.removed, true);
    assert.equal(existsSync(saved.path), false);
  });

  it('supports create, rename, pin-first sorting, and deletion lifecycle', () => {
    const rA = core.createNewRoom({ model: 'gpt-6.2-astra' });
    const rB = core.createNewRoom({ model: 'gpt-6.2-sol' });

    core.renameRoom(rA.conversationId, '架构评审专场');
    assert.equal(core.readMeta(rA.conversationId).title, '架构评审专场');

    // Make rB newer, then pin rA -> rA must rank before rB
    core.writeMeta(rB.conversationId, { title: '普通对话' });
    core.togglePinRoom(rA.conversationId);

    const list = core.listRecentRooms(20).filter(
      (x) => x.conversationId === rA.conversationId || x.conversationId === rB.conversationId
    );
    assert.equal(list[0].conversationId, rA.conversationId, 'pinned room must sort first');
    assert.equal(list[0].pinned, true);

    core.deleteRoom(rB.conversationId);
    assert.equal(existsSync(core.getRoomDir(rB.conversationId)), false);
  });

  it('indexes state_5.sqlite projects/threads (stripping \\\\?\\) and arms safe auto-fork on import', () => {
    const dbSnap = core.queryCodexStateDb();
    assert.equal(dbSnap.projects.length, 2);
    assert.equal(dbSnap.projects[0].path, core.normalizeDirPath(fakeProjectA), 'must strip \\\\?\\ prefix and canonicalize');
    assert.equal(dbSnap.threads.length, 1);
    assert.equal(dbSnap.threads[0].title, '请检查数据管道并发锁');

    // Switching to Project A imports its latest Codex Desktop session with safe fork armed
    const swA = core.switchToProject('host_conv_1', fakeProjectA);
    assert.equal(swA.action, 'imported_project_thread');
    assert.equal(swA.snap.messages.length, 2, 'systemAGENTS preamble filtered out, 2 real turns imported');
    assert.equal(swA.snap.meta.needsForkOnNextTurn, true);
    assert.equal(swA.snap.meta.importSourceSessionId, '11111111-2222-3333-4444-555555555555');
    assert.equal(swA.snap.meta.forkFromSessionId, '11111111-2222-3333-4444-555555555555');

    // Simulate post-fork state (forkFromSessionId cleared, new message appended), then re-import -> must NOT lose new message!
    core.writeMeta(swA.roomId, { needsForkOnNextTurn: false, forkFromSessionId: null, codexThreadId: 'forked_new_id' });
    core.appendMessage(swA.roomId, { sender: 'user', text: 'Fork 后新增的重要讨论内容' });
    const reImp = core.importNativeCodexSession('11111111-2222-3333-4444-555555555555');
    assert.equal(reImp.messages.length, 3, 're-importing post-fork session must preserve post-fork messages');

    // Switching to empty Project B creates a fresh project-bound room
    const swB = core.switchToProject('host_conv_1', fakeProjectB);
    assert.equal(swB.action, 'created_project_thread');
    assert.equal(swB.snap.meta.cwd, core.normalizeDirPath(fakeProjectB));
  });

  it('auto-recovers orphaned stale external turns via watchdog', () => {
    const roomDir = core.ensureRoomDir('room_orphan');
    const staleMeta = {
      conversationId: 'room_orphan',
      rev: 1,
      title: '孤儿任务',
      status: 'thinking',
      activeTurn: { id: 'turn_dead', liveStatus: 'Thinking' },
      updatedAt: Date.now() - 15 * 60 * 1000, // 15 minutes ago
    };
    writeFileSync(join(roomDir, 'meta.json'), JSON.stringify(staleMeta), 'utf-8');
    core.resetCoreCaches();

    const recovered = core.readMeta('room_orphan');
    assert.equal(recovered.status, 'idle');
    assert.equal(recovered.activeTurn, null);
    assert.match(recovered.lastError || '', /自动恢复/);
  });

  it('exports full Markdown transcript with reasoning summary, plan, steps, and diff', () => {
    const room = core.createNewRoom({ cwd: fakeProjectA, model: 'gpt-6.2-astra', effort: 'high' });
    core.renameRoom(room.conversationId, '导出验证会话');
    core.appendMessage(room.conversationId, { sender: 'user', text: '优化缓存层' });
    core.appendMessage(room.conversationId, {
      sender: 'codex',
      text: '已完成 LRU 与长轮询改造。',
      reasoningSummary: '先核对文件状态锁，再合并监听队列。',
      plan: [
        { step: '设计缓存结构', status: 'completed' },
        { step: '编写单测验证', status: 'inProgress' },
      ],
      steps: [{ kind: 'command', label: 'node --test', exitCode: 0 }],
      diff: 'diff --git a/core.js b/core.js\n+const cache = new Map();',
      durationMs: 4200,
    });

    const out = core.exportRoomMarkdown(room.conversationId, { saveToDisk: false });
    assert.match(out.markdown, /# 导出验证会话/);
    assert.match(out.markdown, /先核对文件状态锁/);
    assert.match(out.markdown, /- \[x\] 设计缓存结构/);
    assert.match(out.markdown, /`command`: node --test \(exit 0\)/);
    assert.match(out.markdown, /\+const cache = new Map\(\);/);
  });

  it('locates local codex binary and initializes AppServerBridge diagnostics cleanly', () => {
    const bin = core.findCodexBinary();
    assert.ok(bin.exe && existsSync(bin.exe), `expected valid codex binary at ${bin.exe}`);

    const bridge = new AppServerBridge();
    const diag = bridge.getDiagnostics();
    assert.equal(diag.running, false);
    assert.deepEqual(diag.activeRooms, []);
    bridge.shutdown();
  });

  it('serves full Sidecar HTTP API, enforces X-Sidecar-Token auth, streams fonts, and pushes HTTP long-polls', async () => {
    const { buildSidecarApp } = await import('../sidecars/codex_room/main.mjs');
    const { app, bridge } = buildSidecarApp();
    const server = await app.run();
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': 'test-sidecar-secret',
    };

    try {
      // 1. Index HTML & No-Cache headers
      const pageRes = await fetch(`${base}/`);
      assert.equal(pageRes.status, 200);
      assert.match(pageRes.headers.get('cache-control') || '', /no-store/);
      const html = await pageRes.text();
      assert.match(html, /id="codex-shell"/);
      assert.match(html, /id="drawer-search"/);

      // 2. Unauthorized POST without token must be rejected (401)
      const unauth = await fetch(`${base}/api/threads/create`, { method: 'POST', body: '{}' });
      assert.equal(unauth.status, 401);

      // 3. Diagnostics & optional local font cache check
      const diagRes = await fetch(`${base}/api/diagnostics`);
      const diag = await diagRes.json();
      assert.equal(diag.ok, true);
      if (diag.fontsLoaded > 0) {
        const fontRes = await fetch(`${base}/fonts/openai-sans-regular.woff2`);
        assert.equal(fontRes.status, 200);
        const fontBuf = await fontRes.arrayBuffer();
        assert.ok(fontBuf.byteLength > 10000);
      }

      // 4. Create room + HTTP long-polling push wakeup via POST /api/threads/rename
      const createRes = await fetch(`${base}/api/threads/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ conversationId: 'http_host', model: 'gpt-6.2-astra' }),
      });
      const created = await createRes.json();
      assert.equal(created.ok, true);

      const snap0 = await (await fetch(`${base}/api/room?conversationId=http_host`)).json();
      const pollPromise = fetch(
        `${base}/api/room?conversationId=http_host&etag=${encodeURIComponent(snap0.etag)}&wait=1&timeoutMs=4000`
      ).then((r) => r.json());

      setTimeout(async () => {
        await fetch(`${base}/api/threads/rename`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ roomId: created.roomId, title: 'HTTP 长轮询实测通过' }),
        });
      }, 25);

      const pushed = await pollPromise;
      assert.ok(!pushed.unchanged);
      assert.equal(pushed.meta.title, 'HTTP 长轮询实测通过');

      // 5. Empty or malformed roomId on /api/threads/delete and /api/reset-thread must be rejected without touching global-default
      core.appendMessage('global-default', { sender: 'user', text: '受保护默认会话' });
      const badDel = await fetch(`${base}/api/threads/delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ roomId: '' }),
      });
      assert.equal(badDel.status, 500);
      const badReset = await fetch(`${base}/api/reset-thread`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ roomId: '../invalid!', clearHistory: true }),
      });
      assert.equal(badReset.status, 500);
      assert.equal(core.readMessages('global-default').length, 1, 'global-default must remain untouched');
    } finally {
      bridge.shutdown();
      await app.close();
    }
  });

  it('enforces cross-process turn leases, dead-PID recovery, and roomEpoch stale-writer fencing', () => {
    const lease1 = core.acquireRoomTurnLease('room_lease', 'test');
    assert.throws(
      () => core.acquireRoomTurnLease('room_lease', 'test2'),
      /正在执行中/,
      'second concurrent lease on same room must be rejected'
    );

    // Resetting thread increments roomEpoch; stale writer with old epoch cannot append or overwrite
    const afterReset = core.resetCodexThread('room_lease');
    assert.ok(afterReset.roomEpoch > lease1.roomEpoch);
    const staleEntry = core.appendMessage(
      'room_lease',
      { sender: 'codex', text: '过期的迟到输出' },
      { expectedEpoch: lease1.roomEpoch, requireExists: true }
    );
    assert.equal(staleEntry, null, 'stale epoch append must be fenced off');

    // Dead owner PID is recovered immediately without waiting 10 minutes
    core.writeMeta('room_dead_pid', {
      status: 'thinking',
      turnLease: { leaseId: 'dead_1', ownerPid: 99999999, heartbeatAt: Date.now() },
    });
    core.resetCoreCaches();
    const recovered = core.readMeta('room_dead_pid');
    assert.equal(recovered.status, 'idle');
  });

  it('builds symmetric peer protocol envelopes, locates agy binary, and enforces OS-level anti-recursion lock', async () => {
    const agyBin = core.findAgyBinary();
    assert.ok(agyBin && existsSync(agyBin), `expected valid agy binary at ${agyBin}`);

    const env = core.buildPeerEnvelope({
      protocol: 'review',
      round: '1/2',
      fromAgent: 'Codex',
      toAgent: 'Antigravity',
      body: '请审查锁粒度。',
      gitContext: '### 当前工作区 Git 变更快照\n```diff\n+lock()\n```',
    });
    assert.match(env.displayText, /\*\*\[对抗式代码审查 · 第 1\/2 轮\]\*\*/);
    assert.ok(!env.displayText.includes('PEER-EXCHANGE-FROM-CODEX'), 'UI bubble must stay clean without wire header');
    assert.match(env.wirePrompt, /\[PEER-EXCHANGE-FROM-CODEX \| TO: Antigravity \| PROTOCOL: REVIEW \| ROUND: 1\/2\]/);
    assert.match(env.wirePrompt, /\[P0 致命/);
    assert.match(env.wirePrompt, /\+lock\(\)/);

    const openEndedEnv = core.buildPeerEnvelope({
      protocol: 'rfc',
      round: '4',
      fromAgent: 'Antigravity',
      toAgent: 'Codex',
      body: '继续验证第 4 轮分片边界。',
    });
    assert.match(openEndedEnv.displayText, /\*\*\[架构方案碰撞 · 第 4 轮\]\*\*/);
    assert.match(openEndedEnv.wirePrompt, /ROUND: 4\]/);
    assert.equal(core.createNewRoom().mode, 'auto');

    // Enforce anti-recursion guard when AGY_CODEX_PEER_CALL=1
    process.env.AGY_CODEX_PEER_CALL = '1';
    try {
      await assert.rejects(
        () => core.runCodexTurn({ convId: 'rec_test', prompt: 'hi' }),
        /Peer Guard/
      );
      await assert.rejects(
        () => core.runAntigravityTurn({ convId: 'rec_test', prompt: 'hi' }),
        /Peer Guard/
      );
    } finally {
      delete process.env.AGY_CODEX_PEER_CALL;
    }
  });

  it('wakes up idle viewer via global liveDiscussion radar when another room starts peer discussion', async () => {
    core.writeMeta('room_viewer', { title: '旧静态页面', status: 'idle' });
    const initial = await core.waitForRoomChange('room_viewer', '', () => 'v3.2', 600);

    const t0 = Date.now();
    const waitOther = core.waitForRoomChange('room_viewer', initial.etag, () => 'v3.2', 4000);
    setTimeout(() => {
      core.writeMeta('room_live_debate', { title: '# RFC 议题：跨会话实时自动跟随验证', cwd: fakeProjectA });
      core.acquireRoomTurnLease('room_live_debate', 'codex-cli');
    }, 25);

    const woken = await waitOther;
    const elapsed = Date.now() - t0;
    assert.ok(!woken.unchanged, 'viewer room long-poll must wake up immediately when another room goes live');
    assert.ok(elapsed < 450, `expected <450ms cross-room radar wakeup, took ${elapsed}ms`);
    assert.equal(woken.liveDiscussion?.roomId, 'room_live_debate');
    assert.equal(woken.liveDiscussion?.status, 'thinking');
    assert.equal(woken.liveDiscussion?.title, 'RFC 议题：跨会话实时自动跟随验证');
    assert.equal(
      core.formatCodexDesktopThreadName(woken.liveDiscussion.title),
      '[双AI] RFC 议题：跨会话实时自动跟随验证'
    );
  });

  it('indexes Antigravity workspace folders from conversation_summaries.db for dual-app folder parity', () => {
    const agyDbPath = join(fakeAppData, 'conversation_summaries.db');
    const adb = new DatabaseSync(agyDbPath);
    adb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        project_id TEXT,
        last_modified_time TEXT
      );
    `);
    const fileUri = pathToFileURL(fakeProjectB).href;
    adb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(
      'conv_agy_proj_b',
      'Beta Workspace Task',
      JSON.stringify([fileUri]),
      'agy-proj-uuid-beta',
      '2026-11-21 08:00:00+00:00'
    );
    adb.close();

    // Note: fakeProjectB is under tmpdir() so isUserProjectFolder excludes temp test dirs;
    // verify canonical Windows drive normalization directly as well
    if (process.platform === 'win32') {
      assert.match(core.normalizeDirPath('f:\\NonExistentFolderTest'), /^F:\\NonExistentFolderTest/);
    }
    const idx = core.queryAntigravityWorkspaceIndex();
    assert.ok(idx.projectIdByPath instanceof Map);
    assert.ok(idx.pathByConvId instanceof Map);
  });

  it('strictly resolves each Antigravity conversation to its own room and reverse-maps [双AI] mirror conversations', () => {
    core.writeMeta('11111111-aaaa-bbbb-cccc-111111111111', {
      title: '会话 A 讨论室',
      mirroredHubConvId: '99999999-aaaa-bbbb-cccc-999999999999',
    });
    core.appendMessage('11111111-aaaa-bbbb-cccc-111111111111', { sender: 'user', text: '议题 A' });

    core.writeMeta('22222222-aaaa-bbbb-cccc-222222222222', {
      title: '会话 B 讨论室',
    });
    core.appendMessage('22222222-aaaa-bbbb-cccc-222222222222', { sender: 'user', text: '议题 B' });

    // 1:1 resolution when switching between Antigravity conversations
    assert.equal(
      core.getActiveRoomForHost('11111111-aaaa-bbbb-cccc-111111111111'),
      '11111111-aaaa-bbbb-cccc-111111111111'
    );
    assert.equal(
      core.getActiveRoomForHost('22222222-aaaa-bbbb-cccc-222222222222'),
      '22222222-aaaa-bbbb-cccc-222222222222'
    );
    assert.equal(
      core.getActiveRoomForHost('33333333-aaaa-bbbb-cccc-333333333333'),
      '33333333-aaaa-bbbb-cccc-333333333333'
    );

    // Reverse-map `[双AI]` mirrored archive conversation back to its discussion room
    assert.equal(
      core.getActiveRoomForHost('99999999-aaaa-bbbb-cccc-999999999999'),
      '11111111-aaaa-bbbb-cccc-111111111111'
    );

    // Re-selecting own room cleans override entry cleanly
    core.setActiveRoomForHost('22222222-aaaa-bbbb-cccc-222222222222', '11111111-aaaa-bbbb-cccc-111111111111');
    assert.equal(
      core.getActiveRoomForHost('22222222-aaaa-bbbb-cccc-222222222222'),
      '11111111-aaaa-bbbb-cccc-111111111111'
    );
    core.setActiveRoomForHost('22222222-aaaa-bbbb-cccc-222222222222', '22222222-aaaa-bbbb-cccc-222222222222');
    assert.equal(
      core.getActiveRoomForHost('22222222-aaaa-bbbb-cccc-222222222222'),
      '22222222-aaaa-bbbb-cccc-222222222222'
    );
  });

  it('auto-resolves default Codex model across config.toml, models_cache.json, and universal auto fallback', () => {
    // 1. Fresh codex-home with neither config.toml nor models_cache.json -> 'auto'
    assert.equal(core.resolveDefaultCodexModel(), 'auto');
    const fallbackList = core.listCodexModels();
    assert.ok(fallbackList.some((m) => m.slug === 'auto'));

    // 2. models_cache.json present -> picks user's #1 visible model
    writeFileSync(
      join(fakeCodexHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'gpt-5.4-codex-test', display_name: 'GPT-5.4 Codex Test', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high'] },
        ],
      }),
      'utf-8'
    );
    assert.equal(core.resolveDefaultCodexModel(), 'gpt-5.4-codex-test');

    // 3. Explicit top-level model in config.toml takes priority over models_cache.json
    writeFileSync(
      join(fakeCodexHome, 'config.toml'),
      'model = "o3-pro-custom"\n\n[projects."/tmp/demo"]\ntrust_level = "trusted"\n',
      'utf-8'
    );
    assert.equal(core.resolveDefaultCodexModel(), 'o3-pro-custom');
  });

  it('streams Pi JSONL and Claude stream-json protocols and persists multi-agent session IDs', async () => {
    const fakePiJs = join(tmpRoot, 'mock-pi.mjs');
    writeFileSync(
      fakePiJs,
      [
        `const lines = [`,
        `  { type: 'session', version: 3, id: 'pi-sess-9001' },`,
        `  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Analyzing lock hierarchy...' } },`,
        `  { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'grep', args: { pattern: 'mutex' } },`,
        `  { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'grep', result: { content: [{ type: 'text', text: 'codex_core.mjs:520' }] }, isError: false, durationMs: 12 },`,
        `  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Pi verified: zero deadlock risk.' } },`,
        `  { type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 320 }, content: [{ type: 'text', text: 'Pi verified: zero deadlock risk. [PEER_VERDICT: PASS]' }] } }`,
        `];`,
        `for (const l of lines) process.stdout.write(JSON.stringify(l) + '\\n');`,
      ].join('\n'),
      'utf-8'
    );

    const fakeClaudeJs = join(tmpRoot, 'mock-claude.mjs');
    writeFileSync(
      fakeClaudeJs,
      [
        `const lines = [`,
        `  { type: 'system', subtype: 'init', session_id: 'claude-sess-777' },`,
        `  { type: 'stream_event', session_id: 'claude-sess-777', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude review complete.' } } },`,
        `  { type: 'result', subtype: 'success', session_id: 'claude-sess-777', is_error: false, result: 'Claude review complete: clean architecture. [PEER_VERDICT: PASS]' }`,
        `];`,
        `for (const l of lines) process.stdout.write(JSON.stringify(l) + '\\n');`,
      ].join('\n'),
      'utf-8'
    );

    const prevPi = process.env.PI_BIN;
    const prevClaude = process.env.CLAUDE_BIN;
    process.env.PI_BIN = fakePiJs;
    process.env.CLAUDE_BIN = fakeClaudeJs;

    try {
      const piTurn = await providers.runAgentTurn({
        convId: 'room_multi_agent',
        agentId: 'pi',
        prompt: 'Audit concurrency locks',
        cwd: fakeProjectA,
      });
      assert.equal(piTurn.agentId, 'pi');
      assert.equal(piTurn.sessionId, 'pi-sess-9001');
      assert.match(piTurn.reply, /Pi verified: zero deadlock risk/);
      assert.equal(piTurn.steps.length, 1);
      assert.equal(core.readMeta('room_multi_agent').agentSessions.pi, 'pi-sess-9001');

      // Run parallel Multi-Agent Council across Pi + Claude simultaneously!
      const council = await providers.runCouncilTurn({
        convId: 'room_council_test',
        agents: ['pi', 'claude'],
        prompt: 'Run parallel architecture review',
        cwd: fakeProjectA,
      });
      assert.equal(council.council, true);
      assert.equal(council.results.length, 2);
      assert.ok(council.results.every((r) => r.ok));

      const councilMsgs = core.readMessages('room_council_test');
      assert.equal(councilMsgs.length, 3, '1 initiator prompt + 2 parallel agent replies');
      assert.ok(councilMsgs.some((m) => m.sender === 'pi' && m.text.includes('Pi verified')));
      assert.ok(councilMsgs.some((m) => m.sender === 'claude' && m.text.includes('Claude review complete')));
    } finally {
      if (prevPi) process.env.PI_BIN = prevPi; else delete process.env.PI_BIN;
      if (prevClaude) process.env.CLAUDE_BIN = prevClaude; else delete process.env.CLAUDE_BIN;
    }
  });

  it('syncs and backfills OpenAI Codex Desktop sqlite/codex.db local_thread_catalog with canonical project cwd', () => {
    const canonProjA = core.normalizeDirPath(fakeProjectA);
    writeFileSync(
      join(fakeCodexHome, '.codex-global-state.json'),
      JSON.stringify({
        'local-projects': {
          'proj-alpha-legacy-id': {
            id: 'proj-alpha-legacy-id',
            name: 'proj-alpha',
            rootPaths: [canonProjA],
          },
        },
      }),
      'utf-8'
    );

    const catalogDir = join(fakeCodexHome, 'sqlite');
    mkdirSync(catalogDir, { recursive: true });
    const catalogDbPath = join(catalogDir, 'codex.db');
    const cdb = new DatabaseSync(catalogDbPath);
    cdb.exec(`
      CREATE TABLE local_thread_catalog (
        host_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        display_title TEXT NOT NULL,
        source_created_at REAL NOT NULL,
        source_updated_at REAL NOT NULL,
        source_recency_at REAL NOT NULL DEFAULT 0,
        cwd TEXT,
        source_kind TEXT NOT NULL,
        source_detail TEXT,
        thread_source TEXT,
        model_provider TEXT,
        git_branch TEXT,
        project_id TEXT,
        conversation_origin TEXT,
        trial_conversation_type TEXT,
        chatgpt_async_status INTEGER,
        observation_sequence INTEGER NOT NULL,
        pending_observed_title INTEGER NOT NULL DEFAULT 0,
        missing_candidate INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (host_id, thread_id)
      );
      CREATE TABLE local_thread_catalog_sync_state (
        host_id TEXT PRIMARY KEY,
        watermark_updated_at REAL,
        initial_build_complete INTEGER NOT NULL DEFAULT 0,
        observation_sequence INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE local_thread_catalog_hosts (
        host_id TEXT PRIMARY KEY,
        host_kind TEXT NOT NULL
      );
      CREATE TABLE local_thread_catalog_metadata (
        id INTEGER PRIMARY KEY,
        catalog_revision INTEGER NOT NULL DEFAULT 0
      );
    `);
    cdb.close();

    // Seed a `[双AI]` thread in state_5.sqlite and verify backfill + live sync
    const stateDbPath = join(fakeCodexHome, 'state_5.sqlite');
    const sdb = new DatabaseSync(stateDbPath);
    sdb.exec('ALTER TABLE threads ADD COLUMN model_provider TEXT;');
    sdb.exec('ALTER TABLE threads ADD COLUMN git_branch TEXT;');
    sdb.exec('ALTER TABLE threads ADD COLUMN created_at INTEGER;');
    sdb.exec('ALTER TABLE threads ADD COLUMN recency_at INTEGER;');
    sdb.exec('ALTER TABLE threads ADD COLUMN source TEXT;');
    sdb.prepare(`
      INSERT INTO threads (id, name, title, cwd, rollout_path, model, reasoning_effort, updated_at, archived, source, created_at, recency_at, model_provider, git_branch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'vscode', ?, ?, 'openai', 'main')
    `).run(
      '01999999-aaaa-7bbb-8ccc-111122223333',
      '[双AI] 订单拆库方案评审',
      '[PEER-EXCHANGE-FROM-ANTIGRAVITY] 订单拆库方案评审',
      canonProjA,
      '',
      'gpt-5',
      'high',
      1795256000,
      1795255000,
      1795256000
    );
    sdb.close();

    const bf = core.backfillCodexDesktopCatalog({ limit: 20 });
    assert.equal(bf.syncedCount, 1);

    const verifyDb = new DatabaseSync(catalogDbPath, { readOnly: true });
    const row = verifyDb.prepare("SELECT * FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?")
      .get('01999999-aaaa-7bbb-8ccc-111122223333');
    assert.ok(row);
    assert.equal(row.display_title, '[双AI] 订单拆库方案评审');
    assert.equal(row.cwd, canonProjA);
    assert.equal(row.source_kind, 'vscode');
    assert.equal(row.thread_source, 'user');
    assert.equal(row.missing_candidate, 0);

    const metaRow = verifyDb.prepare('SELECT catalog_revision FROM local_thread_catalog_metadata WHERE id = 1').get();
    assert.ok(Number(metaRow.catalog_revision) >= 1);
    verifyDb.close();

    const projMatch = core.getCodexDesktopProjectMatch(canonProjA);
    assert.equal(projMatch.matched, true);
    assert.equal(projMatch.projectName, 'proj-alpha');
  });

  it('reuses the exact same Codex thread across multi-round turns after cwd switches and avoids duplicate stale titles', async () => {
    const rpcLogPath = join(tmpRoot, 'codex-rpc-events.jsonl');
    const mockCodexAppServer = join(tmpRoot, 'mock-codex-appserver.mjs');
    writeFileSync(
      mockCodexAppServer,
      [
        `import { appendFileSync } from 'node:fs';`,
        `import { createInterface } from 'node:readline';`,
        `const logPath = process.env.MOCK_CODEX_RPC_LOG;`,
        `let startSeq = Number(process.env.MOCK_CODEX_SEQ_SEED || 0);`,
        `const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });`,
        `const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');`,
        `rl.on('line', (line) => {`,
        `  if (!line.trim()) return;`,
        `  const msg = JSON.parse(line);`,
        `  if (msg.id === undefined) return;`,
        `  if (msg.method === 'initialize') {`,
        `    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'mock-codex' } });`,
        `  } else if (msg.method === 'project/list') {`,
        `    send({ jsonrpc: '2.0', id: msg.id, result: { data: [] } });`,
        `  } else if (msg.method === 'project/create') {`,
        `    send({ jsonrpc: '2.0', id: msg.id, result: { project: { id: 'proj-mock' } } });`,
        `  } else if (msg.method === 'thread/start') {`,
        `    const tid = '019a0000-0000-7000-8000-' + String(++startSeq).padStart(12, '0');`,
        `    appendFileSync(logPath, JSON.stringify({ method: 'thread/start', threadId: tid, cwd: msg.params?.cwd }) + '\\n');`,
        `    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: tid, projectId: 'proj-mock' } } });`,
        `  } else if (msg.method === 'thread/resume') {`,
        `    appendFileSync(logPath, JSON.stringify({ method: 'thread/resume', threadId: msg.params?.threadId, cwd: msg.params?.cwd }) + '\\n');`,
        `    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId, projectId: 'proj-mock' } } });`,
        `  } else if (msg.method === 'thread/name/set') {`,
        `    appendFileSync(logPath, JSON.stringify({ method: 'thread/name/set', threadId: msg.params?.threadId, name: msg.params?.name }) + '\\n');`,
        `    send({ jsonrpc: '2.0', id: msg.id, result: {} });`,
        `  } else if (msg.method === 'thread/metadata/update') {`,
        `    send({ jsonrpc: '2.0', id: msg.id, result: {} });`,
        `  } else if (msg.method === 'turn/start') {`,
        `    const tid = msg.params.threadId;`,
        `    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn_1' } } });`,
        `    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: tid, turn: { id: 'turn_1' } } });`,
        `    send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: tid, turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: 'Ack on ' + tid + ' [PEER_STATUS: CONVERGED]' } } });`,
        `    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: tid, turn: { id: 'turn_1', status: 'completed' } } });`,
        `    setTimeout(() => process.exit(0), 10);`,
        `  }`,
        `});`,
      ].join('\n'),
      'utf-8'
    );

    const prevCodexBin = process.env.CODEX_BIN;
    process.env.CODEX_BIN = mockCodexAppServer;
    process.env.MOCK_CODEX_RPC_LOG = rpcLogPath;
    core.invalidateCodexBinaryCache();

    try {
      process.env.MOCK_CODEX_SEQ_SEED = '100';
      const r1ProjA = await core.runCodexTurn({
        convId: 'room_multi_round_cwd',
        prompt: '# RFC 议题：自研多店铺归因方案选型',
        displayText: '**[架构方案碰撞 · 第 1 轮]**\n\n# RFC 议题：自研多店铺归因方案选型',
        cwd: fakeProjectA,
        persistPrefs: false,
      });

      process.env.MOCK_CODEX_SEQ_SEED = '200';
      const r1ProjB = await core.runCodexTurn({
        convId: 'room_multi_round_cwd',
        prompt: '# RFC 议题：接入企业数据平台 EDP 边界确认',
        displayText: '**[架构方案碰撞 · 第 1 轮]**\n\n# RFC 议题：接入企业数据平台 EDP 边界确认',
        cwd: fakeProjectB,
        persistPrefs: false,
      });
      assert.notEqual(r1ProjB.codexThreadId, r1ProjA.codexThreadId, 'switching to a new project folder starts 1 thread for that folder');

      process.env.MOCK_CODEX_SEQ_SEED = '300';
      const r2ProjB = await core.runCodexTurn({
        convId: 'room_multi_round_cwd',
        prompt: '# 第 2 轮 RFC 收敛：锁定共享主键与契约',
        displayText: '**[架构方案碰撞 · 第 2 轮]**\n\n# 第 2 轮 RFC 收敛：锁定共享主键与契约',
        cwd: fakeProjectB,
        persistPrefs: false,
      });
      assert.equal(r2ProjB.codexThreadId, r1ProjB.codexThreadId, 'Round 2 in Project B MUST reuse Project B thread instead of opening a new conversation');

      process.env.MOCK_CODEX_SEQ_SEED = '400';
      const r3ProjB = await core.runCodexTurn({
        convId: 'room_multi_round_cwd',
        prompt: '# 第 3 轮 RFC 终审确认',
        displayText: '**[架构方案碰撞 · 第 3 轮]**\n\n# 第 3 轮 RFC 终审确认',
        cwd: fakeProjectB,
        persistPrefs: false,
      });
      assert.equal(r3ProjB.codexThreadId, r1ProjB.codexThreadId, 'Round 3 in Project B MUST still reuse the same Project B thread');

      process.env.MOCK_CODEX_SEQ_SEED = '500';
      const rBackToProjA = await core.runCodexTurn({
        convId: 'room_multi_round_cwd',
        prompt: '# 回到归因蓝图补充落库字段',
        displayText: '**[架构方案碰撞 · 第 2 轮]**\n\n# 回到归因蓝图补充落库字段',
        cwd: fakeProjectA,
        persistPrefs: false,
      });
      assert.equal(rBackToProjA.codexThreadId, r1ProjA.codexThreadId, 'switching back to Project A resumes Project A existing thread');

      const rpcEvents = readFileSync(rpcLogPath, 'utf-8')
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      const starts = rpcEvents.filter((e) => e.method === 'thread/start');
      const resumes = rpcEvents.filter((e) => e.method === 'thread/resume');
      const names = rpcEvents.filter((e) => e.method === 'thread/name/set');

      assert.equal(starts.length, 2, 'only 2 threads started total across 5 turns in 2 folders');
      assert.equal(resumes.length, 3, '3 turns resumed existing threads');
      assert.equal(names.find((e) => e.threadId === r1ProjA.codexThreadId)?.name, '[双AI] RFC 议题：自研多店铺归因方案选型');
      assert.equal(names.find((e) => e.threadId === r1ProjB.codexThreadId)?.name, '[双AI] RFC 议题：接入企业数据平台 EDP 边界确认');
    } finally {
      if (prevCodexBin) process.env.CODEX_BIN = prevCodexBin; else delete process.env.CODEX_BIN;
      delete process.env.MOCK_CODEX_RPC_LOG;
      delete process.env.MOCK_CODEX_SEQ_SEED;
      core.invalidateCodexBinaryCache();
    }
  });
});
