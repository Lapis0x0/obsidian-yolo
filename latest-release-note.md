## 1.6.4.1 Polish & Sparkle Writing ✨

### 🧭 CLI Agent

- Codex and Claude Code menus now expand on hover, matching the CLI/Agent interaction pattern.
- Third-party provider models no longer break CLI Agent model picking or leave the list loading forever; YOLO uses the models Codex or Claude Code actually expose.
- Fixed Codex failing to start for some Windows users, and improved auto-detection of common Codex and Claude Code install paths.

### 🪟 Chat UI

- Improved the chat header when the sidebar is compressed on narrow screens.
- Fixed the standalone chat window’s right capsule toolbar getting clipped on wide screens.

### 🔐 Auth Diagnostics

- When the local ChatGPT OAuth callback server fails to start, YOLO now shows the port and underlying error so conflicts are easier to diagnose.

### ✨ Sparkle Writing

- Writing assistance is now branded as Sparkle (灵光写作). The sidebar entry and settings section stay in sync, with fewer low-value options in the way.

---

## 1.6.4.1 体验打磨与灵光写作 ✨

### 🧭 CLI Agent

- Codex 与 Claude Code 选择菜单支持悬停展开，交互与 CLI/Agent 一致。
- 修复第三方 Provider 模型导致 CLI Agent 无法识别、模型列表一直加载的问题；现在会使用 Codex / Claude Code 实际可用的模型。
- 修复部分 Windows 用户无法启动 Codex，并完善 Codex、Claude Code 常见安装路径识别。

### 🪟 聊天界面

- 优化窄屏下对话顶栏的压缩表现。
- 修复独立聊天窗口宽屏时右侧胶囊工具栏贴边被裁切。

### 🔐 登录诊断

- ChatGPT OAuth 本地回调启动失败时，会给出具体端口和底层错误，方便排查占用与环境问题。

### ✨ 灵光写作

- 写作辅助统一为「灵光写作」（Sparkle）；侧边栏入口与设置分区对齐，并精简低价值设置项。
