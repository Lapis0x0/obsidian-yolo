# Feature Map

目录职责和模块边界已经由 `AGENTS.md` 承担，这里不重复。它的作用是让「产品行为 ↔ 代码位置 ↔ 怎么验证」这条映射可以直接查到，而不用每次接到涉及某个产品面的任务都从头 grep 摸索。下面每条记录都写清楚：这个行为在哪触发、真正实现它的文件是哪些（对照当前代码树核实过，不是靠命名猜的）、改动之后怎么验证。把它当索引用，不是教程：一旦发现和代码对不上，以代码为准，并顺手把这份文档改对。

## Chat surfaces

下面两个入口（Quick Ask、Chat 视图）的 Ask/Agent 模式都通过 `AgentService.run` (`src/core/agent/service.ts`) 派发；每次调用拿到的运行时权限由 `resolveChatModeRuntime` 计算 (`src/components/chat-view/chat-runtime-profiles.ts`，被 `src/core/agent/tool-gateway.ts` 消费)。Quick Ask 另外还有第三档模式（续写），完全不走 `AgentService`——见下方对应条目。

### Quick Ask
- 触发方式：编辑器内快捷键/命令唤起的浮层，由 `QuickAskController`（`src/features/editor/quick-ask/quickAskController.ts`）在 `src/main.ts` 中挂载。面板本体 `src/components/panels/quick-ask/QuickAskPanel.tsx` 有三档模式（`QuickAskVisibleMode = 'ask' | 'agent' | 'continue'`，`src/features/editor/quick-ask/quickAsk.types.ts`）：Ask/Agent 两档走 `AgentService.run`；「续写」档不走 agent runtime，而是通过 `plugin.continueWriting()` 调用下面「灵光写作 / Sparkle」一节的 `ContinuationController`。三档是同一面板内切换，不是三个独立入口。
- 核心代码：`src/features/editor/quick-ask/`（唤起、锚点定位、生命周期）+ UI 在 `QuickAskPanel.tsx`、`QuickAskWidget.tsx`。
- 依赖子系统：Ask/Agent 档走 `AgentService`（`plugin.getAgentService()`）+ `assistantRenderStreamStore`（流式渲染，见下）；续写档走 `ContinuationController`（`src/features/editor/continuation/continuationController.ts`）→ `executeSingleTurn`（`src/core/ai/single-turn.ts`）。
- 验证路径：dev vault 手测，在任意笔记编辑器内分别触发 Quick Ask 的 Ask/Agent/续写三档。

### Chat 视图（侧边栏 / 标签页 / 分屏 / 独立窗口）
- 触发方式：只有一个视图类型 `CHAT_VIEW_TYPE`（`src/ChatView.tsx`，挂载 `src/components/chat-view/Chat.tsx`），通过 `plugin.openChatView({ placement })` 打开到四种 Obsidian leaf 位置之一——`ChatLeafPlacement = 'sidebar' | 'split' | 'tab' | 'window'`（`src/features/chat/chatLeafSessionManager.ts`）。对应四个命令：`open-new-chat`（侧栏）、`open-chat-tab`、`open-chat-split`、`open-chat-window`（`src/main.ts`），实际打开/复用/新建 leaf 的逻辑在 `ChatViewNavigator`（`src/features/chat/chatViewNavigator.ts`）。四种挂载位置是同一份功能，不是四个不同的产品面；`ChatMode` 不是挂载位置的一部分，是下面这条正交的能力轴。
- 核心代码：`src/components/chat-view/`（`ChatSessionController.ts` 管理会话状态与 `AgentService` 订阅、`ChatConversationPane.tsx`/`ChatTimelineList.tsx` 渲染时间线）。
- 依赖子系统：任一挂载位置内部都叠加同一层 `ChatMode`（`'ask' | 'agent' | ModuleChatModeId`，定义于 `ChatModeSelect.tsx`）切换出的能力集——Ask 模式屏蔽写文件/vault shell/终端/todo 等能力（`CHAT_BLOCKED_CAPABILITY_IDS`，`chat-runtime-profiles.ts`）；`AgentService`、`resolveChatModeRuntime`、模块自定义聊天模式（`RegisteredModuleChatModeV1`，见「模块系统」）都接入同一个 `ChatMode` 类型体系。挂载到独立窗口（`placement: 'window'`）时叠加下方「Popout / 多窗口」一节的约束。
- 验证路径：dev vault 手测——四种 placement 各自打开/复用 leaf 是否正确（`chatViewNavigator.test.ts` 覆盖对应状态机），以及任一 placement 下 Ask/Agent 两种 ChatMode 的能力屏蔽是否符合预期（`ChatSessionController.test.ts`）。

### Streaming 渲染约束（跨 Ask/Agent 模式的所有入口）
- 生成中的内容/推理不进会话快照，活在 `assistantRenderStreamStore`（`src/core/agent/assistantRenderStreamStore.ts`）里；快照只在语义边界折叠回去。改流式渲染前务必先读这个文件，不要引入逐 token 发布会话快照的路径。

