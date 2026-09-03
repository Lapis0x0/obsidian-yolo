## 1.6.8.1 Hotfix 🛠️

### 🛠️ Hotfix

- Fixed a freshly installed module coming up broken: YOLO Whiteboard opened unstyled and unresponsive until Obsidian was restarted. The notes below are from 1.6.8.

## 1.6.8 YOLO Whiteboard & On-Demand Tools 🧩

### New module

- **Introducing YOLO Whiteboard**: for now, think of it as an Obsidian Canvas several to dozens of times faster. More features that push the boundaries of AI and human thinking are on the way.

### Agent & tools

- A more complete and elegant unified progressive disclosure for tools
- Added Grok build as a new CLI agent channel

### Models & connections

- Fixed ChatGPT OAuth requests failing with a 400 when Web Search was enabled. (#588)
- Fixed non-streaming requests such as conversation titles returning no content over a desktop direct ChatGPT OAuth connection. (#589)
- Fixed the local MCP server failing to start when its default port collided with Local REST API, and made the port configurable. (#586)
- Updated the OpenRouter model capability snapshot.

### Chat & interface

- The model picker in the chat input now shows more of the model name instead of truncating early when there is room.
- Fixed the Similar Notes list being clipped with no way to scroll it in a short window.

---

## 1.6.8.1 Hotfix 🛠️

### 🛠️ 热修复

- 修复模块安装后首次启动即损坏的问题：YOLO 白板打开后没有样式、无法操作，必须重启 Obsidian 才能正常使用。以下为 1.6.8 的更新内容。

## 1.6.8 YOLO 白板与工具按需披露 🧩

### 新模块

- **引入 YOLO 白板**：你目前可以把它当成一个性能好上几倍到几十倍的 Obsidian Canvas。未来会添加更多可以充分拓展 AI 与人类思考疆界的新功能。

### Agent 与工具

- 实现更为完整、优雅的统一工具渐进式披露
- 添加 Grok build 作为新的 CLI Agent 渠道

### 模型与连接

- 修复 ChatGPT OAuth 开启 Web Search 时请求报 400 的问题。（#588）
- 修复 ChatGPT OAuth 桌面直连下，会话标题等非流式请求拿不到内容的问题。（#589）
- 修复本地 MCP 服务默认端口与 Local REST API 冲突导致无法启动的问题，并开放端口配置。（#586）
- 更新 OpenRouter 模型能力快照。

### 对话与界面

- 聊天输入框的模型选择器会显示更完整的模型名，不再在有空间时提前截断。
- 修复相似笔记列表在窗口较矮时被截断且无法滚动的问题。
