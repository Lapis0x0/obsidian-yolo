## 1.6.0 Learning Mode Public Beta ✨

### 🎓 Learning Mode

- Introducing the new **Learning Mode**: create a personalized learning project from a topic, current level, goals, and reference materials. YOLO can generate a structured outline, knowledge points, flashcards, and an interactive knowledge map.
- New flashcard learning workspace with card browsing, editing, drag-and-drop organization, batch management, and progress tracking.
- Built-in **FSRS spaced repetition** schedules reviews based on memory retention, with Again / Hard / Good / Easy ratings and daily review statistics.
- Import existing **Anki `.apkg` packages**, including deck structure, Basic / reversed / Cloze cards, images, audio, review history, and suspended cards.
- Learning Mode now supports a dedicated generation model shared by outlines, knowledge points, and flashcards.
- Exercise Mode and conversational learning experiences are planned for future updates.
- **Public beta notice**: Learning Mode is currently in public beta. Some features are still being refined and may be unstable or contain bugs. Some Learning Mode features may become part of paid plans in the future. Free users will still be able to use Learning Mode, but limits may apply to the number of learning projects they can create. Existing projects beyond the free allowance may become read-only, but they will not be deleted automatically.

### ⚡ Conversation Performance

- Improved typing performance in long conversations by avoiding repeated history and layout calculations while editing input (#420).
- Chat history now renders the latest 6 turns by default and keeps up to 12 turns while browsing older messages, preventing rendered content from growing indefinitely (#420).

### 💬 Chat, Quick Ask & Editor

- Unified the underlying input experience between Quick Ask and Chat, refreshed the Quick Ask layout, and updated its send button to match Chat's circular design.
- Table selections are now recognized by cell boundaries and converted into structured Markdown subtables before being sent to the model. The input area also shows the selected row and column count (#442).
- Model responses now follow Obsidian's interface font instead of the editor body font, preventing unsuitable typography under certain themes and Style Settings configurations. A CSS variable remains available for customization.
- Code blocks now provide Apply actions at both the top and bottom, so changes can be applied after reading long content without scrolling back up (#448) (#449). Thanks @Lapis0x1 for the contribution.
- Added support for **Max** reasoning strength.

### 🤖 Agent Improvements

- Reorganized built-in Agent tools: file writing now belongs to the file-editing group, while file operations focus on deleting, moving, and creating folders, making permissions and tool purposes clearer.
- Agent now detects repeated reads of the same file range. It warns the model first and automatically stops the run if identical reads continue, reducing loops and unnecessary token usage.
- Agent now understands its accessible workspace scope in advance. When an operation goes out of bounds, both the Agent response and tool details explain the rejection and guide users to adjust workspace settings or task scope.

### 📱 Mobile & Interface

- Improved mobile chat history actions so they no longer depend on desktop-only hover controls.
- Mobile text selection now consistently preserves the native system handles and menu, preventing selections from unexpectedly disappearing (#446).
- Fixed black borders appearing around dialogs, setting tabs, and option cards on Android.
- Fixed update dialogs occasionally showing only the version number without release notes. Release content is now retried when GitHub synchronization is delayed or the network is unstable.
- Fixed visual ghosting while scrolling YOLO Chat with Obsidian's translucent window mode enabled (#445).

---

## 1.6.0 学习模式公开测试 ✨

### 🎓 学习模式

- 新增全新的**学习模式**：可根据学习主题、当前水平、学习目标和参考资料创建个性化学习项目，由 YOLO 自动生成结构化大纲、知识点、闪卡和交互式知识地图。
- 新增闪卡学习工作区，支持浏览、编辑、拖拽整理、批量管理卡片，并可直观查看学习进度。
- 内置 **FSRS 间隔复习**，根据记忆保持率安排复习计划，支持“重来 / 困难 / 良好 / 简单”四档评分和每日复习统计。
- 支持导入已有的 **Anki `.apkg` 卡包**，可保留牌组章节结构、Basic / reversed / Cloze 卡片、图片、音频、复习历史和暂停状态。
- 学习模式可独立选择内容生成模型，并统一用于生成大纲、知识点和闪卡。
- 习题模式与对话式学习体验将在后续版本中陆续推出。
- **公开测试说明**：学习模式目前处于公开测试阶段，部分功能仍在持续完善，使用过程中可能出现不稳定或错误。未来，学习模式的部分功能将纳入付费方案。免费用户仍可继续使用，但可创建的学习项目数量等可能会受到限制。超出免费额度的已有项目可能转为只读，但不会被自动删除。

### ⚡ 对话性能

- 优化长对话输入性能，避免输入时重复计算历史消息和页面布局，在包含大量工具调用的对话中也能保持更加流畅的输入响应 (#420)。
- 聊天历史默认仅渲染最近 6 轮，翻阅历史时最多保留 12 轮，并修复持续聊天导致渲染内容不断累积的问题 (#420)。

### 💬 Chat、Quick Ask 与编辑体验

- 统一 Quick Ask 与 Chat 的底层输入体验，重新优化 Quick Ask 的布局，并将发送按钮统一为与 Chat 一致的圆形样式。
- 修复 Obsidian 表格选区无法正确同步到 Chat 的问题。插件现在会按表格单元格识别选区，将其转换为结构化 Markdown 子表发送给模型，并在输入框中显示选中的行列数量 (#442)。
- 模型回复正文现在默认跟随 Obsidian 界面字体，避免在部分主题或 Style Settings 配置下显示为不适合聊天界面的编辑器正文字体，同时保留 CSS 变量供自定义。
- 代码块现在会在顶部和内容末尾同时显示“应用”按钮，阅读长内容后无需返回顶部即可应用修改 (#448) (#449)。感谢 @Lapis0x1 的贡献。
- 新增支持 **Max** 推理强度。

### 🤖 Agent 优化

- 优化 Agent 内置工具分组：将“写入文件”归入文件编辑工作集；文件操作集现在专注于删除、移动和创建文件夹等路径操作，让工具权限和用途更加清晰。
- 增强 Agent 防循环能力：当模型反复使用相同参数读取同一文件范围时，会先提示模型调整策略；若仍继续重复读取则自动中断，减少无意义的循环与 token 消耗。
- Agent 现在会提前了解可访问的工作区范围。当文件操作超出范围时，Agent 回复和工具调用详情都会明确显示拒绝原因，并提示用户调整工作区设置或任务范围。

### 📱 移动端与界面

- 优化移动端聊天历史记录的操作体验，不再依赖需要悬停的桌面操作按钮，避免触控交互与桌面入口互相干扰。
- 修复移动端选中文字时系统选区手柄和菜单可能突然消失的问题，现在始终保留系统原生选区体验 (#446)。
- 修复安卓端弹窗、设置页顶部 Tab 和选项卡片边框异常显示为黑色的问题。
- 修复新版本弹窗偶尔只显示版本号、没有更新内容的问题。当 GitHub 更新说明短暂未同步或网络不稳定时，现在会自动重试获取。
- 修复开启 Obsidian 半透明窗口后，YOLO Chat 滚动时可能出现内容重影的问题 (#445)。
