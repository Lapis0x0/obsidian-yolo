## 1.6.9.2 Performance Improvements ⚡

### Reading & writing

- You can now select text in reading mode to ask about it, add it to the sidebar, and keep it highlighted. (#596)
- Fixed the PDF selection menu and highlights not working in pop-out windows.
- Improved the prompt design for Tab completion to make multiple suggestions more stable.

### Chat & agent

- Models in Ask/Agent mode can now read images in your vault on their own (requires a vision-capable model). (#595)
- Improved performance while the model is generating.

### Knowledge base

- Fixed indexing slowing down while staying on the knowledge base settings page.
- Fixed indexing getting stuck on large numbers of PDF documents due to the old PDF cache mechanism.
- Removed the size and page limits for PDF indexing.

---

## 1.6.9.2 性能优化 ⚡

### 阅读与写作

- 阅读模式下选中文字也能提问、加入侧边栏并保留高亮。（#596）
- 独立窗口中的 PDF 选区菜单与高亮恢复正常。
- 优化 tab 补全场景的提示词设计以提高多补全的稳定性。

### 对话与 Agent

- Ask/Agent 模式下模型可以自主读取 Vault 中的图片（需模型支持视觉）。（#595）
- 优化模型生成过程中的性能表现。

### 知识库

- 修复停留在知识库设置页时索引变慢的问题。
- 修复原 PDF 缓存机制导致索引大量 PDF 文档时卡住的问题。
- 取消 PDF 索引的大小与页数限制。
