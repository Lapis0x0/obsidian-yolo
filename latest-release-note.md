## 1.5.13 Agent Chat Performance ✨

### ⚡ Agent Performance (#420)

- Improved streaming refresh performance during long conversations, reducing UI re-render pressure when models output quickly.
- Fixed memory growth after heavy Subagent use: completed task execution history could be duplicated and kept accumulating.
- Smoother typing in long sessions by cutting unnecessary re-renders of the history area and input editor.
- Fixed Agent runtime state lingering in memory after deleting long conversations.
- Faster timeline rendering for long chats and Agent streaming: history now uses a more stable row-level layout, with less churn on older messages while a reply is generating; Chat and Quick Ask history paths are also improved for input, retry, branching, and tool results.

### 🚀 Startup

- Reduced initialization work at plugin startup (#425).

### ✨ Experience Improvements

- Removed misleading skill-read prompts when all Skills are disabled, so the model is no longer nudged to read non-existent skill paths.
- Improved Tab completion context so the model better understands cursor position and surrounding text; more leading context is kept so suggestions fit headings, paragraphs, and prior context more naturally.
- Removed the empty-state card shadow that showed as clipped gray edges on narrow mobile screens (#430).
- Fixed some OpenAI-compatible models rejecting plain-text-only messages: text-only requests now fall back to a more compatible legacy string format without affecting image or PDF inputs.
- Better Obsidian pop-out window behavior: fixed the Agent settings dropdown and opening chat in a right split incorrectly jumping back to the main window (#432) (#434).

---

## 1.5.13 Agent 对话性能优化 ✨

### ⚡ Agent 性能 (#420)

- 优化长对话生成期间的流式刷新性能，减少快速模型输出时的界面重渲压力。
- 修复长时间使用 Agent 并频繁派遣 Subagent 后，已完成任务的执行历史可能被重复保留、导致内存持续增长的问题。
- 优化长对话中的输入体验，减少输入时历史消息区和编辑器组件的无意义重渲，缓解长会话下输入框卡顿。
- 修复删除长对话后部分 Agent 运行时状态仍留在内存中的问题，降低长期使用后的内存累积风险。
- 优化长对话和 Agent 流式回复时的时间线渲染：历史消息以更稳定的行级结构展示，减少当前回复生成时对旧消息列表的无意义刷新；同时改进 Chat 与 Quick Ask 的历史消息渲染路径，降低长会话中输入、重试、分支和工具结果展示时的卡顿风险。

### 🚀 启动优化

- 优化插件启动时的初始化工作，减少启动阶段的加载开销 (#425)。

### ✨ 体验改进

- 移除无技能场景下的技能读取误导提示，避免关闭全部 Skills 后模型仍被提示尝试读取不存在的 skill path。
- 优化 Tab 补全的上下文设计，让模型更明确地理解光标位置与前后文关系；保留更完整的光标前内容，使补全结果更容易贴合标题、段落结构和前文语境。
- 移除聊天空状态卡片的阴影样式，修复移动端窄屏下左右被裁切成灰边的视觉问题 (#430)。
- 修复部分 OpenAI-compatible 模型无法处理纯文本消息的问题：纯文本请求会自动使用兼容性更好的旧式字符串格式，同时不影响图片和 PDF 等多模态输入。
- 改进 Obsidian 弹出窗口兼容性：修复 Agent 设置下拉菜单和右侧分屏打开聊天时错误回到主窗口的问题 (#432) (#434)。