## 灵光写作 / Sparkle（单轮编辑器功能族）
- 产品命名注记：这条线在设置页/侧边栏统一品牌为「灵光写作 / Sparkle」（`fdcc10ff`），代码里没有与之对应的统一目录——`src/features/editor/` 下 Tab 补全、选区改写、续写是并列的兄弟目录，只是共用同一条底层执行路径。不要再用「Write Assist」指代这整条产品线，那是改名前遗留的说法；`continuation` 现在专指续写这一个子能力（见下）。
- 触发方式：笔记内联的低延迟单轮生成，三个触发点共享同一条实现：Tab 补全（`tab-completion`）、选区改写（`selection-rewrite`）、续写（`continuation`，被 Quick Ask 的「续写」档通过 `plugin.continueWriting()` 调用，见上「Quick Ask」条目）。
- 核心代码：共同的执行路径是 `executeSingleTurn`（`src/core/ai/single-turn.ts`，709 行）。三个调用方：`src/features/editor/tab-completion/tabCompletionController.ts`、`src/features/editor/selection-rewrite/selectionRewriteController.ts`、`src/features/editor/continuation/continuationController.ts`（`ContinuationController`，仅被 `QuickAskPanel.tsx` 续写档调用，不直接被其他 UI 使用）。
- 依赖子系统：**不接入** `AgentService` 或 agent 编排——这是一条独立的单轮路径，改动时不要把它并入 agent runtime，也不要给它加工具循环。改 `single-turn.ts` 时要意识到三个调用方都会受影响。
- 验证路径：dev vault 手测，分别触发 Tab 补全、选区改写、Quick Ask 续写档，确认响应延迟和不经过 Agent 权限体系。

## 工具系统
- 核心代码：`src/core/tools/`。`capabilities/`（`file-editing.ts`、`file-reading.ts`、`vault-shell.ts`、`terminal.ts`、`todo-list.ts`、`memory.ts`、`web-access.ts`、`js-sandbox.ts`、`subagent-delegation.ts`、`user-questions.ts`、`context-compaction.ts`、`context-pruning.ts`）是唯一注册点——工具目录、设置项、审批策略、持久化 key 都从这里派生，不要另开侧表。`dispatcher.ts`（43 行）是唯一执行路径。
- 具体工具实现目录：`bash/`、`fs_edit/`、`fs_read/`、`fs_write/`、`terminal_command/`、`todo_write/`、`web_search/`、`web_scrape/`、`js_eval/`、`ask_user_question/`、`memory_add/update/delete/`、`delegate_subagent/`、`context_compact/`、`context_prune_tool_results/`。
- 验证路径：`dispatcher.test.ts`、`registry.test.ts`、`tool-catalog-equivalence.test.ts` 覆盖分发与目录一致性；单个工具改动看对应目录下的 `*.test.ts`。

## MCP
- 核心代码：`src/core/mcp/`——`mcpManager.ts`/`mcpCoordinator.ts`（生命周期与协调）、`desktopLocalMcpServer.ts`/`inProcessToolServer.ts`（本地/进程内 server）、`mcpOAuth*.ts`（OAuth 流程）、`localFileTools.ts`（vault 文件工具作为本地 MCP server 暴露）、`jsSandboxTool.ts`。
- 验证路径：目录内测试覆盖率很高（几乎每个源文件都有对应 `*.test.ts`），改动先看同名测试；`mcpManager.selfHeal.test.ts` 专门覆盖自愈重连路径。

## RAG / 检索 / 多知识库
- 核心代码：`src/core/rag/`——`ragEngine.ts`/`ragCoordinator.ts`（索引与查询编排）、`ragIndexService.ts`（增量索引）、`ragAutoUpdateService.ts`（自动更新）、`knowledgeBaseCatalog.ts`（多知识库目录）、`embedding.ts`、`local-embedding/`（本地嵌入，运行时组件化，见下）、`reconciler.ts`。
- 向量库：`src/database/vector-store/`，IndexedDB 后端，`vectorDatabase.ts` 持有 `VECTOR_DATABASE_VERSION`——schema v1 是 final，改 schema 必须 bump 版本号并在该文件加升级路径，不能原地改字段语义。
- 验证路径：`ragEngine.test.ts`、`ragCoordinator.test.ts`、`IndexedDbVectorStore.test.ts`、`vectorDatabase.test.ts` 等；本地嵌入模型改动额外看 `runtime-components/embedding-engine/`（下方「运行时组件」）。

