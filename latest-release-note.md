## 1.6.0.3 External Agent Access & Chat Reliability ✨

### 🤖 External Agent Integration

- YOLO now provides a local MCP server for external Agents, exposing Vault search and delegation to YOLO Agent tasks (#268).

### 💬 Chat & Quick Ask

- Interrupted model responses can now be resumed from the existing content by clicking “Continue generating” in the error message, without regenerating the entire response (#450).
- Reworked auto-follow in Chat and Quick Ask. Scrolling upward during a streaming response no longer pulls the view back to the bottom or causes scrollbar jitter; auto-follow pauses when you leave the bottom and resumes when you return.
- Math formulas now render live while responses are streaming. The `$` and `$$` output formats have also been unified for more stable display of complex formulas.
- Improved Quick Ask focus behavior: arrow keys work normally after returning to the editor, and typing `@` again returns to the existing panel without resetting the current draft or conversation.
- Fixed Skills selected from quick access being inserted in reverse order. They now follow the click order and are inserted at the current cursor position.
- Refined the conversation history dialog with separate “My Chats” and “Task Conversations” categories, along with smoother interaction behavior.

### 🎓 Learning & Interface

- Fixed Learning view tabs and related entry points still appearing in Chinese when Obsidian is set to English.
- Fixed the model selector being clipped when the window does not have enough available space.

---

## 1.6.0.3 外部 Agent 接入与对话可靠性 ✨

### 🤖 外部 Agent 接入

- YOLO 新增供外部 Agent 接入的本地 MCP 服务，可对外提供 Vault 搜索和 YOLO Agent 任务委派能力 (#268)。

### 💬 Chat 与 Quick Ask

- 模型回复中途断开时，现在可以点击错误提示中的“继续生成”，从已有内容处接着回答，无需重新生成整段回复 (#450)。
- 重构 Chat 与 Quick Ask 的自动跟随机制。模型流式回复时向上滚动不再被拉回底部，也不会出现滚动条抖动；离开底部后会暂停自动跟随，返回底部后自动恢复。
- 数学公式现在会在回复生成过程中实时渲染，并统一 `$` 与 `$$` 输出格式，使复杂公式的流式显示更加稳定。
- 优化 Quick Ask 焦点交互：返回编辑器后可正常使用方向键，再次输入 `@` 会回到现有面板，不再重置当前草稿或对话。
- 修复快捷入口 Skill 插入顺序颠倒的问题，现在会按照点击顺序插入到输入框当前光标位置。
- 优化历史记录弹窗，新增“我的对话”和“任务会话”分类，并改进整体交互逻辑。

### 🎓 学习与界面体验

- 修复英文环境下学习模式标签页及相关入口仍显示中文的问题。
- 修复模型选择下拉框在窗口空间不足时显示不全的问题。
