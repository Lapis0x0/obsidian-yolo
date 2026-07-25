## 1.6.1.3 Safer Updates & More Complete Configuration Transfer 🛡️

### ⚙️ Configuration Transfer

- Fixed configuration imports incorrectly treating an existing YOLO root directory as a migration conflict. Import and export now cover registered feature data consistently, reducing the chance that newer settings are left behind.

### 🔄 Reliable Update Distribution

- Core and module updates now prefer the Cloudflare Pages mirror and automatically fall back to GitHub when needed. Signed feeds, rollback protection, and integrity verification secure the update path while improving reliability on constrained networks.
- Automatic updates are more stable on slower connections and now show accurate background download states instead of a progress indicator that could appear stuck.
- Successful module upgrades clean up replaced local artifacts without compromising rollback when an update fails.

### 💬 Chat Editing

- Fixed a large blank area appearing below long AI responses while editing, which could push later messages far down the conversation.

---

## 1.6.1.3 更安全可靠的更新与更完整的配置迁移 🛡️

### ⚙️ 配置迁移

- 修复导入配置时将已有 YOLO 根目录误判为迁移冲突的问题。配置导入导出现在会统一覆盖已注册的功能数据，降低后续新增配置被遗漏的风险。

### 🔄 可靠的更新分发

- Core 与模块更新现在优先使用 Cloudflare Pages 镜像，并在异常时自动回退 GitHub；同时通过签名 Feed、版本防回退和完整性校验保障更新安全，改善受限网络环境下的可靠性。
- 提升较慢网络下自动更新的下载稳定性，并以准确的后台下载状态替代容易产生卡顿感的进度显示。
- 模块升级成功后会清理已被替换的本地制品，同时在升级失败时保留安全回滚能力。

### 💬 聊天编辑

- 修复编辑较长的 AI 回复时下方出现大块空白、将后续消息推远的问题。
