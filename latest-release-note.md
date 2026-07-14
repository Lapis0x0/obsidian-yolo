## 1.6.0.2 Chat Polish & Workflow Reliability 🛠️

### 💬 Chat & Navigation

- Redesigned desktop message navigation as a smooth waveform track on the left, with visible-turn indicators and hover previews for user messages and model responses. Also fixed older history failing to load automatically after switching to a conversation that was too short to scroll.
- Reworked the standalone Chat empty state with searchable, drag-and-drop quick access to frequently used Skills and snippets.
- Fixed content jumping when sending a new message, flashing history-loading indicators, and historical conversations occasionally opening to a blank screen after restart.
- Fixed the response footer appearing before the model had finished generating or running tools.

### 🤖 Agent & Input

- Agent terminal commands such as Git, curl, and npm now automatically follow the system proxy across platforms, including PAC routing, without requiring manual proxy environment variables (#460).
- Skills and snippets in the chat input menu now open submenus on hover like the reference menu, and redundant tooltips have been removed.
- Aligned the Ask and Agent options in the chat mode menu so both rows use consistent height and text positioning.
- Removed the risk confirmation shown the first time Agent mode is enabled.

### 🎓 Learning Experience

- Fixed flashcard review shortcuts remaining active after the Learning view lost focus, preventing accidental card flips or ratings while typing elsewhere.

---

## 1.6.0.2 对话体验与工作流可靠性 🛠️

### 💬 对话与导航

- 桌面端消息导航升级为流畅的左侧波形轨道，可直观看到当前可见的对话轮次，并在悬停时预览用户消息与模型回复。同时修复切换到内容过短、无法滚动的对话后，更早历史无法自动加载的问题。
- 重新设计独立 Chat 的空会话界面，新增可搜索、拖拽排序的常用 Skills 与快捷指令。
- 修复发送新消息时内容上下跳动、历史加载提示闪现，以及重启后打开历史对话偶尔白屏的问题。
- 修复模型仍在生成或执行工具时，底部信息栏提前出现的问题。

### 🤖 Agent 与输入体验

- Agent 终端中的 Git、curl、npm 等命令现在可跨平台自动遵循系统代理，并支持 PAC 分流，无需手动配置代理环境变量 (#460)。
- 聊天输入菜单中的 Skills 与快捷指令现在可像引用菜单一样悬停展开子菜单，并移除了多余的悬浮提示。
- 统一聊天模式菜单中 Ask 与 Agent 选项的高度和文字对齐。
- 移除首次启用 Agent 模式时的风险确认提示。

### 🎓 学习体验

- 修复学习界面失去焦点后卡片复习快捷键仍会响应的问题，切换到其他编辑区输入时不再误触发卡片翻面或评分。
