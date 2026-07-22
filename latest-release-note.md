## 1.6.1 Modular Architecture Overhaul 🧩

### 🧩 Modular Architecture

- **A new module foundation**: YOLO Core now provides a versioned module runtime and Host API, allowing large optional capabilities to be installed, enabled, and released independently without being bundled into the main plugin.
- **Learning is now an independent module**: Learning mode has been fully separated from Core while preserving its complete experience. Existing Learning users are migrated automatically with their settings, projects, cards, and review progress intact; users who have never used Learning will not install it automatically.
- **Secure and recoverable delivery**: Official module releases now use compatibility checks, immutable artifacts, SHA-256 verification, isolated storage, and recoverable version switching across desktop and mobile.
- **Unified management and updates**: Modules can be installed, enabled, disabled, updated, or removed from the new module settings page without restarting YOLO. Core and module updates now share the same notification, release history, and automatic download preference, while installation still requires user confirmation.

### ✨ Experience & Feature Improvements

- YOLO now uses the new Orbit entry icon and supports themes such as Border that display icons in new tabs. Sidebar labels for Chat and Learning mode have also been refined.
- Fixed Learning generation unexpectedly following the old default Chinese prompt, and completed missing English, Chinese, and Italian interface translations. Thanks @RazonIn4K (#464).
- Fixed Skills import and other features breaking when the YOLO root directory was hidden. Hidden root directories are now disallowed, existing configurations migrate automatically, and invalid paths are reported immediately in Settings (#469).
- Improved YOLO root directory relocation so Skills, snippets, Learning data, and all other managed content move together. If the destination already contains files, YOLO now warns and stops before overwriting anything.
- Fixed the Chat view occasionally turning blank when reopening the editor for a historical user message (#475).
- Fixed automatic conversation titles failing with some models or compatible APIs. Title generation now follows each provider's default reasoning behavior instead of sending unsupported reasoning-disable parameters (#476).
- Reduced the conversation navigator threshold from seven user messages to three, making navigation available earlier in a conversation (#477).

---

## 1.6.1 架构模块化改造 🧩

### 🧩 模块化架构

- **全新模块底座**：YOLO Core 现在提供带版本的模块运行时与 Host API，大型可选能力可以独立安装、启用和发布，不再必须打包进主插件。
- **Learning 成为独立模块**：学习模式已完整从 Core 中拆分，同时保留全部学习体验。已使用学习模式的用户会自动迁移，原有设置、学习项目、卡片和复习进度都会完整保留；从未使用过学习模式的用户不会被自动安装。
- **安全且可恢复的交付机制**：官方模块现在具备兼容性检查、不可变制品、SHA-256 完整性验证、隔离存储与可恢复版本切换，并同时支持桌面端和移动端。
- **统一的管理与更新体验**：可以在新的模块设置页中安装、启用、停用、更新或卸载模块，无需重启 YOLO。Core 与模块更新现在共用同一套提示、历史记录和自动下载设置，实际安装仍需用户确认。

### ✨ 体验优化与功能改进

- YOLO 现已采用全新的 Orbit 入口图标，并兼容 Border 等使用图标式新标签页的主题。同时优化 Chat 与学习模式的侧边栏提示文案。
- 修复学习模式因旧默认中文 prompt 导致生成语言异常的问题，并补全英文、中文及意大利语界面的缺失翻译。感谢 @RazonIn4K (#464)。
- 修复隐藏 YOLO 根目录导致 Skills 导入等功能失效的问题。现在禁止隐藏 YOLO 根目录，升级后会自动迁移旧配置，并在设置中即时提示无效路径 (#469)。
- 优化 YOLO 根目录的整体迁移逻辑。修改根目录时，Skills、snippets、Learning 等所有受管内容都会一起迁移；如果目标目录已有文件，YOLO 会先提醒并停止，避免意外覆盖数据。
- 修复再次点击历史用户消息编辑框时，Chat 页面可能变为空白的问题 (#475)。
- 修复部分模型或兼容接口无法自动生成对话标题的问题。对话命名现在遵循模型服务商的默认推理行为，避免因不支持的关闭推理参数导致请求失败 (#476)。
- 将对话导航器的最小用户消息数从 7 条降低到 3 条，让导航功能更早出现 (#477)。
