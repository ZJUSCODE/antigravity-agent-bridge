# Contributing to `codex-bridge`

Thank you for your interest in contributing to **`codex-bridge`**!

## Design Principles

1. **Zero External Runtime Dependencies**: `codex-bridge` runs purely on Node.js `>=22.5.0` built-in modules (`node:http`, `node:sqlite`, `node:fs`, `node:child_process`, `node:test`) plus Antigravity's native `sidecar_sdk`. Do not add third-party `npm` runtime dependencies.
2. **Cross-Platform Parity**: Every change must work seamlessly across **Windows**, **macOS**, and **Linux (including WSL 2)**. Avoid hardcoded drive letters, OS-specific shell quoting, or account-specific model slugs.
3. **Native Antigravity Theme Harmony**: UI styles in `sidecars/codex_room/styles.css` must bind directly to Antigravity's live `:root` CSS variables (`--background`, `--foreground`, `--card`, `--border`, `--primary`, `--font-family`, `--editor-font-family`) so light/dark/custom theme transitions stay instant and seamless.
4. **Safety & Anti-Recursion**: Bidirectional peer scripts (`talk_codex.mjs` and `talk_antigravity.mjs`) must strictly honor `AGY_CODEX_PEER_CALL=1` and cross-process turn leases (`roomEpoch` + PID heartbeat).

## Local Verification Checklist

Before opening a Pull Request, run:

```bash
npm run check
npm test
npm run doctor
```

All 15+ unit, concurrency, path-sandbox, and HTTP long-polling tests must pass with zero warnings.