## Skills
- 核心代码：`src/core/skills/`——`builtinSkills.ts`（内置 skill 目录，`builtin/` 子目录存放具体 skill）、`githubSkillImporter.ts`（从 GitHub 导入）、`skillPolicy.ts`（启用策略）、`skillValidation.ts`、`liteSkills.ts`。
- 依赖子系统：模块也可以打包 skill（见下「模块系统」中的 skill 投影机制），二者共用同一份 vault skill 语义，但注册入口不同。
- 验证路径：对应 `*.test.ts`，导入类改动重点看 `githubSkillImporter.test.ts`、`skillImportLimits.test.ts`。

## 模块系统
- 核心代码：`src/core/modules/`，覆盖发现（`officialModuleCatalog.ts`/`devModuleCatalogSource.ts`）、安装（`moduleInstallationCoordinator.ts`/`moduleArtifactInstaller.ts`/`moduleArtifactVerifier.ts`）、加载（`moduleLoader.ts`/`moduleRuntime.tsx`）、激活（`moduleActivationCoordinator.ts`）、生命周期（`lifecycleScope.ts`/`moduleStartupReconciler.ts`）、Host API 暴露（`hostCapabilities.ts`）。`modules/host-sdk.d.ts`（仓库根 `modules/` 目录下）是模块可见的 API 契约，模块不能越过它 import `src/core/`。
- 已知第一方模块：`modules/learning/`（完整实现：`src/domain/`、`src/generation/`、`src/host/`、`src/ui/`、`src/anki/`）——学习模式的产品逻辑全部在这里，host 侧只负责通用的模块生命周期。
- 模块自定义聊天模式：`moduleChatModeRegistry.ts`，产出 `RegisteredModuleChatModeV1`，接入前述 `ChatMode` 类型体系（`src/components/chat-view/chat-input/ChatModeSelect.tsx` 里的 `ModuleChatModeId`）。
- 模块 skill 投影：`moduleSkillMaterializer.ts`——声明的 skill 包在激活时物化到 `<YOLO base>/modules/<moduleId>/skills/<package>/`，之后按普通 vault skill 走，没有单独的协议层。
- 验证路径：`src/core/modules/` 下测试文件与源文件几乎一一对应；模块侧改动需要 `npm run module:typecheck` + `npm run module:build`（重建 `modules/<id>/entry.js` 与 `modules/bundled.json`，这些是构建产物，改完要提交）。

## 运行时组件（Runtime Components）
- 核心代码：`src/core/runtime-components/` 负责发现、下载、安装、生命周期（`runtimeComponentDownloader.ts`/`runtimeComponentInstaller.ts`/`runtimeComponentLoader.ts`/`runtimeComponentService.ts`）。仓库根 `runtime-components/<id>/` 存放各组件自己的源码与构建产物，`runtime-components/sdk.d.ts` 是组件侧契约。
- 已知组件目录（仓库根）：`tokenizer/`、`pdf-engine/`、`bash-engine/`、`embedding-engine/`、`pglite-engine/`——重量级 native/WASM 依赖闭包只能进这里，不能被 host 或普通模块静态 import（`npm run runtime:verify` 会在 host bundle 意外拉入组件依赖时失败）。
- 验证路径：`npm run runtime:typecheck`、组件目录内测试（如 `bashEngineReadOnly.test.ts`、`embeddingEngineRequestQueue.test.ts`）、`npm run runtime:build` + `npm run runtime:verify`。

## Settings
- 核心代码：`src/settings/SettingTab.tsx`（设置面板主体）、`src/settings/schema/`（设置项 schema/迁移）、`src/settings/chatQuickAccess.ts`。
- 依赖子系统：设置项变更常联动工具能力（`src/core/tools/capabilities/`）、模块设置贡献（`moduleSettingsContributions.ts`/`moduleSettingsStore.ts`）、RAG 知识库配置（`knowledgeBaseCatalog.ts`）。
- 验证路径：dev vault 手测设置页交互；schema 迁移改动看 `src/settings/schema/` 下测试，新增迁移前检查当前版本之后是否已有未发布迁移，能合并就合并，避免无意义递增版本号。

## Popout / 多窗口（跨领域约束，非独立功能）
- 说明：Obsidian popout 是独立 `BrowserWindow`，插件 JS 仍在同一 JS realm，但每个窗口有自己的 `document`/`window`/键盘映射。全局 `document`/`window` 只指向主窗口。
- 核心代码：`src/utils/dom/window-context.ts`——任何 view-local DOM 操作（portal、事件监听、`requestAnimationFrame`、`ResizeObserver`/`IntersectionObserver`、`getComputedStyle`、`activeElement`、定时器）必须走节点的 `ownerDocument`/`defaultView`，不能默认用全局 `document`/`window`。
- 依赖子系统：键盘/Escape 层级/菜单要走 Obsidian 的 `Scope`/`app.keymap.pushScope`/`Menu`/`Modal`，纯 React `onKeyDown` + Radix/document-capture 只在主窗口有效，在 popout 里会失效。
- 验证路径：没有自动化测试覆盖 popout 行为——任何 overlay/快捷键/portal 改动必须手动在弹出窗口（不只是主窗口）里验证一遍才算完成。
