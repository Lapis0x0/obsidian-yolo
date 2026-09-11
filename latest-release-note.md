## 1.6.9.1 Max Mode Polish ✨

### Agent & tools

- Filled in vector retrieval for vault search in Max, and unified the search tools across the Ask/Agent/Max chat modes.
- Fixed edits being lost when Max mode ran parallel edit_file calls on the same file. (#594)
- Optimized the architecture design, unifying the programmatic entry point for calling the Agent.

### Prompts

- Global/Agent system prompts now support the ![[note]] syntax to embed constraints from other documents.
- Improved the prompt design for the model proactively suggesting a switch between Ask/Agent/Max capabilities.

### Chat & interface

- Right-click the YOLO ribbon icon to choose whether to open Chat in the sidebar, a tab, a split, or a separate window.
- Added Max mode to the mode list in the @ menu.
- Improved the styling and animation design of collapsed tool groups.

---

## 1.6.9.1 Max 模式打磨 ✨

### Agent 与工具

- 补全 Max 的 vault search 向量检索的能力，并统一 Ask/Agent/Max 三种对话模式的检索工具。
- 修复 Max 模式并行 edit_file 同一文件丢失编辑的问题。（#594）
- 优化架构设计，统一 Agent 程序化调用入口。

### 提示词

- 系统全局/Agent提示词支持 ![[笔记]] 语法来嵌入其他文档的约束。
- 优化模型主动建议 Ask/Agent/Max 能力切换的提示词设计。

### 对话与界面

- 右键侧边栏 YOLO 图标可选择在侧边栏、标签页、分屏或独立窗口打开 Chat。
- 为 @ 菜单的模式列表补齐 Max 模式。
- 优化工具折叠组的样式与动画设计。
