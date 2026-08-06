## 0.1.3 Reliable Project Creation & Clearer Card Failures 📚

### 🗂️ Project Creation

- Fixed project creation failing and leaving the reference staging folder behind when Obsidian is configured to delete files permanently instead of moving them to trash. (Refs #545)

### 🃏 Card Generation

- When a chapter produces no cards, the failure now reports why — how many drafts were streamed, how many were discarded, and which validation rule rejected them — instead of only reporting that generation failed. The diagnostic contains no note or model content; raw model output is written only when the host's LLM debug capture is enabled. (Refs #494, #495)

---

## 0.1.3 更可靠的项目创建与更清晰的卡片失败原因 📚

### 🗂️ 项目创建

- 修复 Obsidian 设置为「永久删除」而非移入回收站时，创建学习项目会失败并残留参考资料临时目录的问题。（Refs #545）

### 🃏 卡片生成

- 章节生成零卡片时，现在会说明失败原因：流式产出的草稿数量、被丢弃的数量，以及具体是哪条校验规则拒绝了它们，而不再只提示生成失败。该诊断不包含笔记与模型正文内容；模型原始输出仅在开启宿主的 LLM 调试记录后才会输出。（Refs #494、#495）
