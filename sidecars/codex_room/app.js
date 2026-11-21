(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);

  const EFFORT_META = {
    low: { label: 'Low', desc: '极速响应，适合轻量问答' },
    medium: { label: 'Medium', desc: '均衡速度与推理深度' },
    high: { label: 'High', desc: '深度架构与代码推演' },
    xhigh: { label: 'XHigh', desc: '高强度复杂问题攻坚' },
    max: { label: 'Max', desc: '极限长链条推演' },
    ultra: { label: 'Ultra', desc: '最高算力终极思考' },
  };

  const APPROVAL_OPTIONS = [
    { id: 'on-request', short: '按需审批', title: '按需询问 (On Request)', desc: '沙盒外操作或越权命令弹出审批卡片' },
    { id: 'untrusted', short: '严格审批', title: '逐条严格审批 (Untrusted)', desc: '每次执行命令或写文件前均弹窗确认' },
    { id: 'never', short: '自动执行', title: '自动放行 (Never Ask)', desc: '在当前权限范围内全自动执行不打断' },
  ];

  const MODE_OPTIONS = [
    { id: 'dual-2', short: '协同 2轮', title: '多智能体自动协商 · 2 轮', desc: 'Antigravity 与所选智能体自动往返 2 轮并收敛结论' },
    { id: 'dual-3', short: '协同 3轮', title: '多智能体深入辩论 · 3 轮', desc: '双方或多方深入推演与交叉审查 3 轮' },
    { id: 'direct', short: '直连单聊', title: '直连当前所选智能体（或圆桌群聊）', desc: '直接向当前所选 Agent 发送消息并实时流式查看输出' },
  ];

  const CHECK_SVG = `<svg class="pop-check" viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-6.5"/></svg>`;

  const MAX_CLIENT_UPLOAD_BYTES = 20 * 1024 * 1024;

  const initialUrlRoomId = params.get('roomId') || '';
  let dynamicHostConvId = '';

  function readAutoFollowPref() {
    try {
      return localStorage.getItem('codex_room_global_follow_v2') === '1';
    } catch {
      return false;
    }
  }

  function saveAutoFollowPref(val) {
    try {
      localStorage.setItem('codex_room_global_follow_v2', val ? '1' : '0');
    } catch {}
  }

  const state = {
    viewEpoch: 1,
    etag: '',
    uiVersion: '',
    roomId: initialUrlRoomId,
    renderedRoomId: '',
    meta: null,
    messages: [],
    agents: [],
    models: [],
    projects: [],
    drawerData: null,
    drawerFilter: '',
    renamingRoomId: null,
    draftsByRoom: new Map(), // roomId -> { text: string, attachments: Array }
    submitting: false,
    stickToBottom: true,
    activeStartedAt: 0,
    seenIds: new Set(),
    firstRender: true,
    openPopover: null,
    errorStreak: 0,
    autoFollowLive: readAutoFollowPref(),
    bootSynced: false,
    seenLiveUpdatedAt: 0,
    manualHoldLiveKey: '',
    liveDiscussion: null,
    switchingLive: false,
  };

  function getDraftBucket(roomId) {
    const key = roomId || '__pending__';
    if (!state.draftsByRoom.has(key)) {
      state.draftsByRoom.set(key, { text: '', attachments: [] });
    }
    return state.draftsByRoom.get(key);
  }

  function currentAttachments() {
    return getDraftBucket(state.roomId).attachments;
  }

  function hostConvId() {
    return dynamicHostConvId || window.sidecar?.conversationId || params.get('conversationId') || 'global-default';
  }

  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    let theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const scale = c.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      theme = lum < 0.5 ? 'dark' : 'light';
    }
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
    document.documentElement.style.colorScheme = theme;
  }
  syncTheme();
  // Synchronously track Antigravity's live :root CSS token updates from preload.js!
  new MutationObserver(() => {
    syncTheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncTheme);

  window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'theme-change') {
      syncTheme();
      return;
    }
    const nextConv = ev.data?.type === 'conversation-change'
      ? (ev.data.payload?.conversationId || ev.data.conversationId || '')
      : '';
    if (nextConv && nextConv !== hostConvId()) {
      dynamicHostConvId = nextConv;
      resetRoomViewState('');
      loadCatalog().catch(() => {});
      triggerImmediateRefresh().catch(() => {});
    }
  });

  async function apiGet(path, signal) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET', cache: 'no-store', signal });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function apiPost(path, body) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  let toastTimer = null;
  function showToast(text, ms = 1800) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  async function copyText(text, okMsg = '已复制') {
    try {
      await navigator.clipboard.writeText(String(text || ''));
      showToast(okMsg);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = String(text || '');
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast(okMsg); } catch {}
      ta.remove();
    }
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function basenameOf(p) {
    if (!p) return '';
    const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function formatBytes(n) {
    if (!n || n < 1024) return `${n || 0} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatTokens(n) {
    if (!n || n <= 0) return '';
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M tok`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
    return `${n} tok`;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatMsgTime(tsInput) {
    if (!tsInput) return { short: '', full: '' };
    const d = typeof tsInput === 'number' ? new Date(tsInput) : new Date(String(tsInput));
    if (Number.isNaN(d.getTime())) return { short: '', full: '' };

    const y = d.getFullYear();
    const mo = pad2(d.getMonth() + 1);
    const da = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    const full = `${y}-${mo}-${da} ${hh}:${mm}:${ss}`;

    const now = new Date();
    const sameYear = y === now.getFullYear();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const targetDayStart = new Date(y, d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((todayStart - targetDayStart) / 86400000);

    let short;
    if (diffDays === 0) short = `${hh}:${mm}`;
    else if (diffDays === 1) short = `昨天 ${hh}:${mm}`;
    else if (sameYear) short = `${mo}-${da} ${hh}:${mm}`;
    else short = `${y}-${mo}-${da} ${hh}:${mm}`;

    return { short, full };
  }

  function fnv1aHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // ---------------------------------------------------------------------------
  // Unified Diff Renderer (with File Headers + One-Click Copy Patch)
  // ---------------------------------------------------------------------------
  function renderUnifiedDiff(diffText, openByDefault = false) {
    if (!diffText || !diffText.trim()) return '';
    const lines = diffText.split(/\r?\n/);
    let added = 0;
    let deleted = 0;
    const lineHtml = lines.map((l) => {
      if (l.startsWith('diff --git ')) {
        const m = /b\/(.+)$/.exec(l);
        const fileLabel = m ? m[1] : l;
        return `<div class="diff-file-row">${escapeHtml(fileLabel)}</div>`;
      }
      if (l.startsWith('+') && !l.startsWith('+++')) {
        added += 1;
        return `<div class="diff-line add">${escapeHtml(l)}</div>`;
      }
      if (l.startsWith('-') && !l.startsWith('---')) {
        deleted += 1;
        return `<div class="diff-line del">${escapeHtml(l)}</div>`;
      }
      if (l.startsWith('@@')) {
        return `<div class="diff-line hunk">${escapeHtml(l)}</div>`;
      }
      return `<div class="diff-line">${escapeHtml(l)}</div>`;
    }).join('');

    return `
      <details class="diff-card" ${openByDefault ? 'open' : ''}>
        <summary>
          <span>文件改动 Diff</span>
          <span class="diff-summary-right">
            <span class="diff-stats">
              <span class="diff-stat-add">+${added}</span>
              <span class="diff-stat-del">-${deleted}</span>
            </span>
            <button type="button" class="diff-copy-btn" data-copy-diff="1">复制 Patch</button>
          </span>
        </summary>
        <div class="diff-body">${lineHtml}</div>
      </details>
    `;
  }

  // ---------------------------------------------------------------------------
  // Full GFM Markdown Renderer (Tables, Headings, Task Lists, Code Copy)
  // ---------------------------------------------------------------------------
  function inlineMd(s) {
    const codeSpans = [];
    let str = s.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = codeSpans.length;
      codeSpans.push(`<code>${code}</code>`);
      return `\u0000IC${idx}\u0000`;
    });

    str = str
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|file:\/\/\/)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');

    codeSpans.forEach((html, idx) => {
      str = str.replace(`\u0000IC${idx}\u0000`, () => html);
    });
    return str;
  }

  function isTableSep(line) {
    const t = line.trim();
    if (!t.includes('|')) return false;
    const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    return cells.length >= 2 && cells.every((c) => /^:?-{3,}:?$/.test(c));
  }

  function splitTableCells(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  }

  function renderMarkdown(raw) {
    const escaped = escapeHtml(raw);
    const codeBlocks = [];
    const tokenized = escaped.replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
      const i = codeBlocks.length;
      const label = lang ? escapeHtml(lang) : 'text';
      codeBlocks.push(
        `<div class="codex-codeblock">` +
          `<div class="codex-codehead">` +
            `<span>${label}</span>` +
            `<button type="button" class="code-copy-btn" data-copy-code="1">复制</button>` +
          `</div>` +
          `<pre><code>${code.replace(/\r?\n$/, '')}</code></pre>` +
        `</div>`
      );
      return `\u0000CB${i}\u0000`;
    });

    const lines = tokenized.split(/\r?\n/);
    const out = [];
    let listTag = null;
    let para = [];
    let quoteLines = [];

    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${inlineMd(para.join('<br>'))}</p>`);
        para = [];
      }
    };
    const closeList = () => {
      if (listTag) {
        out.push(`</${listTag}>`);
        listTag = null;
      }
    };
    const flushQuote = () => {
      if (quoteLines.length) {
        out.push(`<blockquote>${quoteLines.map((q) => inlineMd(q)).join('<br>')}</blockquote>`);
        quoteLines = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();

      if (/^\u0000CB\d+\u0000$/.test(t)) {
        flushPara(); closeList(); flushQuote();
        out.push(t);
        continue;
      }
      if (!t) {
        flushPara(); closeList(); flushQuote();
        continue;
      }

      // GFM Table check
      if (t.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara(); closeList(); flushQuote();
        const headers = splitTableCells(t);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && lines[i].trim().includes('|') && !/^\u0000CB\d+\u0000$/.test(lines[i].trim())) {
          bodyRows.push(splitTableCells(lines[i]));
          i += 1;
        }
        i -= 1;
        const thHtml = headers.map((h) => `<th>${inlineMd(h)}</th>`).join('');
        const tbHtml = bodyRows.map((row) => {
          const tds = headers.map((_, ci) => `<td>${inlineMd(row[ci] || '')}</td>`).join('');
          return `<tr>${tds}</tr>`;
        }).join('');
        out.push(`<div class="codex-table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbHtml}</tbody></table></div>`);
        continue;
      }

      // Blockquote (`> ...` in escaped HTML is `&gt; ...`)
      if (/^&gt;\s?(.*)$/.test(t)) {
        flushPara(); closeList();
        quoteLines.push(t.replace(/^&gt;\s?/, ''));
        continue;
      }
      flushQuote();

      // Horizontal Rule
      if (/^(?:---|\*\*\*|___)$/.test(t)) {
        flushPara(); closeList();
        out.push('<hr>');
        continue;
      }

      // Headings
      const hd = /^(#{1,4})\s+(.+)$/.exec(t);
      if (hd) {
        flushPara(); closeList();
        const lvl = hd[1].length;
        out.push(`<h${lvl}>${inlineMd(hd[2])}</h${lvl}>`);
        continue;
      }

      // Task list item
      const task = /^[-*•]\s+\[([ xX])\]\s+(.+)$/.exec(t);
      if (task) {
        flushPara();
        if (listTag !== 'ul') { closeList(); listTag = 'ul'; out.push('<ul>'); }
        const checked = task[1].toLowerCase() === 'x';
        out.push(`<li class="task-item"><span class="task-box">${checked ? '☑' : '☐'}</span><span>${inlineMd(task[2])}</span></li>`);
        continue;
      }

      // Unordered list
      const ul = /^[-*•]\s+(.+)$/.exec(t);
      if (ul) {
        flushPara();
        if (listTag !== 'ul') { closeList(); listTag = 'ul'; out.push('<ul>'); }
        out.push(`<li>${inlineMd(ul[1])}</li>`);
        continue;
      }

      // Ordered list
      const ol = /^\d+\.\s+(.+)$/.exec(t);
      if (ol) {
        flushPara();
        if (listTag !== 'ol') { closeList(); listTag = 'ol'; out.push('<ol>'); }
        out.push(`<li>${inlineMd(ol[1])}</li>`);
        continue;
      }

      closeList();
      para.push(line);
    }

    flushPara();
    closeList();
    flushQuote();

    let html = out.join('');
    codeBlocks.forEach((cb, i) => {
      html = html.replace(`\u0000CB${i}\u0000`, () => cb);
    });
    return html;
  }

  // ---------------------------------------------------------------------------
  // Execution Trace Renderer (Reasoning Summary + Plan + Command Steps)
  // ---------------------------------------------------------------------------
  function renderTraceInner({ reasoningSummary, plan, steps, liveCommandOutput }) {
    const parts = [];
    if (reasoningSummary && reasoningSummary.trim()) {
      parts.push(`<div class="trace-reasoning">${escapeHtml(reasoningSummary.trim())}</div>`);
    }
    if (Array.isArray(plan) && plan.length > 0) {
      const items = plan.map((p) => {
        const cls = p.status === 'completed' ? 'done' : p.status === 'inProgress' ? 'active' : '';
        const icon = p.status === 'completed' ? '✓' : p.status === 'inProgress' ? '◉' : '○';
        return `<div class="trace-plan-item ${cls}"><span>${icon}</span><span>${escapeHtml(p.step)}</span></div>`;
      }).join('');
      parts.push(`<div class="trace-plan">${items}</div>`);
    }
    if (Array.isArray(steps) && steps.length > 0) {
      const stepRows = steps.map((s) => {
        const hasExit = s.exitCode !== undefined && s.exitCode !== null;
        const fail = hasExit && Number(s.exitCode) !== 0;
        const badge = hasExit
          ? `<span class="trace-exit-badge ${fail ? 'fail' : ''}">exit ${escapeHtml(s.exitCode)}</span>`
          : '';
        const outBlock = s.output
          ? `<pre class="trace-cmd-out">${escapeHtml(s.output)}</pre>`
          : '';
        return `
          <div class="trace-step-row">
            <div class="trace-step-head">
              <span class="trace-step-label">▸ ${escapeHtml(s.label || s.kind)}</span>
              ${badge}
            </div>
            ${outBlock}
          </div>
        `;
      }).join('');
      parts.push(`<div class="trace-steps">${stepRows}</div>`);
    }
    if (liveCommandOutput && liveCommandOutput.trim()) {
      parts.push(`<pre class="trace-cmd-out">${escapeHtml(liveCommandOutput.trim())}</pre>`);
    }
    return parts.join('');
  }

  // ---------------------------------------------------------------------------
  // Catalog & Popovers
  // ---------------------------------------------------------------------------
  function activeAgentObj() {
    const curId = state.meta?.activeAgent || 'codex';
    return state.agents.find((a) => a.id === curId) || state.agents[0] || { id: 'codex', shortName: 'Codex', displayName: 'OpenAI Codex', models: state.models };
  }

  function activeModelsList() {
    const ag = activeAgentObj();
    return (Array.isArray(ag?.models) && ag.models.length > 0) ? ag.models : state.models;
  }

  async function loadCatalog() {
    try {
      let wsUris = [];
      if (window.sidecar?.getWorkspaceUris) {
        wsUris = await window.sidecar.getWorkspaceUris().catch(() => []);
      }
      const q = wsUris.length ? `?workspaces=${encodeURIComponent(wsUris.join('|'))}` : '';
      const data = await apiGet(`/api/catalog${q}`);
      state.agents = data.agents || [];
      state.models = data.models || [];
      state.projects = data.projects || [];
    } catch {}
  }

  function closeAllPopovers() {
    ['pop-project', 'pop-agent', 'pop-model', 'pop-effort', 'pop-approval', 'pop-mode'].forEach((id) => $(id)?.classList.add('hidden'));
    state.openPopover = null;
  }

  function togglePopover(id, renderFn) {
    const el = $(id);
    const wasOpen = state.openPopover === id;
    closeAllPopovers();
    if (!wasOpen) {
      if (renderFn) renderFn();
      el.classList.remove('hidden');
      state.openPopover = id;
    }
  }

  document.addEventListener('click', (e) => {
    if (state.openPopover && !e.target.closest('.pop-anchor') && !e.target.closest('#btn-empty-project')) {
      closeAllPopovers();
    }
  });

  function renderProjectMenu() {
    const curCwd = (state.meta?.cwd || '').toLowerCase();
    const groups = new Map();
    for (const p of state.projects) {
      if (!groups.has(p.group)) groups.set(p.group, []);
      groups.get(p.group).push(p);
    }
    const html = [];
    for (const [gName, items] of groups.entries()) {
      html.push(`<div class="pop-group-label">${escapeHtml(gName)}</div>`);
      for (const item of items) {
        const active = item.path.toLowerCase() === curCwd;
        html.push(`
          <button type="button" class="pop-option proj-opt" data-path="${escapeHtml(item.path)}">
            <div class="pop-opt-main">
              <span class="pop-opt-title">${escapeHtml(item.name)}</span>
              <span class="pop-opt-sub">${escapeHtml(item.path)}</span>
            </div>
            ${active ? CHECK_SVG : ''}
          </button>
        `);
      }
    }
    $('project-list').innerHTML = html.join('') || `<div class="pop-header">可在下方粘贴任意本地目录</div>`;
  }

  function renderAgentMenu() {
    const curAgent = state.meta?.activeAgent || 'codex';
    $('agent-list').innerHTML = state.agents.map((ag) => {
      const active = ag.id === curAgent;
      const statusBadge = ag.isCouncil
        ? `<span class="agent-status-tag ready">${(ag.memberIds || []).length} 已就绪</span>`
        : (ag.installed
            ? `<span class="agent-status-tag ready">已就绪</span>`
            : `<span class="agent-status-tag">未安装</span>`);
      const subText = ag.isCouncil
        ? `并行征询: ${(ag.memberIds || []).join(', ') || '无'}`
        : `${ag.vendor}${ag.installed ? '' : ' · 安装对应 CLI 后自动点亮'}`;
      return `
        <button type="button" class="pop-option agent-opt" data-agent="${escapeHtml(ag.id)}">
          <div class="pop-opt-main">
            <span class="pop-opt-title" style="display:flex;align-items:center;gap:6px">
              <span class="agent-pill-dot agent-${escapeHtml(ag.id)}"></span>
              <span>${escapeHtml(ag.displayName)}</span>
              ${statusBadge}
            </span>
            <span class="pop-opt-sub">${escapeHtml(subText)}</span>
          </div>
          ${active ? CHECK_SVG : ''}
        </button>
      `;
    }).join('');
  }

  function renderModelMenu() {
    const models = activeModelsList();
    const curModel = state.meta?.model || models[0]?.slug || 'auto';
    $('model-list').innerHTML = models.map((m) => {
      const active = m.slug === curModel;
      return `
        <button type="button" class="pop-option model-opt" data-slug="${escapeHtml(m.slug)}">
          <div class="pop-opt-main">
            <span class="pop-opt-title">${escapeHtml(m.displayName)}</span>
            <span class="pop-opt-sub">${escapeHtml(m.slug)}</span>
          </div>
          ${active ? CHECK_SVG : ''}
        </button>
      `;
    }).join('');
  }

  function renderEffortMenu() {
    const models = activeModelsList();
    const curModelObj = models.find((m) => m.slug === state.meta?.model) || models[0];
    const efforts = curModelObj?.efforts || ['low', 'medium', 'high', 'xhigh', 'max'];
    const curEffort = state.meta?.effort || 'medium';

    $('effort-list').innerHTML = efforts.map((ef) => {
      const info = EFFORT_META[ef] || { label: ef, desc: '' };
      const active = ef === curEffort;
      return `
        <button type="button" class="pop-option effort-opt" data-effort="${escapeHtml(ef)}">
          <div class="pop-opt-main">
            <span class="pop-opt-title">${escapeHtml(info.label)}</span>
            ${info.desc ? `<span class="pop-opt-sub">${escapeHtml(info.desc)}</span>` : ''}
          </div>
          ${active ? CHECK_SVG : ''}
        </button>
      `;
    }).join('');
  }

  function renderApprovalMenu() {
    const cur = state.meta?.approvalPolicy || 'on-request';
    $('approval-list').innerHTML = APPROVAL_OPTIONS.map((a) => {
      const active = a.id === cur;
      return `
        <button type="button" class="pop-option approval-opt" data-approval="${escapeHtml(a.id)}">
          <div class="pop-opt-main">
            <span class="pop-opt-title">${escapeHtml(a.title)}</span>
            <span class="pop-opt-sub">${escapeHtml(a.desc)}</span>
          </div>
          ${active ? CHECK_SVG : ''}
        </button>
      `;
    }).join('');
  }

  function renderModeMenu() {
    const curMode = state.meta?.mode || 'dual-2';
    $('mode-list').innerHTML = MODE_OPTIONS.map((m) => {
      const active = m.id === curMode;
      return `
        <button type="button" class="pop-option mode-opt" data-mode="${escapeHtml(m.id)}">
          <div class="pop-opt-main">
            <span class="pop-opt-title">${escapeHtml(m.title)}</span>
            <span class="pop-opt-sub">${escapeHtml(m.desc)}</span>
          </div>
          ${active ? CHECK_SVG : ''}
        </button>
      `;
    }).join('');
  }

  $('btn-project').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('pop-project', renderProjectMenu); });
  $('btn-empty-project').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('pop-project', renderProjectMenu); });
  $('btn-agent').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('pop-agent', renderAgentMenu); });
  $('btn-model').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('pop-model', renderModelMenu); });
  $('btn-effort').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('pop-effort', renderEffortMenu); });
  $('btn-approval').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('pop-approval', renderApprovalMenu); });
  $('btn-mode').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('pop-mode', renderModeMenu); });

  async function switchProject(targetPath) {
    markManualRoomNavigation();
    const res = await apiPost('/api/projects/switch', {
      conversationId: hostConvId(),
      path: targetPath,
      model: state.meta?.model || state.models[0]?.slug || 'auto',
      effort: state.meta?.effort || 'medium',
      mode: state.meta?.mode || 'dual-2',
      approvalPolicy: state.meta?.approvalPolicy || 'on-request',
    });
    resetRoomViewState(res.roomId);
    await triggerImmediateRefresh();
    const pName = basenameOf(targetPath);
    if (res.action === 'created_project_thread') {
      showToast(`已在「${pName}」开启新对话`);
    } else {
      showToast(`已切至「${pName}」最近对话`);
    }
  }

  $('custom-dir-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = e.target.value.trim();
      if (!val) return;
      try {
        const res = await apiPost('/api/projects/add', { path: val });
        e.target.value = '';
        await loadCatalog();
        closeAllPopovers();
        await switchProject(res.project.path);
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  async function updateSetting(patch) {
    await apiPost('/api/settings', {
      conversationId: hostConvId(),
      roomId: state.roomId || undefined,
      ...patch,
    });
    await triggerImmediateRefresh();
  }

  // ---------------------------------------------------------------------------
  // Toolbar Title Double-Click Rename & Markdown Export
  // ---------------------------------------------------------------------------
  const titleSpan = $('toolbar-title');
  const titleInput = $('toolbar-title-input');

  function startToolbarRename() {
    if (!state.roomId) return;
    titleInput.value = state.meta?.title || '新对话';
    titleSpan.classList.add('hidden');
    titleInput.classList.remove('hidden');
    titleInput.focus();
    titleInput.select();
  }

  async function commitToolbarRename(save) {
    if (titleInput.classList.contains('hidden')) return;
    const val = titleInput.value.trim();
    titleInput.classList.add('hidden');
    titleSpan.classList.remove('hidden');
    if (save && val && val !== state.meta?.title) {
      try {
        await apiPost('/api/threads/rename', { roomId: state.roomId, title: val });
        await triggerImmediateRefresh();
      } catch (err) {
        showToast(err.message);
      }
    }
  }

  titleSpan.addEventListener('dblclick', startToolbarRename);
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitToolbarRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commitToolbarRename(false); }
  });
  titleInput.addEventListener('blur', () => commitToolbarRename(true));

  $('btn-open-codex')?.addEventListener('click', async () => {
    try {
      const res = await apiPost('/api/open-in-codex', {
        conversationId: hostConvId(),
        roomId: state.roomId || undefined,
      });
      showToast(
        res.projectMatched
          ? `已在 Codex 桌面端实时唤起该线程（归属项目：${res.projectName}）`
          : '已在 Codex 桌面端直接打开该线程（将该目录加入 Codex 左侧项目即可常驻列表）'
      );
    } catch (err) {
      showToast(err.message);
    }
  });

  $('btn-export').addEventListener('click', async () => {
    try {
      const res = await apiPost('/api/export', {
        conversationId: hostConvId(),
        roomId: state.roomId || undefined,
        saveToDisk: true,
      });
      await copyText(res.markdown || '', res.savedPath ? `已导出至 ${res.savedPath} 并复制` : '已复制 Markdown');
    } catch (err) {
      showToast(err.message);
    }
  });

  // ---------------------------------------------------------------------------
  // Drawer (Search, Pin ★, Inline Rename ✎, Delete ×)
  // ---------------------------------------------------------------------------
  const collapsedProjects = new Set();

  function isDrawerOpen() {
    return $('thread-drawer').classList.contains('open');
  }

  function openDrawer(focusSearch = false) {
    $('drawer-scrim').classList.remove('hidden');
    $('thread-drawer').classList.add('open');
    refreshThreadsDrawer().then(() => {
      if (focusSearch) $('drawer-search').focus();
    });
  }

  function closeDrawer() {
    state.renamingRoomId = null;
    $('drawer-scrim').classList.add('hidden');
    $('thread-drawer').classList.remove('open');
  }

  $('btn-sidebar').addEventListener('click', () => openDrawer(false));
  $('btn-close-drawer').addEventListener('click', closeDrawer);
  $('drawer-scrim').addEventListener('click', closeDrawer);

  $('drawer-search').addEventListener('input', (e) => {
    state.drawerFilter = e.target.value.trim().toLowerCase();
    renderDrawerDom();
  });

  function renderDrawerThreadItem(it, activeId) {
    if (it.kind === 'bridge') {
      const isActive = it.roomId === activeId;
      if (state.renamingRoomId === it.roomId) {
        return `
          <div class="drawer-item ${isActive ? 'active' : ''}">
            <input type="text" class="drawer-rename-input" data-rename-input="${escapeHtml(it.roomId)}" value="${escapeHtml(it.title || '新对话')}" maxlength="60" />
          </div>
        `;
      }
      const pinSvg = it.pinned
        ? `<svg viewBox="0 0 16 16"><path d="M8 2.2l1.8 3.6 4 .58-2.9 2.82.69 3.98L8 11.3l-3.59 1.88.69-3.98L2.2 6.38l4-.58L8 2.2Z" fill="currentColor"/></svg>`
        : `<svg viewBox="0 0 16 16"><path d="M8 2.2l1.8 3.6 4 .58-2.9 2.82.69 3.98L8 11.3l-3.59 1.88.69-3.98L2.2 6.38l4-.58L8 2.2Z"/></svg>`;
      const tInfo = it.sortTs ? formatMsgTime(it.sortTs) : { short: '', full: '' };
      return `
        <div class="drawer-item ${isActive ? 'active' : ''}" data-select-room="${escapeHtml(it.roomId)}">
          <div class="drawer-item-main">
            <span class="drawer-item-title">${it.pinned ? '<span class="drawer-pin-dot"></span>' : ''}${escapeHtml(it.title || '新对话')}</span>
            ${tInfo.short ? `<span class="drawer-item-sub" title="${escapeHtml(tInfo.full)}">${escapeHtml(tInfo.short)}</span>` : ''}
          </div>
          <div class="drawer-item-actions">
            <button type="button" class="drawer-act-btn" data-pin-room="${escapeHtml(it.roomId)}" title="${it.pinned ? '取消置顶' : '置顶'}">${pinSvg}</button>
            <button type="button" class="drawer-act-btn" data-rename-room="${escapeHtml(it.roomId)}" title="重命名">
              <svg viewBox="0 0 16 16"><path d="M11.6 2.4a1.2 1.2 0 0 1 1.7 1.7L5.8 11.6l-2.6.6.6-2.6 7.8-7.2Z"/></svg>
            </button>
            <button type="button" class="drawer-act-btn danger" data-del-room="${escapeHtml(it.roomId)}" title="删除对话">
              <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>
            </button>
          </div>
        </div>
      `;
    }
    const ntTime = it.sortTs ? formatMsgTime(it.sortTs) : { short: '', full: '' };
    return `
      <div class="drawer-item" data-import-codex="${escapeHtml(it.sessionId)}" data-title="${escapeHtml(it.title)}">
        <div class="drawer-item-main">
          <span class="drawer-item-title">${escapeHtml(it.title)}</span>
          ${ntTime.short ? `<span class="drawer-item-sub" title="${escapeHtml(ntTime.full)}">${escapeHtml(ntTime.short)}</span>` : ''}
        </div>
      </div>
    `;
  }

  function renderDrawerDom() {
    const data = state.drawerData;
    if (!data) return;
    const activeId = data.activeRoomId;
    const curCwdLower = (state.meta?.cwd || '').toLowerCase();
    const q = state.drawerFilter;

    const folderSvg = `<svg viewBox="0 0 16 16"><path d="M2.25 4.5c0-.69.56-1.25 1.25-1.25h3.1l1.4 1.5h4.5c.69 0 1.25.56 1.25 1.25v5.75c0 .69-.56 1.25-1.25 1.25h-9c-.69 0-1.25-.56-1.25-1.25V4.5Z"/></svg>`;
    const plusSvg = `<svg viewBox="0 0 16 16"><path d="M8 3.25v9.5M3.25 8h9.5"/></svg>`;
    const sections = [];

    for (const pg of (data.projectGroups || [])) {
      const projMatch = !q || pg.name.toLowerCase().includes(q) || pg.path.toLowerCase().includes(q);
      const filteredItems = q
        ? (projMatch ? pg.items : pg.items.filter((it) => String(it.title || '').toLowerCase().includes(q)))
        : pg.items;

      if (q && !projMatch && filteredItems.length === 0) continue;

      const key = pg.path.toLowerCase();
      const isCurProj = key === curCwdLower;
      const defaultCollapsed = filteredItems.length === 0 && !isCurProj && !q;
      const isCollapsed = !q && (collapsedProjects.has(key) || (defaultCollapsed && !collapsedProjects.has(`open:${key}`)));

      const childrenHtml = isCollapsed
        ? ''
        : (filteredItems.length > 0
            ? `<div class="proj-group-children">${filteredItems.map((it) => renderDrawerThreadItem(it, activeId)).join('')}</div>`
            : `<div class="proj-group-children"><div class="proj-empty-hint">暂无对话，点右侧 + 新建</div></div>`);

      sections.push(`
        <div class="proj-group">
          <div class="proj-group-head ${isCurProj ? 'current-proj' : ''}" data-toggle-proj="${escapeHtml(pg.path)}">
            <div class="proj-head-left">
              ${folderSvg}
              <span class="proj-head-name">${escapeHtml(pg.name)}</span>
              ${filteredItems.length ? `<span class="proj-head-count">${filteredItems.length}</span>` : ''}
            </div>
            <button type="button" class="proj-new-btn" data-new-in-proj="${escapeHtml(pg.path)}" title="在此项目新建对话">
              ${plusSvg}
            </button>
          </div>
          ${childrenHtml}
        </div>
      `);
    }

    const ungrouped = (data.ungrouped || []).filter((it) => !q || String(it.title || '').toLowerCase().includes(q));
    if (ungrouped.length > 0) {
      sections.push(`<div class="drawer-section-label">通用对话（未绑定项目）</div>`);
      sections.push(`<div class="drawer-list">${ungrouped.map((it) => renderDrawerThreadItem(it, activeId)).join('')}</div>`);
    }

    $('drawer-tree').innerHTML = sections.join('') || `<div class="pop-header">${q ? '无匹配的对话或项目' : '暂无项目或对话'}</div>`;

    if (state.renamingRoomId) {
      const inp = document.querySelector(`[data-rename-input="${CSS.escape(state.renamingRoomId)}"]`);
      if (inp) {
        inp.focus();
        inp.select();
        inp.addEventListener('keydown', async (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            const val = inp.value.trim();
            const rId = state.renamingRoomId;
            state.renamingRoomId = null;
            if (val) await apiPost('/api/threads/rename', { roomId: rId, title: val }).catch(() => {});
            await refreshThreadsDrawer();
            await triggerImmediateRefresh();
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            state.renamingRoomId = null;
            renderDrawerDom();
          }
        });
        inp.addEventListener('blur', async () => {
          if (!state.renamingRoomId) return;
          const val = inp.value.trim();
          const rId = state.renamingRoomId;
          state.renamingRoomId = null;
          if (val) await apiPost('/api/threads/rename', { roomId: rId, title: val }).catch(() => {});
          await refreshThreadsDrawer();
          await triggerImmediateRefresh();
        });
      }
    }
  }

  async function refreshThreadsDrawer() {
    try {
      let wsUris = [];
      if (window.sidecar?.getWorkspaceUris) {
        wsUris = await window.sidecar.getWorkspaceUris().catch(() => []);
      }
      const wsParam = wsUris.length ? `&workspaces=${encodeURIComponent(wsUris.join('|'))}` : '';
      state.drawerData = await apiGet(`/api/threads?conversationId=${encodeURIComponent(hostConvId())}${wsParam}`);
      renderDrawerDom();
    } catch {}
  }

  function saveOutgoingDraft() {
    const inp = $('composer-input');
    if (inp && state.roomId) {
      getDraftBucket(state.roomId).text = inp.value;
    }
  }

  function restoreIncomingDraft(roomId) {
    const inp = $('composer-input');
    if (!inp) return;
    const bucket = getDraftBucket(roomId);
    inp.value = bucket.text || '';
    inp.style.height = 'auto';
    inp.style.height = `${Math.min(132, Math.max(24, inp.scrollHeight))}px`;
    renderPendingAttachments();
  }

  function resetRoomViewState(newRoomId) {
    saveOutgoingDraft();
    state.viewEpoch += 1;
    state.roomId = newRoomId || '';
    state.meta = null;
    state.messages = [];
    state.etag = '';
    state.seenIds.clear();
    state.firstRender = true;
    state.stickToBottom = true;
    restoreIncomingDraft(state.roomId);
  }

  function liveTurnKey(live) {
    if (!live || !live.roomId) return '';
    return `${live.roomId}:${live.leaseStartedAt || live.updatedAt || 0}`;
  }

  function markManualRoomNavigation() {
    state.bootSynced = true;
    if (state.liveDiscussion) {
      state.manualHoldLiveKey = liveTurnKey(state.liveDiscussion);
      state.seenLiveUpdatedAt = Math.max(state.seenLiveUpdatedAt, Number(state.liveDiscussion.updatedAt) || 0);
    }
  }

  function syncAutoFollowButton() {
    const btn = $('btn-auto-follow');
    if (!btn) return;
    btn.classList.toggle('auto-follow-on', Boolean(state.autoFollowLive));
    btn.title = state.autoFollowLive
      ? '当前模式：全局追随后台实时讨论（任意对话开跑时自动切屏；点击恢复随当前 Antigravity 对话切换窗口）'
      : '当前模式：随 Antigravity 对话自动切换对应窗口（点击可开启全局追随后台实时讨论）';
  }

  async function jumpToLiveRoom(live, toastMsg) {
    if (!live?.roomId || state.switchingLive) return;
    state.switchingLive = true;
    try {
      $('live-radar-banner').classList.add('hidden');
      state.manualHoldLiveKey = '';
      state.seenLiveUpdatedAt = Math.max(state.seenLiveUpdatedAt, Number(live.updatedAt) || 0);
      // Switch in-memory ONLY so peeking at a live room NEVER pollutes host_room_map for the current Antigravity tab!
      resetRoomViewState(live.roomId);
      if (toastMsg) {
        showToast(`${toastMsg}：${live.title || '双 AI 协商'}`, 2400);
      }
      setTimeout(() => { triggerImmediateRefresh().catch(() => {}); }, 10);
    } catch {} finally {
      state.switchingLive = false;
    }
  }

  $('btn-auto-follow').addEventListener('click', () => {
    state.autoFollowLive = !state.autoFollowLive;
    saveAutoFollowPref(state.autoFollowLive);
    syncAutoFollowButton();
    if (state.autoFollowLive) {
      state.manualHoldLiveKey = '';
      const live = state.liveDiscussion;
      if (live && live.roomId && live.roomId !== state.roomId && (live.status === 'thinking' || live.status === 'awaiting_approval')) {
        jumpToLiveRoom(live, '已切入实时讨论');
        return;
      }
      showToast('已开启全局追随实时讨论');
    } else {
      // Immediately snap back to the current Antigravity conversation's bound session window!
      resetRoomViewState('');
      triggerImmediateRefresh().catch(() => {});
      showToast('已恢复随当前 Antigravity 对话自动切换窗口');
    }
  });

  $('btn-jump-live').addEventListener('click', () => {
    if (state.liveDiscussion?.roomId) {
      jumpToLiveRoom(state.liveDiscussion, '已切入实时讨论');
    }
  });

  syncAutoFollowButton();

  async function handleCreateNewThread(overrideCwd) {
    closeDrawer();
    markManualRoomNavigation();
    const targetCwd = typeof overrideCwd === 'string' ? overrideCwd : (state.meta?.cwd || null);
    const res = await apiPost('/api/threads/create', {
      conversationId: hostConvId(),
      cwd: targetCwd,
      model: state.meta?.model || state.models[0]?.slug || 'auto',
      effort: state.meta?.effort || 'medium',
      mode: state.meta?.mode || 'dual-2',
      approvalPolicy: state.meta?.approvalPolicy || 'on-request',
    });
    resetRoomViewState(res.roomId);
    await triggerImmediateRefresh();
    $('composer-input').focus();
  }

  $('btn-new-thread').addEventListener('click', () => handleCreateNewThread());
  $('btn-drawer-new').addEventListener('click', () => handleCreateNewThread());

  // ---------------------------------------------------------------------------
  // Uploads & Lightbox
  // ---------------------------------------------------------------------------
  function openLightbox(src) {
    if (!src) return;
    $('lightbox-img').src = src;
    $('lightbox').classList.remove('hidden');
  }

  function closeLightbox() {
    $('lightbox').classList.add('hidden');
    $('lightbox-img').src = '';
  }

  $('lightbox').addEventListener('click', (e) => {
    if (e.target === $('lightbox') || e.target === $('lightbox-close')) closeLightbox();
  });

  function renderPendingAttachments() {
    const strip = $('attachment-strip');
    const atts = currentAttachments();
    if (atts.length === 0) {
      strip.classList.add('hidden');
      strip.innerHTML = '';
      syncSubmitButton();
      return;
    }
    strip.classList.remove('hidden');
    strip.innerHTML = atts.map((att, idx) => {
      if (att.isImage) {
        return `
          <div class="att-thumb-card">
            <img src="${escapeHtml(att.previewUrl)}" alt="${escapeHtml(att.name)}" data-lightbox-src="${escapeHtml(att.previewUrl)}" />
            <button type="button" class="att-remove" data-rm-att="${idx}" aria-label="移除">×</button>
          </div>
        `;
      }
      return `
        <div class="att-file-card">
          <span class="att-file-name">${escapeHtml(att.name)}</span>
          <span class="att-file-size">${escapeHtml(formatBytes(att.size))}</span>
          <button type="button" class="att-remove" data-rm-att="${idx}" aria-label="移除">×</button>
        </div>
      `;
    }).join('');
    syncSubmitButton();
  }

  async function uploadFiles(fileList) {
    const pinnedRoomId = state.roomId || '';
    const pinnedEpoch = state.viewEpoch;

    for (const file of Array.from(fileList || [])) {
      try {
        if (file.size > MAX_CLIENT_UPLOAD_BYTES) {
          showToast(`「${file.name || '文件'}」超过 20MB 上限`);
          continue;
        }
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(new Error('读取文件失败'));
          r.readAsDataURL(file);
        });
        const res = await apiPost('/api/upload', {
          conversationId: hostConvId(),
          roomId: pinnedRoomId || undefined,
          fileName: file.name || 'pasted-image.png',
          mimeType: file.type || 'application/octet-stream',
          dataBase64: dataUrl,
        });
        const destRoom = res.roomId;
        if (!state.roomId && state.viewEpoch === pinnedEpoch) {
          state.roomId = destRoom;
        }
        getDraftBucket(destRoom).attachments.push({
          ...res.attachment,
          roomId: destRoom,
          previewUrl: res.attachment.isImage
            ? `/api/attachment?roomId=${encodeURIComponent(destRoom)}&file=${encodeURIComponent(res.attachment.storedName)}`
            : '',
        });
        if (state.roomId === destRoom) {
          renderPendingAttachments();
        }
      } catch (err) {
        showToast(err.message);
      }
    }
  }

  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    if (e.target.files?.length) {
      await uploadFiles(e.target.files);
      e.target.value = '';
    }
  });

  $('composer-input').addEventListener('paste', async (e) => {
    const fileItems = Array.from(e.clipboardData?.items || []).filter((it) => it.kind === 'file');
    if (fileItems.length > 0) {
      e.preventDefault();
      await uploadFiles(fileItems.map((it) => it.getAsFile()).filter(Boolean));
    }
  });

  const shellEl = $('codex-shell');
  const dropOverlay = $('drop-overlay');
  let dragDepth = 0;
  shellEl.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); dragDepth += 1; dropOverlay.classList.remove('hidden'); }
  });
  shellEl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  shellEl.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) dropOverlay.classList.add('hidden'); });
  shellEl.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; dropOverlay.classList.add('hidden');
    if (e.dataTransfer?.files?.length) await uploadFiles(e.dataTransfer.files);
  });

  // ---------------------------------------------------------------------------
  // Keyed Flicker-Free DOM Reconciliation & Batched Rendering
  // ---------------------------------------------------------------------------
  const scrollEl = $('thread-scroll');
  const bottomBtn = $('btn-bottom');
  scrollEl.addEventListener('scroll', () => {
    const dist = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    state.stickToBottom = dist < 48;
    if (state.stickToBottom) bottomBtn.classList.add('hidden');
  });
  bottomBtn.addEventListener('click', () => {
    state.stickToBottom = true;
    bottomBtn.classList.add('hidden');
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
  });

  function scrollIfNeeded(hasNew = false) {
    if (state.stickToBottom) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      bottomBtn.classList.add('hidden');
    } else if (hasNew) {
      bottomBtn.classList.remove('hidden');
    }
  }

  function renderTurnAttachments(atts) {
    if (!Array.isArray(atts) || atts.length === 0) return '';
    const items = atts.map((a) => {
      if (a.isImage && a.storedName) {
        const src = `/api/attachment?roomId=${encodeURIComponent(state.roomId)}&file=${encodeURIComponent(a.storedName)}`;
        return `<img class="turn-img-thumb" src="${src}" data-lightbox-src="${src}" alt="${escapeHtml(a.name)}" loading="lazy" />`;
      }
      return `<span class="turn-file-chip">📄 ${escapeHtml(a.name)}</span>`;
    }).join('');
    return `<div class="turn-attachments">${items}</div>`;
  }

  function computeMsgSig(m, round) {
    return fnv1aHash(JSON.stringify([
      m.sender || '',
      m.senderLabel || '',
      round,
      m.ts || '',
      m.text || '',
      m.diff || '',
      m.reasoningSummary || '',
      m.durationMs || 0,
      m.model || '',
      m.steps || [],
      m.plan || [],
      (m.attachments || []).map((a) => a.storedName || a.name || ''),
    ]));
  }

  function buildMessageNode(m, idx, round, isFresh) {
    const wrapper = document.createElement('div');
    wrapper.dataset.msgKey = m.id || `seq_${m.seq}`;
    wrapper.dataset.msgSig = computeMsgSig(m, round);
    wrapper.dataset.msgIdx = String(idx);

    if (m.sender === 'system' || m.sender === 'topic') {
      wrapper.className = 'topic-divider';
      wrapper.textContent = m.text;
      return wrapper;
    }

    const timeInfo = formatMsgTime(m.ts);
    const timeHtml = timeInfo.short
      ? `<span class="msg-time" title="${escapeHtml(timeInfo.full)}">${escapeHtml(timeInfo.short)}</span>`
      : '';

    if (m.sender === 'user' || m.sender === 'antigravity') {
      const isAgy = m.sender === 'antigravity';
      const who = isAgy
        ? `Antigravity${round ? ` · 第 ${round} 轮` : ''}`
        : (m.senderLabel || '你');
      wrapper.className = `prompt-turn${isAgy ? ' peer-agy' : ''}${isFresh ? ' arriving' : ''}`;
      wrapper.innerHTML = `
        <span class="prompt-caption">${isAgy ? '<span class="role-dot agy-dot" aria-hidden="true"></span>' : ''}${escapeHtml(who)}</span>
        ${renderTurnAttachments(m.attachments)}
        ${m.text ? `<div class="prompt-pill">${renderMarkdown(m.text)}</div>` : ''}
        ${timeHtml}
      `;
      return wrapper;
    }

    const senderKey = String(m.sender || 'codex').toLowerCase();
    const agentDisplay = m.senderLabel || (senderKey === 'codex' ? 'Codex' : senderKey === 'pi' ? 'Pi Agent' : senderKey === 'claude' ? 'Claude Code' : senderKey === 'gemini' ? 'Gemini CLI' : m.sender);
    const secs = m.durationMs ? `${Math.max(1, Math.round(m.durationMs / 1000))}s` : '';
    const modelNote = m.model && m.model !== 'auto' && m.model !== senderKey ? ` · ${m.model}` : '';
    const stepCount = Array.isArray(m.steps) ? m.steps.length : 0;
    const stepNote = stepCount > 0 ? ` · ${stepCount} 步` : '';
    const traceText = `${secs ? `${agentDisplay}${modelNote} · 耗时 ${secs}` : `${agentDisplay}${modelNote}`}${stepNote}`;
    const dotClass = `trace-blossom agent-${escapeHtml(senderKey)}`;

    const traceInner = renderTraceInner({
      reasoningSummary: m.reasoningSummary,
      plan: m.plan,
      steps: m.steps,
    });

    const traceRowHtml = traceInner
      ? `
        <details class="trace-details">
          <summary>
            <span class="${dotClass}" aria-hidden="true"></span>
            <span>${escapeHtml(traceText)}</span>
            <svg class="trace-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5"/></svg>
          </summary>
          <div class="trace-drawer">${traceInner}</div>
        </details>
      `
      : `
        <div class="trace-row">
          <span class="${dotClass}" aria-hidden="true"></span>
          <span>${escapeHtml(traceText)}</span>
        </div>
      `;

    wrapper.className = `assistant-turn${isFresh ? ' arriving' : ''}`;
    wrapper.innerHTML = `
      ${traceRowHtml}
      <div class="codex-prose">${renderMarkdown(m.text)}</div>
      ${renderUnifiedDiff(m.diff, false)}
      <div class="turn-footer-row">
        ${timeHtml}
        <div class="turn-footer-actions">
          <button type="button" class="mini-icon-btn btn-copy" data-idx="${idx}" title="复制整段回复">
            <svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M3.25 10.5V3.75c0-.55.45-1 1-1H10.5"/></svg>
          </button>
        </div>
      </div>
    `;
    return wrapper;
  }

  function reconcileMessages(messages) {
    const turnsEl = $('turns');
    const emptyEl = $('empty-state');
    const isBusy = state.meta?.status === 'thinking' || state.meta?.status === 'awaiting_approval';

    if (state.renderedRoomId !== state.roomId) {
      turnsEl.innerHTML = '';
      state.renderedRoomId = state.roomId;
    }

    if ((!messages || messages.length === 0) && !isBusy) {
      emptyEl.classList.remove('hidden');
      turnsEl.innerHTML = '';
      return false;
    }
    emptyEl.classList.add('hidden');

    const existingMap = new Map();
    for (const child of Array.from(turnsEl.children)) {
      if (child.dataset.msgKey) existingMap.set(child.dataset.msgKey, child);
    }

    const desiredKeys = new Set();
    let round = 0;
    let hasNew = false;

    messages.forEach((m, idx) => {
      const key = m.id || `seq_${m.seq}`;
      desiredKeys.add(key);
      if (m.sender === 'system' || m.sender === 'topic') round = 0;
      else if (m.sender === 'antigravity') round += 1;

      const sig = computeMsgSig(m, round);
      const isFresh = !state.firstRender && !state.seenIds.has(key);
      if (isFresh) hasNew = true;
      state.seenIds.add(key);

      let node = existingMap.get(key);
      if (!node) {
        node = buildMessageNode(m, idx, round, isFresh);
      } else if (node.dataset.msgSig !== sig) {
        const replacement = buildMessageNode(m, idx, round, false);
        node.replaceWith(replacement);
        node = replacement;
        existingMap.set(key, node);
      } else {
        node.dataset.msgIdx = String(idx);
        const copyBtn = node.querySelector('.btn-copy');
        if (copyBtn) copyBtn.dataset.idx = String(idx);
      }

      const refNode = turnsEl.children[idx] || null;
      if (refNode !== node) {
        turnsEl.insertBefore(node, refNode);
      }
    });

    for (const [k, node] of existingMap.entries()) {
      if (!desiredKeys.has(k)) node.remove();
    }

    state.firstRender = false;
    return hasNew;
  }

  function syncSubmitButton() {
    const btn = $('btn-submit');
    const up = $('svg-up');
    const stop = $('svg-stop');
    const isBusy = state.meta?.status === 'thinking' || state.meta?.status === 'awaiting_approval';

    if (isBusy) {
      btn.disabled = false;
      up.classList.add('hidden');
      stop.classList.remove('hidden');
      btn.title = '停止';
    } else {
      const readyForRoom = Boolean(state.meta && (!state.roomId || state.meta.conversationId === state.roomId));
      const hasContent = readyForRoom && !state.submitting && ($('composer-input').value.trim().length > 0 || currentAttachments().length > 0);
      btn.disabled = !hasContent;
      up.classList.remove('hidden');
      stop.classList.add('hidden');
      btn.title = '发送';
    }
  }

  function renderMeta(meta) {
    if (!meta) return;
    $('toolbar-title').textContent = meta.title || '新对话';
    const projName = meta.cwd ? basenameOf(meta.cwd) : '选择项目';
    $('project-label').textContent = projName;
    $('empty-project-label').textContent = meta.cwd ? `${projName} (${meta.cwd})` : '选择工作项目目录';

    const curAg = activeAgentObj();
    if ($('agent-label')) $('agent-label').textContent = curAg.shortName || curAg.displayName || 'Codex';
    if ($('agent-dot')) $('agent-dot').className = `agent-pill-dot agent-${curAg.id || 'codex'}`;

    const models = activeModelsList();
    const foundModel = models.find((m) => m.slug === meta.model);
    $('model-label').textContent = foundModel
      ? foundModel.displayName
      : (meta.model && meta.model !== 'auto' ? meta.model : (models[0]?.displayName || 'Auto'));

    const efInfo = EFFORT_META[meta.effort] || { label: meta.effort || 'Medium' };
    $('effort-label').textContent = efInfo.label;

    const apprInfo = APPROVAL_OPTIONS.find((a) => a.id === meta.approvalPolicy) || APPROVAL_OPTIONS[0];
    $('approval-label').textContent = apprInfo.short;

    const modeInfo = MODE_OPTIONS.find((m) => m.id === meta.mode) || MODE_OPTIONS[0];
    $('mode-label').textContent = modeInfo.short;

    const openCodexBtn = $('btn-open-codex');
    if (openCodexBtn) {
      openCodexBtn.classList.toggle('hidden', !meta.codexThreadId);
    }

    // Telemetry badge (Tokens / Quota)
    const telEl = $('toolbar-telemetry');
    const tokStr = formatTokens(meta.tokenUsage?.totalTokens);
    if (tokStr) {
      telEl.textContent = tokStr;
      const tipParts = [`累计 Token: ${meta.tokenUsage.totalTokens.toLocaleString()}`];
      if (meta.rateLimitPercent !== null && meta.rateLimitPercent !== undefined) {
        tipParts.push(`窗口配额已用: ${meta.rateLimitPercent}%`);
      }
      telEl.title = tipParts.join(' · ');
      telEl.classList.remove('hidden');
    } else {
      telEl.classList.add('hidden');
    }

    // Live Streaming Turn
    const isBusy = meta.status === 'thinking' || meta.status === 'awaiting_approval';
    const thinkingTurn = $('thinking-turn');

    if (isBusy) {
      thinkingTurn.classList.remove('hidden');
      state.activeStartedAt = meta.activeTurn?.startedAt || Date.now();
      $('thinking-text').textContent = meta.activeTurn?.liveStatus || 'Thinking';

      const liveTraceEl = $('thinking-trace');
      const liveTraceHtml = renderTraceInner({
        reasoningSummary: meta.activeTurn?.reasoningSummary,
        plan: meta.activeTurn?.plan,
        steps: meta.activeTurn?.steps,
        liveCommandOutput: meta.activeTurn?.liveCommandOutput,
      });
      if (liveTraceHtml) {
        liveTraceEl.classList.remove('hidden');
        liveTraceEl.innerHTML = liveTraceHtml;
      } else {
        liveTraceEl.classList.add('hidden');
        liveTraceEl.innerHTML = '';
      }

      const streamEl = $('thinking-stream');
      if (meta.activeTurn?.streamingText) {
        streamEl.classList.remove('hidden');
        streamEl.innerHTML = renderMarkdown(meta.activeTurn.streamingText);
      } else {
        streamEl.classList.add('hidden');
        streamEl.innerHTML = '';
      }

      const diffEl = $('thinking-diff');
      if (meta.activeTurn?.diff) {
        diffEl.classList.remove('hidden');
        diffEl.innerHTML = renderUnifiedDiff(meta.activeTurn.diff, true);
      } else {
        diffEl.classList.add('hidden');
        diffEl.innerHTML = '';
      }
    } else {
      thinkingTurn.classList.add('hidden');
      state.activeStartedAt = 0;
    }

    // Approval Card (queued multi-approval support with exact RPC ID preservation)
    const apprCard = $('approval-card');
    const pendingList = Array.isArray(meta.activeTurn?.pendingApprovals)
      ? meta.activeTurn.pendingApprovals
      : (meta.activeTurn?.pendingApproval ? [meta.activeTurn.pendingApproval] : []);
    const pending = pendingList[0] || null;

    if (meta.status === 'awaiting_approval' && pending) {
      apprCard.classList.remove('hidden');
      apprCard.dataset.approvalToken = String(pending.approvalToken ?? pending.rpcId ?? '');
      const qSuffix = pendingList.length > 1 ? ` (1/${pendingList.length})` : '';
      $('approval-title').textContent = `${pending.kind === 'fileChange' ? 'Codex 请求修改文件权限' : 'Codex 请求执行命令'}${qSuffix}`;
      if (pending.reason) {
        $('approval-reason').classList.remove('hidden');
        $('approval-reason').textContent = pending.reason;
      } else {
        $('approval-reason').classList.add('hidden');
      }
      $('approval-cmd').textContent = pending.command || pending.cwd || '(需要授权)';
    } else {
      apprCard.classList.add('hidden');
      apprCard.dataset.approvalToken = '';
    }

    const errBox = $('err-box');
    if (meta.lastError) {
      errBox.classList.remove('hidden');
      errBox.textContent = meta.lastError;
    } else {
      errBox.classList.add('hidden');
    }

    syncSubmitButton();
  }

  let rafPending = false;
  function scheduleUiRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const hasNew = reconcileMessages(state.messages);
      renderMeta(state.meta);
      const isBusy = state.meta?.status === 'thinking' || state.meta?.status === 'awaiting_approval';
      scrollIfNeeded(hasNew || isBusy);
    });
  }

  // ---------------------------------------------------------------------------
  // Event-Driven Long-Polling Loop with Instant Abort & Exponential Backoff
  // ---------------------------------------------------------------------------
  let activePollController = null;

  async function fetchRoomOnce({ force = false, wait = false } = {}) {
    const reqEpoch = state.viewEpoch;
    const expectedRoom = state.roomId || '';
    const conv = encodeURIComponent(hostConvId());
    const roomParam = expectedRoom ? `&roomId=${encodeURIComponent(expectedRoom)}` : '';
    const etagParam = (!force && state.etag) ? `&etag=${encodeURIComponent(state.etag)}` : '';
    const waitParam = (wait && !force && state.etag) ? '&wait=1&timeoutMs=8000' : '';

    const ctrl = new AbortController();
    activePollController = ctrl;

    try {
      const snap = await apiGet(`/api/room?conversationId=${conv}${roomParam}${etagParam}${waitParam}`, ctrl.signal);
      if (reqEpoch !== state.viewEpoch) return;
      if (expectedRoom && snap.conversationId && snap.conversationId !== expectedRoom) return;

      state.errorStreak = 0;
      $('conn-dot').classList.add('hidden');

      if (snap.uiVersion && state.uiVersion && snap.uiVersion !== state.uiVersion) {
        window.location.reload();
        return;
      }
      if (snap.uiVersion) state.uiVersion = snap.uiVersion;

      // Global Live Discussion Radar & Auto-Follow across conversations
      if ('liveDiscussion' in snap) {
        state.liveDiscussion = snap.liveDiscussion || null;
        const live = state.liveDiscussion;
        const curRoom = snap.conversationId || state.roomId;
        const banner = $('live-radar-banner');

        if (live && live.roomId && live.roomId !== curRoom) {
          const liveKey = liveTurnKey(live);
          const isLiveBusy = live.status === 'thinking' || live.status === 'awaiting_approval';
          const liveTs = Number(live.updatedAt) || 0;

          state.seenLiveUpdatedAt = Math.max(state.seenLiveUpdatedAt, liveTs);
          state.bootSynced = true;

          const curStatus = snap.meta?.status ?? state.meta?.status;
          const curBusy = curStatus === 'thinking' || curStatus === 'awaiting_approval';
          const hasUnsentInput = Boolean($('composer-input')?.value.trim()) || currentAttachments().length > 0;

          // By default (`autoFollowLive === false`), strictly stay on the current Antigravity conversation's window!
          // Only auto-jump if the user explicitly enabled global live-follow AND another room is actively running right now.
          if (
            state.autoFollowLive &&
            isLiveBusy &&
            !curBusy &&
            !hasUnsentInput &&
            !state.switchingLive &&
            state.manualHoldLiveKey !== liveKey
          ) {
            await jumpToLiveRoom(live, '已自动切入实时讨论');
            return;
          }

          if (isLiveBusy && banner) {
            const projSuffix = live.projectName ? ` · ${live.projectName}` : '';
            $('live-radar-text').textContent = `其他会话正在讨论：${live.title || '双 AI 协商'}${projSuffix}`;
            banner.classList.remove('hidden');
          } else if (banner) {
            banner.classList.add('hidden');
          }
        } else {
          state.bootSynced = true;
          if (live?.updatedAt) {
            state.seenLiveUpdatedAt = Math.max(state.seenLiveUpdatedAt, Number(live.updatedAt) || 0);
          }
          if (banner) banner.classList.add('hidden');
        }
      }

      if (snap.unchanged) return;
      // Reject out-of-order regressive snapshots within the same room
      if (
        state.roomId === snap.conversationId &&
        state.meta &&
        typeof state.meta.rev === 'number' &&
        typeof snap.meta?.rev === 'number' &&
        snap.meta.rev < state.meta.rev
      ) {
        return;
      }

      const wasUnset = !state.roomId;
      state.etag = snap.etag || '';
      state.roomId = snap.conversationId;
      state.meta = snap.meta;
      state.messages = snap.messages || [];
      if (wasUnset && state.roomId) {
        const pendingDefault = state.draftsByRoom.get('__pending__');
        if (pendingDefault && (pendingDefault.text || pendingDefault.attachments.length)) {
          const dest = getDraftBucket(state.roomId);
          if (!dest.text) dest.text = pendingDefault.text;
          dest.attachments.push(...pendingDefault.attachments);
          state.draftsByRoom.delete('__pending__');
          renderPendingAttachments();
        }
      }
      scheduleUiRender();
    } catch (err) {
      if (err?.name === 'AbortError' || reqEpoch !== state.viewEpoch) return;
      state.errorStreak += 1;
      if (state.errorStreak >= 2) $('conn-dot').classList.remove('hidden');
    } finally {
      if (activePollController === ctrl) activePollController = null;
    }
  }

  async function triggerImmediateRefresh() {
    if (activePollController) {
      try { activePollController.abort(); } catch {}
      activePollController = null;
    }
    await fetchRoomOnce({ force: true, wait: false });
  }

  async function runLongPollLoop() {
    while (true) {
      await fetchRoomOnce({ force: false, wait: Boolean(state.etag) });
      if (state.errorStreak > 0) {
        const backoff = Math.min(4000, 500 * Math.pow(2, Math.min(3, state.errorStreak - 1)));
        await new Promise((r) => setTimeout(r, backoff));
      } else {
        // Tiny yield before re-entering long-poll
        await new Promise((r) => setTimeout(r, 35));
      }
    }
  }

  setInterval(() => {
    if (state.activeStartedAt > 0) {
      const sec = Math.max(0, Math.floor((Date.now() - state.activeStartedAt) / 1000));
      $('thinking-timer').textContent = `${sec}s`;
    }
  }, 300);

  // ---------------------------------------------------------------------------
  // Composer & Event Delegation
  // ---------------------------------------------------------------------------
  const inputEl = $('composer-input');
  function resizeInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(132, Math.max(24, inputEl.scrollHeight))}px`;
    syncSubmitButton();
  }
  inputEl.addEventListener('input', resizeInput);

  function pruneSubmittedDraft(bucket, submittedRawText, submittedAttKeys, isCustom, targetRoomId) {
    bucket.attachments = bucket.attachments.filter((a) => !submittedAttKeys.has(a.id || a.storedName));
    if (!isCustom) {
      if (state.roomId === targetRoomId) {
        if (inputEl.value === submittedRawText) {
          inputEl.value = '';
        } else if (submittedRawText && inputEl.value.startsWith(submittedRawText)) {
          inputEl.value = inputEl.value.slice(submittedRawText.length).replace(/^\s+/, '');
        }
        bucket.text = inputEl.value;
        resizeInput();
        renderPendingAttachments();
      } else if (bucket.text === submittedRawText) {
        bucket.text = '';
      }
    } else if (state.roomId === targetRoomId) {
      renderPendingAttachments();
    }
  }

  async function handleSubmit(customTopic) {
    if (state.submitting || !state.meta) return;
    if (state.roomId && state.meta.conversationId !== state.roomId) return;

    const isCustom = typeof customTopic === 'string';
    const submittedRawInput = isCustom ? '' : inputEl.value;
    const text = (isCustom ? customTopic : submittedRawInput).trim();
    const pinnedRoomId = state.meta.conversationId || state.roomId;
    const bucket = getDraftBucket(pinnedRoomId);
    const attachments = [...bucket.attachments];
    if (!text && attachments.length === 0) return;

    const submittedAttKeys = new Set(attachments.map((a) => a.id || a.storedName));
    const snapCtx = {
      hostId: hostConvId(),
      roomId: pinnedRoomId,
      activeAgent: state.meta.activeAgent || 'codex',
      model: state.meta.model || activeModelsList()[0]?.slug || 'auto',
      effort: state.meta.effort || 'medium',
      approvalPolicy: state.meta.approvalPolicy || 'on-request',
      cwd: state.meta.cwd || null,
      mode: state.meta.mode || 'dual-2',
    };

    state.submitting = true;
    syncSubmitButton();
    $('err-box').classList.add('hidden');

    try {
      if (snapCtx.mode === 'direct' || snapCtx.activeAgent === 'council' || !window.sidecar?.agent?.sendMessage) {
        const res = await apiPost('/api/ask-agent', {
          conversationId: snapCtx.hostId,
          roomId: snapCtx.roomId,
          agentId: snapCtx.activeAgent,
          prompt: text,
          attachments,
          sender: 'user',
          senderLabel: '你',
          model: snapCtx.model,
          effort: snapCtx.effort,
          approvalPolicy: snapCtx.approvalPolicy,
          cwd: snapCtx.cwd,
        });
        if (res.started !== false && !res.cancelled) {
          pruneSubmittedDraft(bucket, submittedRawInput, submittedAttKeys, isCustom, res.roomId || snapCtx.roomId);
          state.stickToBottom = true;
        }
        if (state.roomId === snapCtx.roomId) {
          await triggerImmediateRefresh();
        }
      } else {
        const rounds = snapCtx.mode === 'dual-3' ? 3 : 2;
        const announceRes = await apiPost('/api/announce-topic', {
          conversationId: snapCtx.hostId,
          roomId: snapCtx.roomId,
          topic: text,
          rounds,
          attachments,
        });
        const finalRoomId = announceRes.roomId || snapCtx.roomId;
        const verifiedAtts = Array.isArray(announceRes.verifiedAttachments) ? announceRes.verifiedAttachments : [];

        const attFlags = verifiedAtts
          .filter((a) => a.isImage && a.path)
          .map((a) => `--image "${a.path}"`)
          .join(' ');
        const attContext = verifiedAtts.length
          ? `\n附带文件：\n${verifiedAtts.map((a) => `- ${a.name}: ${a.path}`).join('\n')}`
          : '';
        const cwdInfo = snapCtx.cwd ? `\n工作目录：${snapCtx.cwd}` : '';
        const peerName = activeAgentObj().displayName || snapCtx.activeAgent;

        const instruction =
          `请围绕以下议题，调用 talk_agent.mjs（传入 --agent "${snapCtx.activeAgent}" --room "${finalRoomId}" --model "${snapCtx.model}" --effort "${snapCtx.effort}"${snapCtx.cwd ? ` --cwd "${snapCtx.cwd}"` : ''} ${attFlags}）` +
          `在右侧对讲室中与 ${peerName} 自动有来有回协商 ${rounds} 轮，讨论结束后在对话框给我最终结论：\n\n议题：${text || '请分析所附图片/文件'}${cwdInfo}${attContext}`;

        await window.sidecar.agent.sendMessage(instruction, snapCtx.hostId !== 'global-default' ? snapCtx.hostId : undefined);

        pruneSubmittedDraft(bucket, submittedRawInput, submittedAttKeys, isCustom, finalRoomId);
        state.stickToBottom = true;
        if (state.roomId === snapCtx.roomId || state.roomId === finalRoomId) {
          await triggerImmediateRefresh();
        }
      }
    } catch (err) {
      const errBox = $('err-box');
      errBox.classList.remove('hidden');
      errBox.textContent = err.message;
    } finally {
      state.submitting = false;
      syncSubmitButton();
    }
  }

  $('btn-submit').addEventListener('click', async () => {
    const isBusy = state.meta?.status === 'thinking' || state.meta?.status === 'awaiting_approval';
    if (isBusy) {
      await apiPost('/api/cancel', { conversationId: hostConvId(), roomId: state.roomId || undefined });
      await triggerImmediateRefresh();
    } else {
      await handleSubmit();
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const isBusy = state.meta?.status === 'thinking' || state.meta?.status === 'awaiting_approval';
      if (!isBusy) handleSubmit();
    }
  });

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (isDrawerOpen()) closeDrawer();
      else openDrawer(true);
      return;
    }
    if (e.key === 'Escape') {
      if (!$('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
      if (state.openPopover) { closeAllPopovers(); return; }
      if (!titleInput.classList.contains('hidden')) { commitToolbarRename(false); return; }
      if (isDrawerOpen() && !state.renamingRoomId) { closeDrawer(); }
    }
  });

  document.addEventListener('click', async (e) => {
    // Lightbox image click
    const lbImg = e.target.closest('[data-lightbox-src]');
    if (lbImg) {
      openLightbox(lbImg.dataset.lightboxSrc);
      return;
    }

    // Codeblock copy
    const codeCopyBtn = e.target.closest('[data-copy-code]');
    if (codeCopyBtn) {
      const codeEl = codeCopyBtn.closest('.codex-codeblock')?.querySelector('code');
      if (codeEl) await copyText(codeEl.textContent || '', '已复制代码');
      return;
    }

    // Diff Patch copy (lossless verbatim Unified Diff)
    const diffCopyBtn = e.target.closest('[data-copy-diff]');
    if (diffCopyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const inThinking = Boolean(diffCopyBtn.closest('#thinking-diff'));
      let rawPatch = '';
      if (inThinking) {
        rawPatch = state.meta?.activeTurn?.diff || '';
      } else {
        const msgTurn = diffCopyBtn.closest('[data-msg-idx]');
        if (msgTurn) {
          const msg = state.messages[Number(msgTurn.dataset.msgIdx)];
          rawPatch = msg?.diff || '';
        }
      }
      if (rawPatch) await copyText(rawPatch, '已复制完整 Diff Patch');
      return;
    }

    // Approval Decision (submits one-time opaque approvalToken)
    const apprDecisionBtn = e.target.closest('[data-decision]');
    if (apprDecisionBtn) {
      const approvalToken = $('approval-card').dataset.approvalToken || '';
      const decision = apprDecisionBtn.dataset.decision;
      try {
        await apiPost('/api/approve', {
          conversationId: hostConvId(),
          roomId: state.roomId || undefined,
          approvalToken,
          decision,
        });
        await triggerImmediateRefresh();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    // Project select
    const projOpt = e.target.closest('.proj-opt');
    if (projOpt) {
      closeAllPopovers();
      try { await switchProject(projOpt.dataset.path); } catch (err) { showToast(err.message); }
      return;
    }

    const newInProj = e.target.closest('[data-new-in-proj]');
    if (newInProj) {
      e.stopPropagation();
      await handleCreateNewThread(newInProj.dataset.newInProj);
      showToast(`已在「${basenameOf(newInProj.dataset.newInProj)}」新建对话`);
      return;
    }

    const toggleProj = e.target.closest('[data-toggle-proj]');
    if (toggleProj) {
      const key = toggleProj.dataset.toggleProj.toLowerCase();
      if (collapsedProjects.has(key)) {
        collapsedProjects.delete(key);
        collapsedProjects.add(`open:${key}`);
      } else if (collapsedProjects.has(`open:${key}`)) {
        collapsedProjects.delete(`open:${key}`);
        collapsedProjects.add(key);
      } else {
        collapsedProjects.add(key);
      }
      renderDrawerDom();
      return;
    }

    const agentOpt = e.target.closest('.agent-opt');
    if (agentOpt) {
      closeAllPopovers();
      const nextAgentId = agentOpt.dataset.agent;
      const targetAg = state.agents.find((a) => a.id === nextAgentId);
      const nextModel = targetAg?.defaultModel || targetAg?.models?.[0]?.slug || 'auto';
      await updateSetting({ activeAgent: nextAgentId, model: nextModel });
      return;
    }

    const modelOpt = e.target.closest('.model-opt');
    if (modelOpt) { closeAllPopovers(); await updateSetting({ model: modelOpt.dataset.slug }); return; }

    const effortOpt = e.target.closest('.effort-opt');
    if (effortOpt) { closeAllPopovers(); await updateSetting({ effort: effortOpt.dataset.effort }); return; }

    const apprOpt = e.target.closest('.approval-opt');
    if (apprOpt) { closeAllPopovers(); await updateSetting({ approvalPolicy: apprOpt.dataset.approval }); return; }

    const modeOpt = e.target.closest('.mode-opt');
    if (modeOpt) { closeAllPopovers(); await updateSetting({ mode: modeOpt.dataset.mode }); return; }

    // Remove pending attachment + clean up disk file
    const rmAtt = e.target.closest('[data-rm-att]');
    if (rmAtt) {
      const idx = Number(rmAtt.dataset.rmAtt);
      const bucket = getDraftBucket(state.roomId);
      const removed = bucket.attachments.splice(idx, 1)[0];
      renderPendingAttachments();
      if (removed?.storedName) {
        apiPost('/api/upload/remove', {
          conversationId: hostConvId(),
          roomId: removed.roomId || state.roomId || undefined,
          storedName: removed.storedName,
        }).catch(() => {});
      }
      return;
    }

    // Drawer Pin
    const pinRoom = e.target.closest('[data-pin-room]');
    if (pinRoom) {
      e.stopPropagation();
      await apiPost('/api/threads/pin', { roomId: pinRoom.dataset.pinRoom });
      await refreshThreadsDrawer();
      await triggerImmediateRefresh();
      return;
    }

    // Drawer Inline Rename
    const renRoom = e.target.closest('[data-rename-room]');
    if (renRoom) {
      e.stopPropagation();
      state.renamingRoomId = renRoom.dataset.renameRoom;
      renderDrawerDom();
      return;
    }

    // Drawer Delete
    const delRoom = e.target.closest('[data-del-room]');
    if (delRoom) {
      e.stopPropagation();
      await apiPost('/api/threads/delete', { conversationId: hostConvId(), roomId: delRoom.dataset.delRoom });
      resetRoomViewState('');
      await refreshThreadsDrawer();
      await triggerImmediateRefresh();
      return;
    }

    // Drawer Select Room
    const selRoom = e.target.closest('[data-select-room]');
    if (selRoom && !e.target.closest('.drawer-rename-input')) {
      closeDrawer();
      markManualRoomNavigation();
      const res = await apiPost('/api/threads/select', { conversationId: hostConvId(), roomId: selRoom.dataset.selectRoom });
      resetRoomViewState(res.roomId);
      await triggerImmediateRefresh();
      return;
    }

    // Drawer Import Native Codex Session
    const impCodex = e.target.closest('[data-import-codex]');
    if (impCodex) {
      closeDrawer();
      markManualRoomNavigation();
      showToast('正在加载并准备安全分支…');
      const res = await apiPost('/api/threads/import-codex', {
        conversationId: hostConvId(),
        sessionId: impCodex.dataset.importCodex,
        title: impCodex.dataset.title || '',
      });
      resetRoomViewState(res.roomId);
      await triggerImmediateRefresh();
      return;
    }

    const sug = e.target.closest('.suggestion-card');
    if (sug && sug.dataset.topic) {
      handleSubmit(sug.dataset.topic);
      return;
    }

    const copyBtn = e.target.closest('.btn-copy');
    if (copyBtn) {
      const msg = state.messages[Number(copyBtn.dataset.idx)];
      if (msg) await copyText(msg.text || '', '已复制回复');
    }
  });

  if (typeof window.sidecar?.onWorkspaceChange === 'function') {
    window.sidecar.onWorkspaceChange(() => {
      loadCatalog().catch(() => {});
    });
  }

  (async () => {
    await loadCatalog();
    runLongPollLoop();
  })();
})();
