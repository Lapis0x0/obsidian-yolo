## 1.6.4.4 Chat, Skills & Reliability Improvements ✨

- Improved error messages for failed model requests, making provider and configuration issues easier to understand.
- Skills are no longer forcibly moved or renamed into directory packages during startup or import. You can now use Markdown skills under their original filenames, or import complete Claude Code and Codex-style skill packages without changing their structure. (#543)
- Fixed CLI conversations not scrolling to the new turn when sending a message while away from the bottom of the page.
- Added a chat input shortcut preference: you can now use Enter for a new line and Cmd/Ctrl + Enter to send.
- Added multi-selection quotes to regular Chat and CLI responses, with support for adding, editing, and removing annotations on individual excerpts.
- Fixed the mobile keyboard unexpectedly closing when returning to a note and selecting text after opening sidebar chat.
- Refined the visual design of scroll previews for collapsed reasoning sections.
- Improved the layout of the multi-turn message navigation indicator across standalone and sidebar chat views.
- Fixed Smart Space opening unexpectedly for abbreviations containing a slash, such as “w/ ”. “/ + Space” now triggers only at the start of a line or after whitespace. (#541, #542)

---

## 1.6.4.4 聊天、Skills 与可靠性改进 ✨

- 改进模型请求失败时的错误提示，让供应商与配置问题更容易理解和排查。
- Skills 不再在启动或导入时被强制移动、重命名为目录包。现在既可直接使用保留原文件名的 Markdown 技能，也可原样导入 Claude Code、Codex 风格的完整技能包。（#543）
- 修复 CLI 对话未处于页面底部时，发送消息不会自动滚动到新回合的问题。
- 新增聊天输入快捷键偏好：现在可以选择使用 Enter 换行，并通过 Cmd/Ctrl + Enter 发送消息。
- 为普通 Chat 与 CLI 回复增加多选引用能力，支持为不同片段添加、编辑和删除批注。
- 修复手机端打开侧栏聊天后，返回笔记选择文本会意外收起软键盘的问题。
- 优化折叠态思考过程滚动预览的样式设计。
- 优化多轮对话消息导航指示器在独立窗口与侧边栏中的布局样式。
- 修复输入 “w/ ” 等含斜杠缩写时误唤出 Smart Space 的问题。“/ + 空格”现在仅在行首或空白符后触发。（#541、#542）
