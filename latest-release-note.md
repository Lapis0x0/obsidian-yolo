## 1.6.5.2 Chat History Panel Overhaul & Fixes ✨

### 💬 Chat History Panel

- The pane's "…" menu now supports full conversation actions, adding "Open chat history / Export current conversation" commands. (#567)
- The pane title bar now shows the conversation's real title, and it can be renamed by clicking it directly.
- The history panel's context menu now closes layer-by-layer with Esc, sizes itself to content, and shows overflowing items; the delete action moves back inline. (#567)
- The history panel no longer gets squeezed by a narrow sidebar; long titles truncate in the middle while keeping the "(copy)" suffix, and accidental clicks on action icons are fixed. (#567)
- Off-screen entries now render on demand, cutting the panel's open latency by roughly 40% (~260ms → ~160ms).
- The history panel is now fully keyboard-reachable: arrow-key/Enter navigation, shortcuts for delete/pin/rename, and a keybinding legend at the bottom. (#567)
- Pin/unpin now animates as a reorder the list follows, action buttons become a hover overlay, and the title regains the full row width.

### 🐛 Fixes

- Fixed existing conversation history disappearing when a message was appended while a task was still running. (#566)
- Fixed the whole UI stalling when opening the history panel while the agent was still replying.
- Fixed being unable to continue a conversation after deleting messages within it.

### ⚙️ Core & Performance

- Partially refactored the chat core, cleaning up long-standing architectural debt.
- Chat history persistence is now event-driven, fixing repeated errors from high-frequency rewrites in the repo-sync backend. (#569)

---

## 1.6.5.2 聊天历史弹层全面改造与修复 ✨

### 💬 聊天历史弹层

- 聊天窗格 ⋯ 菜单支持完整会话操作，新增「打开聊天历史 / 导出当前对话」命令。（#567）
- 窗格标题栏显示当前会话的真实标题，支持点击直接改名。
- 历史弹层右键菜单支持 Esc 逐层关闭、宽度自适应内容并支持溢出显示，删除按钮回归行内。（#567）
- 历史弹层不再被窄侧边栏压扁，超长标题居中截断并保住「(副本)」后缀，修复操作图标误触问题。（#567）
- 视口外条目改为按需渲染，弹层打开延迟降低约 40%（~260ms → ~160ms）。
- 历史弹层全程键盘可达：支持方向键/Enter 导航，删除/置顶/改名快捷键，底部新增键位图例。（#567）
- 置顶/取消置顶改为可跟随的重排动效，操作区改为悬停浮层，标题栏拿回整行宽度。

### 🐛 修复

- 修复任务运行中追加消息导致已有历史对话记录丢失的问题。（#566）
- 修复 Agent 回复期间打开会话历史面板导致整个界面卡顿的问题。
- 修复删除对话内消息后无法继续对话的问题。

### ⚙️ 内核与性能

- 部分重构聊天内核，清理历史遗留的架构债务。
- 聊天记录落盘改为事件驱动，修复仓库同步后端因高频重写持续报错的问题。（#569）
