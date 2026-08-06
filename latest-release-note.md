## 1.6.4.5 Web Search, Quoting & Chat Refinements ✨

- Added Exa as a web search provider.
- Agent and CLI conversations now share one presentation layer, so both modes render turns, tools and errors consistently. (#550)
- CLI conversations now show up in the process monitor at the bottom right, making background runs visible and controllable.
- You can now click the Agent/CLI mode area to switch conversation modes directly.
- Reworked quoting on assistant replies: the quote button appears only once a selection is complete, so it no longer interrupts continuous selection. Plain quotes are kept after the annotation box is closed, and you can right-click a quote marker to remove it.
- Reasoning sections now report how long the model thought once thinking ends.
- Failed requests are now recognised and classified more precisely, so provider and configuration problems are easier to act on.
- Tab completion can now replace the text matched by its trigger. (#552)
- Synced the latest OpenRouter model capability data.
- Fixed the first user message bubble not being clickable for editing.
- Fixed Codex CLI auto-generated conversation titles not syncing back to the native session.
- Fixed history panel entries jittering while several conversations were running; deleting a history entry now asks for confirmation.

---

## 1.6.4.5 联网搜索、引用与聊天体验改进 ✨

- 新增 Exa 联网搜索 Provider。
- Agent 与 CLI 对话统一到同一套呈现层，两种模式下的回合、工具调用与报错展示保持一致。（#550）
- CLI 对话接入右下角的进程监控，后台运行的会话可见、可控。
- 支持点击 Agent/CLI 模式区域，快速切换对话模式。
- 优化助手回答的文本引用操作：引用按钮仅在完成选择后出现，避免干扰连续选取；纯引用在关闭批注框后会保留，并支持右键批注浮标快速删除。
- 思考结束后会显示本轮思考耗时。
- 优化请求失败的识别与分类机制，供应商与配置问题更容易定位和处理。
- Tab 补全支持替换触发器匹配的文本。（#552）
- 同步最新的 OpenRouter 模型能力信息。
- 修复首条用户消息气泡无法点击编辑的问题。
- 修复 Codex CLI 对话自动命名无法同步到原生会话的问题。
- 修复多个对话同时运行时历史面板条目抖动的问题；删除历史记录现在需要二次确认。
