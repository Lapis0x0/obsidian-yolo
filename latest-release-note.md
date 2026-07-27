## 1.6.2 Leaner Core, Editable Reviews & Better Multi-Window Support 🚀

### 📦 Leaner, More Reliable Runtime

- PDF processing, tokenization, and the knowledge base engine are now downloaded only when needed, substantially reducing the core plugin size. Runtime components and knowledge base indexing now retry temporary failures up to three times, then wait for a manual retry instead of making endless background requests. (#447)
- Agent tasks and streaming responses now continue smoothly when an Obsidian window moves to the background, avoiding stalled work or delayed bursts of output.

### ✍️ Editable Inline Diff Review

- Diff review is now consistently presented as an editable inline experience: you can directly revise both the original text and AI suggestions before deciding what to accept.
- Review direction and accept/reject semantics now remain correct across repeated revisions. Rejected edits are also reported back to the Agent so it no longer mistakes them for applied changes.
- The review action bar now fits split panes and narrow windows, stays clear of content, scrollbars, and Obsidian's status bar, and has more consistent hover styling.

### 🪟 Multi-Window Editing

- Text selected in either the main window or a pop-out window can now be added to chat context. Insert/replace actions also target the most recently active Markdown view, preventing content from being written into the wrong page. (#488, #490, #492, #493)
- Thanks to @pjeby for reporting these multi-window issues and for the detailed code review and suggested fix for #490.

### 🤖 More Reliable Agent Tools

- File reading now uses a simpler parameter structure, reducing failed tool calls caused by nested arguments, and PDF pagination now respects the requested page count.
- File editing provides clearer parameter-error guidance, helping models recover without incorrectly treating `oldText` as required.
- The Agent better recognizes selected text and existing context, avoiding unnecessary rereads of identical or overlapping file ranges.

### 💬 Refined Chat Experience

- Fixed todo lists and queued messages covering badge-style attachments. Expanded todo content now grows upward while the bottom status bar stays fixed, and adding the first reference badge no longer replays the input layout animation. Badges and todo lists also have a refreshed visual design. (#489)
- Tab Completion can now generate multiple context-aware suggestions at once.
- Switching reasoning effort no longer causes spacing between the input and quick commands to jump.

### ⚙️ Cleaner Configuration

- Optional model parameters such as Temperature and Top P now live in a unified collapsible section, keeping everyday setup focused while preserving full provider-parameter overrides.
- MCP servers can now be configured through either a guided form or raw JSON, making local and remote server setup more approachable. (#496)

---

## 1.6.2 更轻量的核心、可编辑审阅与更完善的多窗口支持 🚀

### 📦 更轻量、更可靠的运行组件

- PDF、分词器和知识库引擎现在仅在需要时下载，大幅减少插件核心体积。运行组件与知识库索引遇到暂时性错误时最多自动重试三次，达到上限后会等待手动重试，不再持续发起后台请求。（#447）
- 修复 Obsidian 窗口进入后台后 Agent 任务与流式响应可能停滞或集中显示的问题，后台任务现在能够持续顺畅运行。

### ✍️ 可编辑的内联差异审阅

- 差异审阅现已统一为可编辑的内联体验，可在接受或拒绝前直接修改原文与 AI 建议。
- 修正重复审阅时差异方向以及接受、拒绝语义颠倒的问题；Agent 现在也能获知用户否决的修改，不再将其误判为已成功应用。
- 审阅操作栏现在会适应分栏和窄窗口，避开正文、滚动条与 Obsidian 底部状态栏，并修复按钮悬停样式异常。

### 🪟 多窗口编辑

- 主窗口和弹出窗口中的文本选区现在都能加入聊天上下文；“插入/替换光标处”也会准确写入最近激活的 Markdown 页面，不再误写到其他页面。（#488、#490、#492、#493）
- 感谢 @pjeby 报告以上多窗口问题，并为 #490 提供细致的代码审查和修复方案建议。

### 🤖 更可靠的 Agent 工具

- 简化文件读取工具的参数结构，减少模型因参数嵌套导致的调用失败；PDF 分页读取现在也会正确遵循指定的读取页数。
- 优化文件编辑工具的参数错误提示，避免模型误判 `oldText` 为必填参数，提高编辑调用的自纠正能力。
- Agent 现在能更准确地识别用户选区与已有上下文，减少对相同或重叠文件范围的不必要重复读取。

### 💬 更精致的聊天体验

- 修复任务清单或排队消息遮挡徽章形式附件的问题。任务清单展开时内容会向上显示并保持底部状态栏固定，首次添加引用徽章时也不再重复播放输入框布局动画；Badge 与任务清单的视觉样式同步焕新。（#489）
- Tab 补全现在可一次生成多条上下文自适应的候选建议。
- 修复切换推理强度时输入框与快捷指令间距跳动的问题。

### ⚙️ 更清爽的配置体验

- Temperature、Top P 等模型可选参数现已统一收纳为折叠配置，减少低频选项对日常设置的干扰，同时保留完整的 Provider 参数覆盖能力。
- MCP 服务器新增表单与 JSON 双模式配置，可通过更直观的字段添加本地或远程服务。（#496）
