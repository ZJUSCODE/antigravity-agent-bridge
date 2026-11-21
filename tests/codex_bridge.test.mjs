import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Register Antigravity's built-in `sidecar_sdk` ESM resolver so `main.mjs` can be tested directly over HTTP
const resolverPath = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'esm_resolver.js');
if (existsSync(resolverPath)) {
  register(pathToFileURL(resolverPath).href);
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
    assert.equal(dbSnap.projects[0].path, fakeProjectA, 'must strip \\\\?\\ prefix');
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
    assert.equal(swB.snap.meta.cwd, fakeProjectB);
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

      // 3. Diagnostics & local OpenAI Sans font check
      const diagRes = await fetch(`${base}/api/diagnostics`);
      const diag = await diagRes.json();
      assert.equal(diag.ok, true);
      assert.equal(diag.fontsLoaded, 3, 'all 3 OpenAI Sans WOFF2 weights must load');
      const fontRes = await fetch(`${base}/fonts/openai-sans-regular.woff2`);
      assert.equal(fontRes.status, 200);
      const fontBuf = await fontRes.arrayBuffer();
      assert.ok(fontBuf.byteLength > 10000);

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
});
