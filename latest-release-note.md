## 1.6.4.1 Polish & Sparkle Writing ✨

### 🪟 Narrow Chat Header

- Improved the chat top bar layout when the sidebar is compressed on narrow screens.

### 🧭 CLI Runtime Menus

- Codex and Claude Code selection menus now expand on hover, matching the CLI/Agent interaction pattern.

### 🤖 CLI Model Selection

- Fixed third-party provider models not being recognized in CLI Agent, which left the model list loading forever. YOLO now uses the models actually available to Codex or Claude Code.

### 🪟 Windows Codex Launch

- Fixed Codex CLI Agent failing to start for some Windows users, and improved auto-detection of common Codex and Claude Code install paths.

### 🔐 ChatGPT OAuth Errors

- When the local ChatGPT OAuth callback server fails to start, YOLO now shows the specific port and underlying error so port conflicts and environment issues are easier to diagnose.

### 🪟 Floating Chat Toolbar

- Fixed the right capsule toolbar in the standalone chat window getting clipped against the window edge on wide screens.

### ✨ Sparkle Writing

- Writing assistance is now branded as Sparkle (灵光写作). The sidebar entry and settings section are aligned, and less useful options have been trimmed to reduce noise.

---

## 1.6.4.1 体验打磨与灵光写作 ✨

### 🪟 窄屏对话顶栏

- 优化对话顶部栏在窄屏压缩时的样式表现。

### 🧭 CLI 运行时菜单

- Codex 与 Claude Code 的选择菜单现可在悬停时直接展开，交互方式与 CLI/Agent 保持一致。

### 🤖 CLI 模型选择

- 修复第三方 Provider 模型在 CLI Agent 中无法识别、模型列表持续加载的问题。现在 YOLO 会自动使用 Codex 或 Claude Code 实际可用的模型。

### 🪟 Windows Codex 启动

- 修复部分 Windows 用户无法启动 Codex CLI Agent 的问题，并完善 Codex、Claude Code 常见安装路径的自动识别。

### 🔐 ChatGPT OAuth 报错

- ChatGPT OAuth 本地回调服务启动失败时，现在会显示具体端口及底层错误原因，帮助快速定位端口占用或运行环境问题。

### 🪟 独立聊天工具栏

- 修复独立聊天窗口在宽屏状态下，右侧胶囊工具栏紧贴窗口边缘并被裁切的问题。

### ✨ 灵光写作

- 写作辅助能力统一命名为「灵光写作」（Sparkle），侧边栏入口与设置分区同步更新，并精简设置项以降低认知成本。
