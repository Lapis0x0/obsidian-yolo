## 1.6.4.2 Stability Hotfix 🛠️

- Fixed the chat view going blank when a Codex or Claude Code session fails to initialize. YOLO now shows the underlying error directly, making CLI, authentication, and third-party provider issues easier to diagnose.
- Fixed ChatGPT OAuth failing to start its local callback server with a permission error on some Windows systems, and improved automatic callback port cleanup.
- Fixed YOLO failing to load on Android after upgrading to 1.6.4.1.

---

## 1.6.4.2 稳定性热修复 🛠️

- 修复 Codex 或 Claude Code 会话初始化失败时聊天界面黑屏的问题；现在会直接显示真实错误原因，方便排查 CLI、认证或第三方 Provider 配置。
- 修复部分 Windows 环境下 ChatGPT OAuth 登录因本地回调服务器权限错误而无法启动的问题，并完善回调端口的自动释放。
- 修复 Android 端升级至 1.6.4.1 后无法启用 YOLO 的问题。
