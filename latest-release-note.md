## 1.6.5 Agent Tools, Cross-Device Sync & Chat Polish ✨

### 🛠️ Agent Capabilities

- New virtual Bash tool unifies file search and operations in a sandboxed shell over your vault.
- Oversized virtual bash output is now auto-truncated with guidance to narrow the query, preventing large directory listings from flooding context. (#555)
- The agent can read `[[wikilink]]` targets directly, resolving down to `#heading` / `^block` ranges. (#555)
- The `js_eval` tool is renamed to Analysis Sandbox to better reflect its purpose.
- Added support for DeepSeek's native web search tool.

### 💬 Chat Experience

- Reworked streaming rendering and scroll performance, with a unified motion system and polished high-frequency interaction animations.
- Multiple consecutive tool cards now auto-collapse for a cleaner agent conversation view.
- Fixed the view unexpectedly scrolling to the bottom when expanding reasoning content.

### ⚡ Quick Ask & CLI

- Quick Ask and YOLO Agent now share unified core runtime semantics; Smart Space is retired, with its continuation feature merged into Quick Ask's third mode. (#529)
- The CLI mode menu adds native actions for Claude plugin management and MCP server status. (#535)
- More robust CLI executable discovery, with support for custom CLI paths.

### 🔄 Data Sync & Fixes

- Chat history, learning data, and module settings moved to a visible `data/` directory inside your vault, so sync tools like Obsidian Sync can replicate them across devices. In Obsidian Sync, enable "Sync all other types" to include them.
- Fixed Learning project creation failing on Windows with Obsidian 1.13.4 due to `_staging` temp directory cleanup errors, which could leave empty folders behind. (#556)

---

## 1.6.5 Agent 工具、跨设备同步与对话体验 ✨

### 🛠️ Agent 能力

- 新增虚拟 Bash 工具，在 vault 沙箱 shell 中统一文件检索与操作能力。
- 虚拟 bash 超大输出自动截断并引导收窄查询，防止大目录列出灌爆上下文。（#555）
- Agent 支持直接读取 `[[wikilink]]` 目标，可精确定位到 `#标题` / `^块` 范围。（#555）
- `js_eval` 工具更名为「分析沙箱」，更符合产品定位。
- 适配支持 DeepSeek 官方原生搜索工具。

### 💬 对话体验

- 重构流式渲染与滚动性能，统一动效体系并补齐高频交互动画。
- 连续多个工具卡片自动折叠，Agent 对话视觉更清爽。
- 修复展开思维链内容时视图意外滚动到底部的问题。

### ⚡ Quick Ask 与 CLI

- 统一 Quick Ask 与 YOLO Agent 的核心运行语义；Smart Space 退役，续写能力并入 Quick Ask 第三档模式。（#529）
- CLI 模式菜单新增 Claude 插件管理与 MCP 服务器状态原生动作。（#535）
- 增强 CLI 定位鲁棒性，支持自定义 CLI 路径。

### 🔄 数据同步与修复

- 聊天记录、学习数据与模块配置迁至 vault 内可见的 `data/` 目录，Obsidian Sync 等同步工具可跨设备同步；Obsidian Sync 需开启「同步所有其他类型文件」。
- 修复 Windows + Obsidian 1.13.4 下 Learning 清理 `_staging` 临时目录报错导致项目创建失败并残留空目录的问题。（#556）
