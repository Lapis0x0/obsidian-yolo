## 1.6.5.5 PDF Annotations & Smoother Generation 📌

- PDF reader now supports annotating selections: quote several passages in a single message and write a separate note for each.
- Reduced UI stuttering during generation by cutting main-thread work. (#573)
- Fixed chat history repeatedly reloading during long streaming tasks, which could freeze the interface. (#573)
- Reworked the starlight animation shown at Max reasoning effort.
- Modules can now ship complete skill packages alongside their release artifacts.
- Rebuilt the registration pipeline for built-in tools and skills so it is easier to maintain.

---

## 1.6.5.5 PDF 批注与更顺滑的生成体验 📌

- PDF 阅读器支持选区批注：可在一条消息中引用多处原文并逐条撰写批注。
- 优化生成时的界面卡顿，减少主线程占用。（#573）
- 修复长时间任务流式输出时聊天记录反复重新加载、可能导致界面卡死的问题。（#573）
- 重做推理强度为 Max 时的星光动画设计。
- 模块可随产物发布完整 skill 包。
- 重构内置工具与 skills 的注册维护管线，降低维护难度。
