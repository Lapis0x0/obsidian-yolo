## 1.6.0.1 Learning Experience & Agent Reliability 🛠️

### 🎓 Learning Improvements

- Learning plans now support pause, resume, and delete actions through right-click or long press. Pausing freezes the entire review schedule, so resuming does not create an extra overdue backlog.
- Fixed Learning Mode to respect the custom YOLO folder. Existing review records and Anki import data are safely migrated to the configured directory, with leftover empty folders cleaned up automatically.
- The status bar now shows today's due card count and updates in real time as reviews are completed.
- Refined the Learning Center layout so the scrollbar reaches the right edge, and aligned the top badge count with the current learning queue.
- Review rating buttons now use compact localized time units, preventing wrapped labels and inconsistent button heights on mobile.

### 🤖 Agent Accuracy

- Agent now determines file editing, path operations, and terminal capabilities from its actual tool configuration, reducing invented tool calls and incorrect claims that an operation was completed.
- Fixed Agent tool counts to exclude disabled MCP tools and unavailable tools, keeping the total consistent with the Agent configuration page.

### 💬 Chat & Providers

- Thinking traces now open without an expansion animation, reducing CPU usage and interface lag when viewing very long reasoning content (#420).
- Message navigation now remains available in narrow sidebars (#453) (#454). Thanks to @Lapis0x1 for the contribution.
- Removed the discontinued Qwen OAuth login option so unavailable sign-in methods are no longer shown (#456).

---

## 1.6.0.1 学习体验与 Agent 可靠性 🛠️

### 🎓 学习体验优化

- 学习计划现已支持通过右键或长按进行暂停、恢复和删除。暂停期间会冻结整个计划的复习进度，恢复后不会产生额外的逾期积压。
- 修复学习模式未遵循自定义 YOLO 文件夹的问题。已有复习记录和 Anki 导入数据会安全迁移至用户设置的目录，并自动清理遗留的空文件夹。
- 右下角状态栏现在会显示今日待复习卡片数量，并随复习进度实时更新。
- 优化学习中心页面布局，使滚动条贴合视图右侧边缘；同时统一顶部徽标与当前学习队列的卡片数量。
- 复习评分按钮改用更紧凑的多语言时间单位，避免移动端因文案换行导致按钮高度不一致。

### 🤖 Agent 准确性

- AI 现在会根据当前 Agent 的实际工具配置准确判断文件编辑、路径操作和终端能力，减少虚构工具调用或错误声称操作已完成的情况。
- 修复 Agent 工具数量显示不准确的问题。停用的 MCP 和失效工具不再计入，工具数量现在与 Agent 配置页保持一致。

### 💬 对话与服务渠道

- 取消思考记录的展开动画，降低打开超长思考内容时的 CPU 压力和界面卡顿 (#420)。
- 支持在窄侧栏中使用消息导航 (#453) (#454)，感谢 @Lapis0x1 的贡献。
- 移除已停止服务的 Qwen OAuth 登录渠道，避免继续展示不可用选项 (#456)。
