## 1.6.5.6 Multi-Agent Hermes & Editing Without Freezes ⚡

### Agent & Hermes CLI

- Hermes CLI can now switch between multiple agents, and supports manual context compaction.
- Fixed Obsidian freezing or becoming unresponsive while the agent edited files — line-count stats and edit review no longer run an unbounded full-file diff on the main thread. (#420)
- Agent workspace scope no longer sends excluded paths to the model, and the `js_eval` bypass for reading them is closed. (#577)

### Chat experience

- Restored the streaming reveal trail on assistant output, with opacity interpolation handed to the browser for smoother, cheaper animation.
- Hovering the token counter in a popout window no longer shows the tooltip in the main window. (#576)

### Reading & knowledge base

- Fixed PDF annotations where the number marker disappeared right after creation and the note input sometimes never appeared.
- Knowledge base indexing on an outdated Obsidian installer no longer fails with `extension "vector" is not available`; it now tells you to update the client instead. (#579)

---

## 1.6.5.6 Hermes 多 Agent 与不再卡死的文件编辑 ⚡

### Agent 与 Hermes CLI

- Hermes CLI 支持切换多个 agent，并接入手动压缩上下文。
- 修复 Agent 编辑文件时整个 Obsidian 可能卡死无响应的问题：行数统计与编辑评审不再在主线程上跑无上限的全文 diff。（#420）
- Agent 工作范围不再把排除路径发给模型，并堵住 `js_eval` 绕过读取的通道。（#577）

### 对话体验

- 重新为流式正文加回显影尾巴，透明度插值交给浏览器，动画更顺滑、开销更低。
- 弹出窗口中悬停 token 统计时，浮层不再显示到主窗口。（#576）

### 阅读与知识库

- 修复 PDF 批注创建后编号标记立即消失、批注输入框有时完全不出现的问题。
- 知识库索引在旧版 Obsidian installer 下不再报 `extension "vector" is not available`，改为直接提示更新客户端。（#579）
