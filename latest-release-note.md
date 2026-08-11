## 1.6.5.1 Module Chat Modes, Thinking Panel & Fixes ✨

### 💬 Chat Experience

- The reasoning preview is upgraded from a single rolling line to a multi-line panel, so more of the thought process is visible while thinking.
- The chat input now accepts dropped folders, with unified drag-and-drop handling for files inside and outside the vault.
- Web search adds AnySearch as a new provider.

### 🧩 Module Platform

- Modules can now register their own chat modes, with isolated capability surfaces, pinned tool-approval policies, and skills shipped alongside the module.
- The module Host API now supports registering custom agent tools.

### 🐛 Fixes & Cleanup

- Fixed mobile startup hanging on "Loading plugins" for a long time when chat history is large. (#565)
- Fixed the "Import configuration" file picker not responding in Obsidian 1.13's standalone settings window.
- Fixed the Quick Ask continuation shortcut menu covering the model / reasoning-effort dropdowns, with unified popover layering and menu expansion direction.
- Fixed npm-installed Claude Code CLI on Windows being misdetected as a native binary and failing to launch. (#562)
- Removed the obsolete "path operation set" toggle from settings; path operations are handled by the virtual terminal.

---

## 1.6.5.1 模块聊天模式、思考面板与修复 ✨

### 💬 对话体验

- 思考过程预览从单行升级为多行面板，思考时能看到更多推理内容。
- 聊天输入框支持拖入文件夹，vault 内外的拖放逻辑已统一。
- 联网搜索新增 AnySearch Provider。

### 🧩 模块平台

- 模块可注册专属聊天模式：能力面隔离、工具审批策略固化，并支持随模块分发的专属 skills。
- 模块 Host API 支持注册自定义 Agent 工具。

### 🐛 修复与清理

- 修复聊天记录较多时移动端启动长时间卡在「加载插件中」无法使用的问题。（#565）
- 修复 Obsidian 1.13 独立设置窗口中「导入配置」选择文件无反应的问题。
- 修复 Quick Ask 续写快捷指令菜单遮挡模型/推理强度下拉的问题，统一弹窗层级与菜单展开方向。
- 修复 Windows 上 npm 安装的 Claude Code CLI 被误判为原生程序而无法启动的问题。（#562）
- 移除设置中已失效的「路径操作集」开关，路径操作已由虚拟终端接管。
