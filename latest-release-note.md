## 1.6.7 Similar Notes & CLI Polish 🔗

- Added Similar Notes to the Sparkle sidebar: it surfaces related notes for whatever you are writing, scoped to any combination of knowledge bases, and opens a result in a background tab so you keep your place.
- Approving a CLI agent's tool call now registers immediately, and the waiting state always matches the card you acted on.
- Hermes and pi now show the context window ring, and the token / duration bar under a reply is no longer empty.
- Fixed Hermes and pi replies staying stuck in the generating state after they finished, which made them impossible to select or quote.
- Fixed pi replies losing their line breaks.
- Updates and runtime components now download from Cloudflare R2, and a component's bytes are stored once instead of once per release.

---

## 1.6.7 相似笔记与 CLI 体验打磨 🔗

- 灵光写作侧边栏新增「相似笔记」：基于当前笔记推荐关联内容，范围可多选知识库，点击结果在后台标签页打开，不打断当前写作。
- CLI 智能体的审批结果现在即时生效，等待状态始终与你操作的那张卡片一致。
- Hermes 与 pi 接入上下文窗口占用环，回复底部的 token / 耗时信息栏不再为空。
- 修复 Hermes / pi 回答结束后仍被判定为生成中，导致无法选中或引用回复的问题。
- 修复 pi 回复换行被错误移除的问题。
- 更新与运行组件改由 Cloudflare R2 分发，同一份组件只存一份，不再随每次发版重复存储。
