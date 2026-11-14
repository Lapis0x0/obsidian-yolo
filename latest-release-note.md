## 1.6.17 Subagent Control & Long-Session Stability 🛡️

### Subagents

- Fixed subagent delegation failing permanently after its allowed models were cleared. (#643)
- Stopping a conversation now also cancels the subagents it dispatched. (#647)
- The Activity & Reminders panel now lists running subagents, and clicking one opens its details; clicking a conversation entry no longer opens a duplicate window. (#645)

### Context and requests

- Fixed a single oversized terminal output filling up the context and leaving the conversation unable to continue; stopping now also aborts an in-progress context compaction. (#652)
- Request timeouts now get their own message suggesting a longer timeout; the context-usage popover now follows the server-reported total, removing the mismatch between the usage percentage and the breakdown total. (#646)

### Review and progress feedback

- Improved the review view experience. (#622)
- Improved how collapsed multi-tool calls look.

---

## 1.6.17 子 Agent 管控与长会话稳定性 🛡️

### 子 Agent

- 修复子 Agent 可用模型被清空后委派永久失败的问题。（#643）
- 停止会话时一并取消它派出的子 Agent。（#647）
- 活动与提醒面板列出运行中的子 Agent，点击直达详情；点击会话条目不再重复打开窗口。（#645）

### 上下文与请求

- 修复单条超长终端输出撑爆上下文导致会话无法继续的问题；停止时同时中止进行中的上下文压缩。（#652）
- 请求超时单独提示并引导调大超时；上下文用量弹层以服务端总量为准，消除占用百分比与明细总数的矛盾。（#646）

### 审阅与进度反馈

- 优化审阅视图的体验。（#622）
- 优化多工具调用折叠的样式表现。
