## 1.6.6.1 Hotfix 🛠️

### 🛠️ Hotfix

- Fixed first-run knowledge base setup: with indexing off, embedding models stayed greyed out, so you couldn't pick one to turn indexing back on. The notes below are from 1.6.6.

## 1.6.6 Offline Embeddings & Multiple Knowledge Bases 📚

### Knowledge base & RAG

- Local embedding inference: download a model on desktop and build the knowledge base index fully offline, no third-party API required.
- Knowledge base rework: manage multiple independent knowledge bases, with a refreshed settings design.
- Rebuilt the RAG vector store on a flat IndexedDB layout, cutting the performance cost and stutter of building and maintaining the index.
- Knowledge base indexing scope and Agent workspace file selection now share one unified folder-scope editor.

### Agent & chat

- Collapsed tool-call summaries now name the edited file and show colored +added/-removed line counts, instead of a bare edit count.
- The Hermes agent picker now shows the custom name you gave an agent, not just its default label.

### Settings & stability

- Fixed the settings page being clipped by blank space top and bottom in Obsidian 1.13's settings window — about 19% more usable height.
- Fixed a false "module operation failed" error shown at startup even when the module was actually running fine.

---

## 1.6.6.1 Hotfix 🛠️

### 🛠️ 热修复

- 修复关闭知识库索引时无法选择/下载嵌入模型，导致无法重新开启索引的问题。以下为 1.6.6 的更新内容。

## 1.6.6 离线 Embedding 与多知识库 📚

### 知识库与 RAG

- 支持本地推理运行 embedding 模型：桌面端下载模型后即可离线构建知识库索引，无需第三方 API。
- 知识库重构：支持管理多个独立知识库，设置样式同步优化。
- 重构 RAG 向量库为 IndexedDB 扁平储存方案，大幅降低索引建立与维护的性能消耗与卡顿。
- 知识库索引范围与 Agent 工作区文件选择组件合并为统一的文件夹作用域编辑器。

### Agent 与对话

- 工具调用折叠摘要现在会点名具体编辑的文件，并展示彩色的增删行数，而不是只报一个编辑次数。
- Hermes agent 选择器现在会显示你为 agent 设置的自定义名称，而不只是默认名。

### 设置与稳定性

- 修复设置页在 Obsidian 1.13 设置窗口中被上下空白截断的问题，可视内容区增加约 19%。
- 修复启动后模块实际运行正常，却误报"模块操作失败"的问题。
