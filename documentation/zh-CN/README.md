# YOLO 使用文档

YOLO 是一个 Obsidian 插件，把 AI 助手放进你的 Vault：和笔记对话、让它直接读写文件、检索整个知识库、在编辑器里补全和改写，以及通过模块扩展出学习、白板这样的完整功能。

## 从这里开始

刚装好插件，按顺序读这三篇就能正常用起来：

1. **[快速开始](./getting-started.md)** — 安装、配一个能用的模型、完成第一次对话
2. **[模型与提供商](./models.md)** — 接入 OpenAI / Claude / Gemini 等服务，OAuth 登录，以及几个「默认模型」分别管什么
3. **[对话](./chat.md)** — 对话界面能做的全部事情：引用笔记、Ask 与 Agent 两种模式、工具审批、把改动写回笔记

## 日常使用

- **[灵光写作](./sparkle.md)** — 不离开编辑器的 AI：Quick Ask 浮层、Tab 补全、选区改写、续写
- **[知识库与检索](./knowledge-base.md)** — 给 Vault 建索引让回答有据可依，多知识库管理，以及不需要 API Key 的本地嵌入模型
- **[工具与权限](./tools-and-permissions.md)** — YOLO 能对你的 Vault 做什么，审批机制怎么工作，如何把它限制在指定目录内

## 让它更懂你

- **[记忆](./memory.md)** — 让 YOLO 跨对话记住你的偏好和长期上下文
- **[助手与子 Agent](./assistants.md)** — 为不同场景配置专属助手，以及把大任务拆给子 Agent
- **[Skills](./skills.md)** — 用一个 Markdown 文件教会 YOLO 按你的方式做事

## 进阶

- **[MCP](./mcp.md)** — 接入外部 MCP 服务扩展能力，以及把 YOLO 的 Vault 检索暴露给其他 Agent
- **[CLI Agent](./cli-agent.md)** — 桌面端直接驱动本机已登录的 Claude Code、Codex 等
- **[模块](./modules.md)** — 模块系统，以及学习模块与白板模块的用法

## 查阅

- **[设置参考](./settings-reference.md)** — 设置页六个标签的逐项说明
- **[常见问题](./faq.md)** — 报错排查与高频疑问

---

## 关于这份文档

这份文档由 **Claude** 撰写并负责持续维护，内容依据当前代码的实际行为整理。

好处是它能覆盖到不少藏在设置深处、平时没人记录的细节；风险是机器也会出错，尤其是"某功能不支持某场景"这类否定性描述。**文档和界面对不上时，以界面为准**，并且请[开一个 issue](https://github.com/Lapis0x0/obsidian-yolo/issues/new?template=bug_report_zh.yml) 告诉我们——文档写错和功能出 bug 一样值得修。

某一段读完仍然不知道该点哪里，同样欢迎提出来。

想参与开发请看 [CONTRIBUTING_zh-CN.md](../../CONTRIBUTING_zh-CN.md)。
