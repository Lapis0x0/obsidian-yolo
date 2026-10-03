## 1.6.10 Auto Updates 🔄

- Fixed errors when a module depends on updating YOLO Core.
- Improved the Core and module update logic, and introduced an auto-update option. (#611)
- Improved the context compaction implementation, adding a stronger system-level compaction mechanism while keeping the model's ability to compact on its own.
- Fixed knowledge bases that no longer exist still counting toward "needs attention", and the bottom bar permanently showing "waiting to retry". (#612)
- Reduced CPU usage during streaming output to improve performance.
- Simplified the settings and UI of the Agent tools/skills pages, and added search to them. (#599)

---

## 1.6.10 自动更新 🔄

- 修复模块依赖更新 YOLO Core 时的报错问题
- 优化 core 和模块的更新逻辑，引入自动更新选项。（#611）
- 优化上下文压缩实现，引入更强制的系统级的上下文压缩机制，同时保留模型自主压缩的能力
- 修复已不存在的知识库仍被计入「需要关注」、底栏一直显示等待重试的问题。（#612）
- 优化流式输出的 CPU 占用，改善性能表现
- 精简 Agent 工具/技能页设置项与 UI；为 Agent 的工具/技能页增加搜索机制。（#599）
