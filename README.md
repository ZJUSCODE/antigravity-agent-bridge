# Codex 对讲室（`codex-bridge` v3.1 企业版）

在 Antigravity 右侧辅助栏（Auxiliary Side Pane）内嵌 **1:1 复刻 OpenAI Codex 桌面端体验** 的纯原生双 AI 对讲与工程协同工作台，同时内置 **Antigravity ↔ OpenAI Codex 双向对等同侪协商技能（Peer Exchange Skills）**，无需切换任何外部软件即可完成实时流式对话、架构碰撞（RFC）、对抗式交叉代码审查（Code Review）、在线命令审批与 Diff 检视。

## 核心架构与企业级特性

1. **1:1 OpenAI Codex 视觉与交互复刻**
   - 自动发现并热缓存本机 Codex 桌面端原厂 `OpenAI Sans` 字体（Regular / Medium / Semibold），纯无彩中性色板自动跟随亮/暗色主题。
   - 完整支持 **按项目分组的历史会话抽屉**（支持 `Ctrl+K` 瞬时检索、置顶 `★`、行内重命名 `✎`、时间展示与删除）、**项目切换自动联动对应会话**、**模型与思考强度（Low → Ultra）实时切换**、**审批策略切换**、**双 AI 多轮 / 直连单聊切换**。
   - 每条消息正下方常驻展示精确时间（悬停查看精确到秒的完整时间）；支持完整 GFM Markdown 渲染（表格、标题、引用、任务清单、代码块一键复制）、可折叠 **思考摘要 + 执行计划 + 命令输出轨迹抽屉**、**Unified Diff 无损复制 Patch**、**图片点击灯箱放大** 以及 **一键导出 Markdown**。

2. **双引擎热驻留、`<5ms` 事件长轮询与跨进程安全加固**
   - **常驻 `codex app-server --stdio` JSON-RPC v2 引擎**（`sidecars/codex_room/app_server_bridge.mjs`）：零冷启动、逐 Token 实时流式输出、一次性审批令牌队列（`approvalToken`）、RPC 超时熔断与自动重连。
   - **持有者校验互斥文件锁 + 事件长轮询推送**（`sidecars/codex_room/codex_core.mjs`）：`mtimeMs + size` 内存缓存配合 `EventEmitter + fs.watch`，流式输出 `<5ms` 即时唤醒推送；通过 `roomEpoch + leaseId` 双重栅栏、逐跳符号链接防逃逸与按房间草稿隔离保障零串房、零丢稿。
   - **安全历史会话自动 `thread/fork`**：只读索引 `state_5.sqlite`（感知 WAL 更新），导入 Codex 桌面端历史会话后自动安全分支，防止 `SQLITE_BUSY` 写锁冲突。

3. **双向对等同侪协商技能（Dual-Agent Peer Exchange）**
   - **Antigravity 侧**：`skills/codex-chat/`（`talk_codex.mjs`）
   - **OpenAI Codex 侧**：`codex-skill/antigravity-chat/`（安装至 `~/.codex/skills/antigravity-chat/`，`talk_antigravity.mjs`）
   - 支持 `--protocol rfc|review|debug|audit`、`--diff-git`、`--file <path>` 以及 `AGY_CODEX_PEER_CALL=1` 操作系统级防递归死锁保护。

## 一键安装与自动化测试

```powershell
# 克隆后一键同步安装 Antigravity 插件与 Codex 侧技能：
git clone https://github.com/ZJUSCODE/codex-bridge.git "$HOME\.gemini\config\plugins\codex-bridge"
npm --prefix "$HOME\.gemini\config\plugins\codex-bridge" run setup

# 运行 11 项核心安全、并发与 HTTP 端到端测试：
npm --prefix "$HOME\.gemini\config\plugins\codex-bridge" test
```
