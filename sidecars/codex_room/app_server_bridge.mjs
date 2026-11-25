/**
 * Hardened Enterprise Persistent `codex app-server --stdio` JSON-RPC 2.0 Client Bridge (v3.1).
 *
 * Hardening highlights:
 * - Queued multi-approval tracking (`pendingApprovals`) with exact original JSON-RPC ID matching & zero orphan fallback
 * - Synchronous pre-await room reservation + cross-process PID/heartbeat turn lease (`acquireRoomTurnLease`)
 * - Strict `threadId + turnId` routing, idempotent settlement, cancel-while-starting handling & `roomEpoch` guards
 * - Loaded-thread configuration tracking (`model|sandbox|approvalPolicy|cwd`) so policy switches re-sync via `thread/resume`
 * - Server-side attachment path verification (`sanitizeClientAttachments`)
 * - Accurate `turn/completed` (`completed` / `interrupted` / `failed`) status handling
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  acquireRoomTurnLease,
  appendMessage,
  buildUpdatedCodexThreadsByCwd,
  deriveCleanRoomTitle,
  ensureRoomDir,
  ensureUploadsDir,
  findCodexBinary,
  formatCodexDesktopThreadName,
  getCodexThreadForCwd,
  heartbeatRoomTurnLease,
  isLegacyExecThread,
  normalizeDirPath,
  queryAntigravityWorkspaceIndex,
  readMeta,
  registerInProcessBusyChecker,
  releaseRoomTurnLease,
  resolveCanonicalCodexProjectCwd,
  resolveCodexServerProjectViaRpc,
  resolveDefaultCodexModel,
  sanitizeClientAttachments,
  sanitizeConvId,
  spawnCodexProcessWithRetry,
  stripWinPrefix,
  syncCodexDesktopCatalogEntry,
  toPathKey,
  writeMeta,
} from './codex_core.mjs';

const DEFAULT_RPC_TIMEOUT_MS = 45000;
const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_STDERR_LINES = 40;
const MAX_CMD_OUTPUT_CHARS = 1400;

function summarizeCmd(cmd) {
  const clean = String(cmd || '').replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? clean.slice(0, 77) + '...' : clean;
}

function isThreadMissingError(err) {
  const m = String(err?.message || '').toLowerCase();
  return m.includes('not found') || m.includes('no rollout') || m.includes('missing thread') || m.includes('does not exist');
}

export class AppServerBridge {
  #child = null;
  #initPromise = null;
  #startedAt = 0;
  #restartCount = 0;
  #nextId = 1;
  #pendingRpc = new Map();           // rpcId -> { resolve, reject, timer, method }
  #loadedThreadConfigs = new Map();  // codexThreadId -> configKeyString
  #activeTurnsByThread = new Map();  // codexThreadId -> TurnContext
  #activeTurnsByRoom = new Map();    // roomId -> TurnContext
  #stderrRing = [];                  // string[]
  #lastRateLimitPercent = null;

  constructor() {
    registerInProcessBusyChecker((roomId) => this.isRoomBusy(roomId));
    process.once('exit', () => this.shutdown());
    process.once('SIGINT', () => { this.shutdown(); process.exit(0); });
    process.once('SIGTERM', () => { this.shutdown(); process.exit(0); });
  }

  shutdown() {
    for (const [, p] of this.#pendingRpc) {
      clearTimeout(p.timer);
    }
    this.#pendingRpc.clear();
    if (this.#child) {
      try { this.#child.kill(); } catch {}
      this.#child = null;
    }
    this.#initPromise = null;
  }

  isRoomBusy(roomId) {
    return this.#activeTurnsByRoom.has(sanitizeConvId(roomId));
  }

  getDiagnostics() {
    return {
      running: Boolean(this.#child && !this.#child.killed),
      pid: this.#child?.pid || null,
      uptimeMs: this.#startedAt ? Date.now() - this.#startedAt : 0,
      restartCount: this.#restartCount,
      loadedThreads: this.#loadedThreadConfigs.size,
      pendingRpcCount: this.#pendingRpc.size,
      activeRooms: [...this.#activeTurnsByRoom.keys()],
      rateLimitPercent: this.#lastRateLimitPercent,
      stderrTail: [...this.#stderrRing],
    };
  }

  async #ensureStarted() {
    if (this.#child && !this.#child.killed && this.#initPromise) {
      return this.#initPromise;
    }
    this.#initPromise = this.#spawnServer().catch((err) => {
      this.#initPromise = null;
      this.shutdown();
      throw err;
    });
    return this.#initPromise;
  }

  #pushStderr(chunk) {
    const lines = String(chunk || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      this.#stderrRing.push(`[${new Date().toISOString().slice(11, 19)}] ${line.slice(0, 240)}`);
      if (this.#stderrRing.length > MAX_STDERR_LINES) {
        this.#stderrRing.shift();
      }
    }
  }

  async #spawnServer() {
    if (this.#startedAt > 0) this.#restartCount += 1;
    this.#startedAt = Date.now();

    const child = await spawnCodexProcessWithRetry(
      ['app-server', '--stdio', '-c', 'mcp_servers={}', '--disable', 'hooks'],
      { baseEnv: process.env, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    this.#child = child;
    this.#loadedThreadConfigs.clear();

    let buf = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          this.#onMessage(JSON.parse(trimmed));
        } catch {}
      }
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => this.#pushStderr(chunk));

    child.on('error', (err) => {
      this.#pushStderr(`spawn error: ${err.message}`);
    });

    child.on('exit', (code, sig) => {
      this.#pushStderr(`app-server exited (code=${code}, sig=${sig})`);
      this.#child = null;
      this.#initPromise = null;
      this.#loadedThreadConfigs.clear();
      for (const [, p] of this.#pendingRpc) {
        clearTimeout(p.timer);
        p.reject(new Error('Codex app-server 进程已退出，正在自动重连'));
      }
      this.#pendingRpc.clear();
      const activeList = [...this.#activeTurnsByRoom.values()];
      this.#activeTurnsByRoom.clear();
      this.#activeTurnsByThread.clear();
      for (const ctx of activeList) {
        if (typeof ctx.fail === 'function') {
          ctx.fail('Codex app-server 连接意外中断，请重试');
        }
      }
    });

    await this.#rpc('initialize', {
      clientInfo: { name: 'Codex Desktop', title: 'Antigravity Codex Room', version: '3.3.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 20000);
    this.#sendRaw({ jsonrpc: '2.0', method: 'initialized', params: {} });

    this.#rpc('account/rateLimits/read', {}, 8000)
      .then((res) => {
        const pct = res?.rateLimits?.primary?.usedPercent;
        if (typeof pct === 'number') this.#lastRateLimitPercent = Math.round(pct);
      })
      .catch(() => {});
  }

  #sendRaw(obj) {
    if (!this.#child || !this.#child.stdin.writable) {
      throw new Error('Codex app-server 未就绪');
    }
    this.#child.stdin.write(JSON.stringify(obj) + '\n', 'utf-8');
  }

  #rpc(method, params, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
    const id = this.#nextId++;
    this.#sendRaw({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        this.#pendingRpc.delete(id);
        rejectRpc(new Error(`Codex RPC 超时 (${method}, ${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.#pendingRpc.set(id, { resolve: resolveRpc, reject: rejectRpc, timer, method });
    });
  }

  #onMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const pending = this.#pendingRpc.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pendingRpc.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.id !== undefined && msg.method) {
      this.#handleServerRequest(msg);
      return;
    }

    if (msg.method) {
      this.#handleNotification(msg.method, msg.params || {});
    }
  }

  #handleServerRequest(msg) {
    const params = msg.params || {};
    const threadId = params.threadId || params.conversationId;
    // Never guess an arbitrary active room if threadId is missing or unknown!
    const ctx = threadId ? this.#activeTurnsByThread.get(threadId) : null;
    if (!ctx || typeof ctx.enqueueApproval !== 'function' || (ctx.turnId && params.turnId && params.turnId !== ctx.turnId)) {
      try { this.#sendRaw({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } }); } catch {}
      return;
    }

    if (
      msg.method === 'item/commandExecution/requestApproval' ||
      msg.method === 'execCommandApproval'
    ) {
      ctx.enqueueApproval({
        approvalToken: `appr_${randomUUID()}`,
        rpcId: msg.id,
        method: msg.method,
        kind: 'command',
        command: params.command || (Array.isArray(params.parsedCmd) ? params.parsedCmd.join(' ') : ''),
        cwd: stripWinPrefix(params.cwd || ''),
        reason: params.reason || '请求执行终端命令',
      });
      return;
    }

    if (
      msg.method === 'item/fileChange/requestApproval' ||
      msg.method === 'applyPatchApproval'
    ) {
      ctx.enqueueApproval({
        approvalToken: `appr_${randomUUID()}`,
        rpcId: msg.id,
        method: msg.method,
        kind: 'fileChange',
        command: stripWinPrefix(params.grantRoot || ''),
        cwd: '',
        reason: params.reason || '请求写入或修改本地文件',
      });
      return;
    }

    try { this.#sendRaw({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } }); } catch {}
  }

  respondApproval(roomId, approvalToken, decision) {
    if (decision !== 'accept' && decision !== 'acceptForSession' && decision !== 'decline') {
      throw new Error('非法的审批动作参数');
    }
    const safeRoom = sanitizeConvId(roomId);
    const ctx = this.#activeTurnsByRoom.get(safeRoom);
    if (!ctx || typeof ctx.consumeApproval !== 'function') {
      throw new Error('当前没有待处理的审批请求');
    }
    const tokenStr = String(approvalToken ?? '').trim();
    if (!tokenStr) {
      throw new Error('审批请求缺少有效的一次性令牌');
    }
    const matched = ctx.consumeApproval(tokenStr);
    if (!matched) {
      throw new Error('该审批请求已过期或已被处理');
    }

    const isLegacy = matched.method === 'execCommandApproval' || matched.method === 'applyPatchApproval';
    let mapped = decision;
    if (isLegacy) {
      mapped = decision === 'accept' ? 'approved' : decision === 'acceptForSession' ? 'approved_for_session' : 'abort';
    }
    this.#sendRaw({
      jsonrpc: '2.0',
      id: matched.rpcId,
      result: { decision: mapped },
    });
    return { ok: true };
  }

  async cancelRoomTurn(roomId) {
    const safeRoom = sanitizeConvId(roomId);
    const ctx = this.#activeTurnsByRoom.get(safeRoom);
    if (ctx) {
      ctx.cancelRequested = true;
      if (typeof ctx.drainApprovalsOnCancel === 'function') {
        for (const p of ctx.drainApprovalsOnCancel()) {
          try { this.#sendRaw({ jsonrpc: '2.0', id: p.rpcId, result: { decision: 'decline' } }); } catch {}
        }
      }
      if (ctx.threadId && ctx.turnId) {
        try {
          await this.#rpc('turn/interrupt', { threadId: ctx.threadId, turnId: ctx.turnId }, 6000);
        } catch {}
      }
      if (typeof ctx.waitForSettle === 'function') {
        await ctx.waitForSettle(3500);
      }
    } else {
      // Signal external CLI to terminate without erasing its active lease until it exits
      writeMeta(safeRoom, {
        cancelRequestedAt: Date.now(),
      }, { requireExists: true });
    }
  }

  #handleNotification(method, params) {
    if (method === 'account/rateLimits/updated') {
      const pct = params.rateLimits?.primary?.usedPercent;
      if (typeof pct === 'number') {
        this.#lastRateLimitPercent = Math.round(pct);
        for (const [roomId, ctx] of this.#activeTurnsByRoom) {
          if (ctx?.roomEpoch) {
            writeMeta(roomId, { rateLimitPercent: this.#lastRateLimitPercent }, { expectedEpoch: ctx.roomEpoch, requireExists: true });
          }
        }
      }
      return;
    }

    const threadId = params.threadId || params.thread?.id;
    const ctx = threadId ? this.#activeTurnsByThread.get(threadId) : null;
    if (!ctx || ctx.isPlaceholder) return;

    const notifTurnId = params.turnId || params.turn?.id;
    if (method === 'turn/started' && params.turn?.id) {
      if (!ctx.turnId) {
        ctx.turnId = params.turn.id;
        if (ctx.cancelRequested) {
          this.#rpc('turn/interrupt', { threadId: ctx.threadId, turnId: ctx.turnId }, 5000).catch(() => {});
        }
      }
      return;
    }

    // Strict turnId guard against late notifications from a prior turn on the same thread
    if (ctx.turnId && notifTurnId && notifTurnId !== ctx.turnId) {
      return;
    }

    if (method === 'item/reasoning/summaryTextDelta' && typeof params.delta === 'string') {
      const key = `${params.itemId || 'r'}:${params.summaryIndex ?? 0}`;
      ctx.appendReasoningDelta(key, params.delta);
      return;
    }

    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      ctx.appendDelta(params.itemId || 'default', params.delta);
      return;
    }

    if (method === 'item/commandExecution/outputDelta' && typeof params.delta === 'string') {
      ctx.appendCommandOutput(params.itemId || 'cmd', params.delta);
      return;
    }

    if (method === 'turn/diff/updated' && typeof params.diff === 'string') {
      ctx.updateDiff(params.diff);
      return;
    }

    if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      ctx.updatePlan(params.plan);
      return;
    }

    if (method === 'thread/tokenUsage/updated' && params.tokenUsage) {
      ctx.updateTokenUsage(params.tokenUsage);
      return;
    }

    if (method === 'item/started' && params.item) {
      const it = params.item;
      if (it.type === 'commandExecution') {
        ctx.startCommand(it.id || 'cmd', it.command || '');
      } else if (it.type === 'fileChange') {
        ctx.updateStatus('Applying file changes…');
      } else if (it.type === 'mcpToolCall') {
        ctx.updateStatus(`Calling ${it.server || 'MCP'}/${it.tool || 'tool'}…`);
      } else if (it.type === 'webSearch') {
        ctx.updateStatus('Searching web…');
      } else if (it.type === 'reasoning') {
        ctx.updateStatus('Thinking');
      }
      return;
    }

    if (method === 'item/completed' && params.item) {
      const it = params.item;
      if (it.type === 'agentMessage' && typeof it.text === 'string' && it.text.trim()) {
        ctx.setFinalItemText(it.id || 'default', it.text);
      } else if (it.type === 'reasoning' && Array.isArray(it.summary) && it.summary.length > 0) {
        ctx.setReasoningSummaryFallback(it.summary.join('\n').trim());
      } else if (it.type === 'commandExecution') {
        ctx.completeCommand(it);
      } else if (it.type === 'fileChange') {
        const files = Array.isArray(it.changes)
          ? it.changes.map((c) => basename(stripWinPrefix(c.path || ''))).filter(Boolean)
          : [];
        ctx.addStep({
          kind: 'fileChange',
          label: files.length ? `修改文件: ${files.join(', ')}` : '应用文件修改',
          files,
        });
        ctx.updateStatus('Thinking');
      } else if (it.type === 'mcpToolCall') {
        ctx.addStep({
          kind: 'mcp',
          label: `${it.server || 'mcp'}/${it.tool || 'tool'}`,
          durationMs: it.durationMs ?? null,
          exitCode: it.error ? 1 : 0,
        });
        ctx.updateStatus('Thinking');
      } else if (it.type === 'webSearch') {
        ctx.addStep({
          kind: 'search',
          label: it.query ? `搜索: ${String(it.query).slice(0, 60)}` : '网页检索',
        });
        ctx.updateStatus('Thinking');
      }
      return;
    }

    if (method === 'error' && params.message) {
      ctx.lastStreamError = String(params.message);
      return;
    }

    if (method === 'turn/completed') {
      const turnStatus = params.turn?.status;
      const turnErr = params.turn?.error?.message || ctx.lastStreamError;
      if (ctx.cancelRequested || turnStatus === 'interrupted') {
        ctx.finishCancelled();
      } else if (turnStatus === 'failed') {
        ctx.fail(turnErr || 'Codex 回合执行失败');
      } else {
        ctx.finishSuccess();
      }
    }
  }

  async startInteractiveTurn({
    roomId,
    prompt,
    attachments = [],
    sender = 'user',
    senderLabel = '你',
    model,
    effort,
    sandbox,
    approvalPolicy,
    cwd,
    newThread = false,
  }) {
    const safeRoom = sanitizeConvId(roomId);
    if (this.isRoomBusy(safeRoom)) {
      throw new Error('当前对话正在执行中，请等待完成或点击停止。');
    }

    // Reserve both cross-process lease AND in-memory map SYNCHRONOUSLY before first `await`!
    const { leaseId, roomEpoch, meta: prevMeta } = acquireRoomTurnLease(safeRoom, 'app-server');
    const reservation = { isPlaceholder: true, roomId: safeRoom, roomEpoch, cancelRequested: false };
    this.#activeTurnsByRoom.set(safeRoom, reservation);

    let hbTimer = setInterval(() => heartbeatRoomTurnLease(safeRoom, leaseId), HEARTBEAT_INTERVAL_MS);
    if (typeof hbTimer.unref === 'function') hbTimer.unref();

    const releaseEarly = (errMsg) => {
      clearInterval(hbTimer);
      hbTimer = null;
      if (this.#activeTurnsByRoom.get(safeRoom) === reservation) {
        this.#activeTurnsByRoom.delete(safeRoom);
      }
      releaseRoomTurnLease(safeRoom, leaseId, {
        status: errMsg ? 'error' : 'idle',
        activeTurn: null,
        lastError: errMsg || null,
      });
    };

    let chosenModel;
    let chosenEffort;
    let chosenSandbox;
    let chosenApproval;
    let chosenCwd;
    let verifiedAtts;
    let rawText;
    let threadId = null;
    let desiredDesktopTitle = '';

    try {
      await this.#ensureStarted();
      if (reservation.cancelRequested) {
        releaseEarly(null);
        return { started: false, cancelled: true, roomId: safeRoom };
      }

      chosenModel = model || prevMeta.model || resolveDefaultCodexModel();
      const explicitModel = chosenModel && chosenModel !== 'auto' ? chosenModel : undefined;
      chosenEffort = effort || prevMeta.effort || 'medium';
      chosenSandbox = sandbox || prevMeta.sandbox || 'workspace-write';
      chosenApproval = approvalPolicy || prevMeta.approvalPolicy || 'on-request';
      const inferredAgyCwd = (!cwd && !prevMeta.cwd)
        ? (queryAntigravityWorkspaceIndex().pathByConvId.get(safeRoom) || null)
        : null;
      chosenCwd = resolveCanonicalCodexProjectCwd(
        cwd || prevMeta.cwd || inferredAgyCwd || ensureRoomDir(safeRoom)
      );
      mkdirSync(chosenCwd, { recursive: true });
      ensureUploadsDir(safeRoom);

      verifiedAtts = sanitizeClientAttachments(safeRoom, attachments);
      rawText = String(prompt || '').trim();
      if (!rawText && verifiedAtts.length === 0) {
        throw new Error('请输入内容或添加有效附件。');
      }

      const cwdChanged = Boolean(prevMeta.cwd && toPathKey(normalizeDirPath(prevMeta.cwd)) !== toPathKey(chosenCwd));
      const hadPriorRoomThread = Boolean(
        prevMeta.codexThreadId
        || (prevMeta.codexThreadsByCwd && Object.keys(prevMeta.codexThreadsByCwd).length > 0)
      );
      const explicitFork = !newThread && !cwdChanged && Boolean(prevMeta.needsForkOnNextTurn && prevMeta.forkFromSessionId);
      const matchedCwdEntry = (!newThread && !explicitFork) ? getCodexThreadForCwd(prevMeta, chosenCwd) : null;
      const rawCandidateResume = matchedCwdEntry?.threadId || null;
      const promoteExecViaFork = Boolean(rawCandidateResume && isLegacyExecThread(rawCandidateResume));
      const shouldFork = explicitFork || promoteExecViaFork;
      const forkSourceId = explicitFork ? prevMeta.forkFromSessionId : (promoteExecViaFork ? rawCandidateResume : null);
      const desiredCfgKey = `${chosenModel}|${chosenSandbox}|${chosenApproval}|${chosenCwd.toLowerCase()}`;
      const codexServerProjectId = await resolveCodexServerProjectViaRpc(
        (m, p, t) => this.#rpc(m, p, t),
        chosenCwd
      );

      // 1. Append user message once verified
      appendMessage(safeRoom, {
        sender,
        senderLabel,
        text: rawText || `已发送 ${verifiedAtts.length} 个附件`,
        attachments: verifiedAtts,
        codexThreadId: rawCandidateResume || forkSourceId,
        model: chosenModel,
        effort: chosenEffort,
      }, { expectedEpoch: roomEpoch, requireExists: true });

      // 2. Start / Fork / Resume thread (only clear fork source AFTER fork RPC succeeds!)
      threadId = (!shouldFork) ? rawCandidateResume : null;
      let createdOrForked = false;
      let currentThreadProjectId = null;

      if (shouldFork && forkSourceId) {
        const forkRes = await this.#rpc('thread/fork', {
          threadId: forkSourceId,
          excludeTurns: true,
          threadSource: 'user',
          ...(explicitModel ? { model: explicitModel } : {}),
          cwd: chosenCwd,
          approvalPolicy: chosenApproval,
          sandbox: chosenSandbox,
        });
        threadId = forkRes.thread.id;
        currentThreadProjectId = forkRes.thread.projectId || null;
        createdOrForked = true;
        this.#loadedThreadConfigs.set(threadId, desiredCfgKey);
        if (explicitFork) {
          appendMessage(safeRoom, {
            sender: 'system',
            senderLabel: '系统',
            text: `已从历史会话 (${forkSourceId.slice(0, 8)}…) 自动 Fork 安全分支，避免与 Codex 桌面端争抢写锁`,
          }, { expectedEpoch: roomEpoch, requireExists: true });
        }
      } else if (threadId) {
        if (this.#loadedThreadConfigs.get(threadId) !== desiredCfgKey) {
          try {
            const res = await this.#rpc('thread/resume', {
              threadId,
              excludeTurns: true,
              ...(explicitModel ? { model: explicitModel } : {}),
              cwd: chosenCwd,
              approvalPolicy: chosenApproval,
              sandbox: chosenSandbox,
            });
            threadId = res.thread.id;
            currentThreadProjectId = res.thread.projectId || null;
            this.#loadedThreadConfigs.set(threadId, desiredCfgKey);
          } catch (resumeErr) {
            if (isThreadMissingError(resumeErr)) {
              threadId = null;
              appendMessage(safeRoom, {
                sender: 'system',
                senderLabel: '系统',
                text: '原历史线程已不存在，已自动切换至新上下文线程',
              }, { expectedEpoch: roomEpoch, requireExists: true });
            } else {
              throw resumeErr;
            }
          }
        }
      }

      if (!threadId) {
        const startRes = await this.#rpc('thread/start', {
          ...(explicitModel ? { model: explicitModel } : {}),
          cwd: chosenCwd,
          ...(codexServerProjectId ? { projectId: codexServerProjectId } : {}),
          threadSource: 'user',
          approvalPolicy: chosenApproval,
          sandbox: chosenSandbox,
        });
        threadId = startRes.thread.id;
        currentThreadProjectId = startRes.thread.projectId || codexServerProjectId || null;
        createdOrForked = true;
        this.#loadedThreadConfigs.set(threadId, desiredCfgKey);
      }

      if (codexServerProjectId && currentThreadProjectId !== codexServerProjectId) {
        await this.#rpc('thread/metadata/update', {
          threadId,
          projectId: codexServerProjectId,
        }, 6000).catch(() => {});
      }

      const isSubsequentNewThread = Boolean(
        createdOrForked && hadPriorRoomThread && !explicitFork && !promoteExecViaFork
      );
      desiredDesktopTitle = isSubsequentNewThread
        ? formatCodexDesktopThreadName('', rawText)
        : (matchedCwdEntry?.title || formatCodexDesktopThreadName(readMeta(safeRoom).title, rawText));
      if (createdOrForked || desiredDesktopTitle !== matchedCwdEntry?.title) {
        await this.#rpc('thread/name/set', { threadId, name: desiredDesktopTitle }, 6000).catch(() => {});
      }
      if (threadId && !chosenCwd.toLowerCase().includes('\\.gemini\\antigravity\\brain\\')) {
        syncCodexDesktopCatalogEntry({
          threadId,
          title: desiredDesktopTitle,
          cwd: chosenCwd,
        });
      }

      if (reservation.cancelRequested) {
        releaseEarly(null);
        return { started: false, cancelled: true, roomId: safeRoom };
      }
    } catch (err) {
      releaseEarly(err.message);
      throw err;
    }

    // 3. Build full TurnContext & swap atomically into maps before `turn/start`
    const startedAt = Date.now();
    const activeTurn = {
      id: `turn_${randomUUID().slice(0, 8)}`,
      startedAt,
      sender,
      liveStatus: 'Thinking',
      reasoningSummary: '',
      liveCommandOutput: '',
      streamingText: '',
      diff: '',
      plan: [],
      pendingApprovals: [],
      pendingApproval: null,
      steps: [],
    };

    const buildInteractiveThreadPatch = () => ({
      codexThreadId: threadId,
      codexThreadsByCwd: buildUpdatedCodexThreadsByCwd(
        readMeta(safeRoom).codexThreadsByCwd || prevMeta.codexThreadsByCwd,
        chosenCwd,
        threadId,
        desiredDesktopTitle
      ),
      ...(desiredDesktopTitle ? { codexNamedTitle: desiredDesktopTitle } : {}),
    });

    try {
      writeMeta(safeRoom, {
        ...buildInteractiveThreadPatch(),
        needsForkOnNextTurn: false,
        forkFromSessionId: null,
        model: chosenModel,
        effort: chosenEffort,
        sandbox: chosenSandbox,
        approvalPolicy: chosenApproval,
        cwd: chosenCwd,
        status: 'thinking',
        activeTurn,
        rateLimitPercent: this.#lastRateLimitPercent ?? prevMeta.rateLimitPercent ?? null,
        lastError: null,
      }, { expectedEpoch: roomEpoch, expectedLeaseId: leaseId, requireExists: true });
    } catch (err) {
      releaseEarly(err.message);
      throw err;
    }

    const itemTexts = new Map();
    const reasoningParts = new Map();
    const cmdOutputs = new Map();
    const settleWaiters = [];
    let tokenSummary = prevMeta.tokenUsage || null;
    let lastSyncMs = 0;
    let syncTimer = null;
    let settled = false;
    const bridgeSelf = this;

    const syncHeadApproval = () => {
      activeTurn.pendingApproval = activeTurn.pendingApprovals[0] || null;
    };

    const flushMeta = (forceStatus) => {
      if (settled) return;
      clearTimeout(syncTimer);
      syncTimer = null;
      lastSyncMs = Date.now();
      syncHeadApproval();
      const statusNow = forceStatus || (activeTurn.pendingApprovals.length > 0 ? 'awaiting_approval' : 'thinking');
      try {
        writeMeta(safeRoom, {
          codexThreadId: threadId,
          status: statusNow,
          tokenUsage: tokenSummary,
          rateLimitPercent: bridgeSelf.#lastRateLimitPercent ?? prevMeta.rateLimitPercent ?? null,
          activeTurn: {
            ...activeTurn,
            pendingApprovals: [...activeTurn.pendingApprovals],
          },
        }, { expectedEpoch: roomEpoch, expectedLeaseId: leaseId, requireExists: true });
      } catch (err) {
        ctx.fail(err.message);
      }
    };

    const scheduleFlush = () => {
      if (settled) return;
      if (Date.now() - lastSyncMs >= 85) {
        flushMeta();
      } else if (!syncTimer) {
        syncTimer = setTimeout(() => flushMeta(), 85);
      }
    };

    const cleanup = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(syncTimer);
      if (hbTimer) {
        clearInterval(hbTimer);
        hbTimer = null;
      }
      if (bridgeSelf.#activeTurnsByRoom.get(safeRoom) === ctx) {
        bridgeSelf.#activeTurnsByRoom.delete(safeRoom);
      }
      if (bridgeSelf.#activeTurnsByThread.get(threadId) === ctx) {
        bridgeSelf.#activeTurnsByThread.delete(threadId);
      }
      while (settleWaiters.length) {
        const w = settleWaiters.pop();
        try { w(); } catch {}
      }
      return true;
    };

    const ctx = {
      isPlaceholder: false,
      roomId: safeRoom,
      roomEpoch,
      threadId,
      turnId: null,
      cancelRequested: reservation.cancelRequested,
      activeTurn,
      lastStreamError: '',
      waitForSettle(maxMs = 2500) {
        if (settled) return Promise.resolve();
        return new Promise((res) => {
          const t = setTimeout(res, maxMs);
          settleWaiters.push(() => { clearTimeout(t); res(); });
        });
      },
      appendReasoningDelta(key, delta) {
        reasoningParts.set(key, (reasoningParts.get(key) || '') + delta);
        activeTurn.reasoningSummary = [...reasoningParts.values()].join('\n').trim();
        if (!activeTurn.streamingText) activeTurn.liveStatus = 'Thinking';
        scheduleFlush();
      },
      setReasoningSummaryFallback(text) {
        if (!activeTurn.reasoningSummary && text) {
          activeTurn.reasoningSummary = text;
          scheduleFlush();
        }
      },
      appendDelta(itemId, delta) {
        itemTexts.set(itemId, (itemTexts.get(itemId) || '') + delta);
        activeTurn.streamingText = [...itemTexts.values()].join('\n\n');
        activeTurn.liveStatus = 'Responding';
        scheduleFlush();
      },
      setFinalItemText(itemId, fullText) {
        itemTexts.set(itemId, fullText);
        activeTurn.streamingText = [...itemTexts.values()].join('\n\n');
        scheduleFlush();
      },
      startCommand(itemId, cmd) {
        cmdOutputs.set(itemId, '');
        activeTurn.liveCommandOutput = '';
        activeTurn.liveStatus = `Running ${summarizeCmd(cmd)}`;
        scheduleFlush();
      },
      appendCommandOutput(itemId, delta) {
        const next = ((cmdOutputs.get(itemId) || '') + delta).slice(-MAX_CMD_OUTPUT_CHARS);
        cmdOutputs.set(itemId, next);
        activeTurn.liveCommandOutput = next;
        scheduleFlush();
      },
      completeCommand(it) {
        const fullCmd = String(it.command || '');
        const rawOut = String(it.aggregatedOutput || cmdOutputs.get(it.id) || '').trim().slice(-MAX_CMD_OUTPUT_CHARS);
        activeTurn.liveCommandOutput = '';
        activeTurn.steps.push({
          kind: 'command',
          label: summarizeCmd(fullCmd),
          command: fullCmd.slice(0, 400),
          cwd: stripWinPrefix(it.cwd || ''),
          output: rawOut,
          exitCode: it.exitCode ?? 0,
          durationMs: it.durationMs ?? null,
        });
        activeTurn.liveStatus = 'Thinking';
        scheduleFlush();
      },
      updateDiff(diff) {
        activeTurn.diff = diff;
        scheduleFlush();
      },
      updatePlan(planArr) {
        activeTurn.plan = planArr.map((p) => ({
          step: String(p.step || ''),
          status: String(p.status || 'pending'),
        })).filter((p) => p.step);
        scheduleFlush();
      },
      updateTokenUsage(tu) {
        tokenSummary = {
          totalTokens: tu.total?.totalTokens ?? 0,
          lastTokens: tu.last?.totalTokens ?? 0,
          outputTokens: tu.last?.outputTokens ?? 0,
          reasoningTokens: tu.last?.reasoningOutputTokens ?? 0,
          contextWindow: tu.modelContextWindow ?? null,
        };
        scheduleFlush();
      },
      updateStatus(st) {
        activeTurn.liveStatus = st;
        scheduleFlush();
      },
      addStep(step) {
        activeTurn.steps.push(step);
        scheduleFlush();
      },
      enqueueApproval(appInfo) {
        if (ctx.cancelRequested) {
          try { bridgeSelf.#sendRaw({ jsonrpc: '2.0', id: appInfo.rpcId, result: { decision: 'decline' } }); } catch {}
          return;
        }
        activeTurn.pendingApprovals.push(appInfo);
        activeTurn.liveStatus = 'Awaiting approval';
        flushMeta('awaiting_approval');
      },
      consumeApproval(approvalToken) {
        const idx = activeTurn.pendingApprovals.findIndex((p) => p.approvalToken === approvalToken);
        if (idx === -1) return null;
        const [matched] = activeTurn.pendingApprovals.splice(idx, 1);
        if (activeTurn.pendingApprovals.length > 0) {
          activeTurn.liveStatus = 'Awaiting approval';
          flushMeta('awaiting_approval');
        } else {
          activeTurn.liveStatus = 'Running approved action…';
          flushMeta('thinking');
        }
        return matched;
      },
      drainApprovalsOnCancel() {
        const drained = [...activeTurn.pendingApprovals];
        activeTurn.pendingApprovals = [];
        syncHeadApproval();
        return drained;
      },
      finishSuccess() {
        if (!cleanup()) return;
        const finalReply = [...itemTexts.values()].join('\n\n').trim();
        const durationMs = Date.now() - startedAt;
        if (!finalReply && !activeTurn.diff && ctx.lastStreamError) {
          releaseRoomTurnLease(safeRoom, leaseId, {
            codexThreadId: threadId,
            status: 'error',
            activeTurn: null,
            lastError: ctx.lastStreamError,
          });
          return;
        }
        appendMessage(safeRoom, {
          sender: 'codex',
          senderLabel: 'Codex',
          text: finalReply || (activeTurn.diff ? '已完成文件修改（见下方 Diff）' : '（已完成）'),
          diff: activeTurn.diff || '',
          reasoningSummary: activeTurn.reasoningSummary || '',
          plan: activeTurn.plan || [],
          codexThreadId: threadId,
          model: chosenModel,
          effort: chosenEffort,
          durationMs,
          tokenCount: tokenSummary?.lastTokens ?? null,
          steps: activeTurn.steps,
        }, { expectedEpoch: roomEpoch, requireExists: true });

        const settledMeta = releaseRoomTurnLease(safeRoom, leaseId, {
          ...buildInteractiveThreadPatch(),
          tokenUsage: tokenSummary,
          rateLimitPercent: bridgeSelf.#lastRateLimitPercent ?? prevMeta.rateLimitPercent ?? null,
          status: 'idle',
          activeTurn: null,
          lastError: null,
        });
        if (threadId && !chosenCwd.toLowerCase().includes('\\.gemini\\antigravity\\brain\\')) {
          syncCodexDesktopCatalogEntry({
            threadId,
            title: desiredDesktopTitle || formatCodexDesktopThreadName(settledMeta.title, rawText),
            cwd: chosenCwd,
          });
        }
      },
      finishCancelled() {
        if (!cleanup()) return;
        const partial = [...itemTexts.values()].join('\n\n').trim();
        if (partial || activeTurn.diff || activeTurn.steps.length > 0) {
          appendMessage(safeRoom, {
            sender: 'codex',
            senderLabel: 'Codex',
            text: partial ? `${partial}\n\n*(已手动中止)*` : '*(回合已手动中止)*',
            diff: activeTurn.diff || '',
            reasoningSummary: activeTurn.reasoningSummary || '',
            plan: activeTurn.plan || [],
            codexThreadId: threadId,
            model: chosenModel,
            effort: chosenEffort,
            durationMs: Date.now() - startedAt,
            steps: activeTurn.steps,
          }, { expectedEpoch: roomEpoch, requireExists: true });
        }
        const cancelledMeta = releaseRoomTurnLease(safeRoom, leaseId, {
          ...buildInteractiveThreadPatch(),
          status: 'idle',
          activeTurn: null,
          lastError: null,
        });
        if (threadId && !chosenCwd.toLowerCase().includes('\\.gemini\\antigravity\\brain\\')) {
          syncCodexDesktopCatalogEntry({
            threadId,
            title: desiredDesktopTitle || formatCodexDesktopThreadName(cancelledMeta.title, rawText),
            cwd: chosenCwd,
          });
        }
      },
      fail(errMsg) {
        if (!cleanup()) return;
        const partial = [...itemTexts.values()].join('\n\n').trim();
        if (partial || activeTurn.diff) {
          appendMessage(safeRoom, {
            sender: 'codex',
            senderLabel: 'Codex',
            text: `${partial || '*(部分改动见下方 Diff)*'}\n\n*(执行中断: ${errMsg})*`,
            diff: activeTurn.diff || '',
            reasoningSummary: activeTurn.reasoningSummary || '',
            plan: activeTurn.plan || [],
            codexThreadId: threadId,
            model: chosenModel,
            effort: chosenEffort,
            durationMs: Date.now() - startedAt,
            steps: activeTurn.steps,
          }, { expectedEpoch: roomEpoch, requireExists: true });
        }
        releaseRoomTurnLease(safeRoom, leaseId, {
          ...buildInteractiveThreadPatch(),
          status: 'error',
          activeTurn: null,
          lastError: errMsg,
        });
      },
    };

    this.#activeTurnsByRoom.set(safeRoom, ctx);
    this.#activeTurnsByThread.set(threadId, ctx);

    const inputs = [];
    const nonImgFiles = [];
    for (const att of verifiedAtts) {
      if (att.isImage) inputs.push({ type: 'localImage', path: att.path });
      else nonImgFiles.push(att);
    }
    let effectiveText = rawText || '请查看并分析所附内容。';
    if (nonImgFiles.length > 0) {
      effectiveText += `\n\n[附加文件，可直接读取分析：\n${nonImgFiles.map((f) => `- ${f.name}: ${f.path}`).join('\n')}\n]`;
    }
    inputs.push({ type: 'text', text: effectiveText, text_elements: [] });

    try {
      const explicitTurnModel = chosenModel && chosenModel !== 'auto' ? chosenModel : undefined;
      const turnRes = await this.#rpc('turn/start', {
        threadId,
        ...(explicitTurnModel ? { model: explicitTurnModel } : {}),
        effort: chosenEffort,
        cwd: chosenCwd,
        approvalPolicy: chosenApproval,
        input: inputs,
      });
      if (turnRes?.turn?.id && !ctx.turnId) {
        ctx.turnId = turnRes.turn.id;
      }
      if (ctx.cancelRequested && ctx.turnId) {
        await this.#rpc('turn/interrupt', { threadId, turnId: ctx.turnId }, 5000).catch(() => {});
      }
    } catch (err) {
      ctx.fail(err.message);
      throw err;
    }

    return { started: true, roomId: safeRoom, threadId };
  }
}
