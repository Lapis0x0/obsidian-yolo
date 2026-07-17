# 为 YOLO 做贡献

非常感谢你愿意为项目做出贡献。本文档说明我们欢迎什么样的贡献、PR 怎么提，以及为了让 review 不至于失控而存在的规则。

> English version: [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 速查

- **下文标明需要提前讨论的改动，请先开 issue。** 我们更愿意先讨论方向，而不是看到完成的代码再驳回。
- **完全可以使用 AI 编写代码。** 但你得清楚自己改了什么、为什么这么改、可能在哪里出问题 —— 足以在 review 时自己解释清楚。
- **净改动超过 2,000 行且破坏性较大的 PR 必须有关联 issue。** AI 生成的也不例外。
- 提 PR 前先跑一遍 `npm run type:check && npm run lint:check && npm test`。

---

## 我们欢迎什么、不欢迎什么

开发者 review 精力有限，所以贴合项目方向的贡献会更快被合入。下面分级是参考，不是硬规则。

### 🟢 欢迎，可以直接动手

- 有清晰复现步骤的 bug 修复
- 文档、README、翻译改进
- 小范围 UX 打磨（文案、间距、快捷键、可访问性）
- 给已有逻辑补测试
- 有数据支撑的性能优化
- 给已有 provider 增加新模型

### 🟡 请先开 issue 讨论

这类改动要先对齐方向，否则 PR 大概率被推回去重做或被关闭：

- 新的 LLM provider、MCP 集成、内置工具
- 新的内置 skill 或 skill 系统的较大改动
- Agent runtime、RAG 检索、核心对话流程的修改
- 新增设置项，特别是涉及设置迁移的
- UI 结构调整（新面板、布局、主题系统）
- 改动用户数据存储或迁移逻辑

### 🔴 在和 owner 沟通之前，请不要直接发 PR

这些方向 owner 自己有想法，未经沟通的 PR 通常会被关闭：

- README Roadmap 上的项目（学习模式、批注模式、内置助手、AI 白板、语音输入 / 会议纪要）
- 核心架构的重命名或重构（`src/core/agent/`、`src/core/ai/`、`src/core/llm/`）
- 代码里标记为 "experimental" 的部分

不确定属于哪一档，就开个 issue 问一下。

---

## 关于 AI 生成的代码

现在大家基本都在用 AI 写代码，包括 owner 自己。**用 AI 完全没问题，问题是你提了一个自己解释不了的 PR。**

底线为：

- 你应该能用自己的话讲清楚：改了什么、为什么这么改、可能在哪里出问题。不需要在 review 过程中现场再问一次 LLM。
- 当 reviewer 问"这里为什么这么写？"、"这个分支处理什么情况？"、"X 边界考虑过吗？"时，你应该有答案。
- AI 有时候写得比人还好，那很正常。但 AI 也会自信地写出一些在本仓库里完全说不通的代码 —— PR 作者的责任就是在提交之前把后一种情况筛掉。

PR 模板会让你勾选是否使用了 AI。**这是知情声明，不是过滤器** —— 如实勾选即可。勾了"使用 AI"的 PR 不会有任何的区别对待；而任何说不清自己改了什么的 PR，无论谁写的，一样会被关闭。

### 哪些 PR 可能会被快速关闭

- 净改动 > 2,000 行，破坏性较大且没有关联 issue 讨论
- 作者在 review 时讲不清非 trivial 部分的逻辑
- "AI 给的修复不对，我再问一遍 AI" 式的迭代，看不到人做的判断
- 在功能 PR 里夹带大范围重构、文件搬迁或风格重写

---

## PR 体量参考

PR 越小合并越快，自查参考下表：

| 体量 | 净 diff | 说明 |
|------|---------|------|
| **S** | < 100 行 | 小修、文档、打磨。当天就能合的那种。|
| **M** | 100–500 行 | 大多数功能改动应该落在这里，且只做一件事。|
| **L** | 500–2,000 行 | 需要清晰范围，最好有关联 issue。|
| **XL** | > 2,000 行 | 破坏性较大的改动必须有关联 issue，且方案已经讨论一致。|


---

## 开发环境搭建

把仓库 clone 到 Obsidian vault 的插件目录，这样可以直接在真实环境里测：

```bash
git clone https://github.com/Lapis0x0/obsidian-yolo.git \
  /path/to/your/vault/.obsidian/plugins/obsidian-yolo
cd /path/to/your/vault/.obsidian/plugins/obsidian-yolo
npm install
npm run dev
```

然后在 Obsidian 里启用插件。装一个 [Hot Reload 插件](https://github.com/pjeby/hot-reload) 可以自动重载，否则在开发者控制台里按 `Cmd/Ctrl + R` 手动刷新。

### 常用命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 代码 + 样式同时 watch |
| `npm run build` | 生产构建（含 type check）|
| `npm run type:check` | 仅类型检查，不产出文件 |
| `npm run lint:check` / `lint:fix` | Prettier + ESLint |
| `npm test` | Jest 测试 |
| `npm run styles:build` | 从 `src/styles/**` 重新生成 `styles.css` |

### 改样式

仓库根目录的 `styles.css` 是**生成产物**，不要直接改。源文件在 `src/styles/**` 下，改完跑 `npm run styles:build`。所有 CSS 类都要带 `yolo-` 前缀。

写 popover / dropdown 之前，请先看一下 `src/styles/popover/surface.css` 文件头的说明。

---

## 改数据库 schema

YOLO 用的是 PGlite + Drizzle ORM。如果你的改动涉及 schema：

1. 编辑 `src/database/schema.ts`。
2. 生成迁移：`npx drizzle-kit generate --name <migration-name>`
3. 检查 `drizzle/` 下生成的文件。
4. 编译进 bundle：`npm run migrate:compile` —— 这一步会更新 `src/database/migrations.json`，这才是启动时实际跑的迁移。**`drizzle/` 里的文件不编译进来就不会生效。**

每个逻辑改动尽量保持单个迁移文件。如果中间反复迭代生成了多个，提交前合并一下：

1. 删掉 `drizzle/` 里新增的迁移文件。
2. 删掉 `drizzle/meta/` 下新增的 snapshot 文件。
3. 把 `drizzle/meta/_journal.json` 里新增的条目去掉。
4. 重新跑 `npx drizzle-kit generate --name <最终名字>`，生成一个合并后的迁移文件。
5. 再跑一次 `npm run migrate:compile`。

### 在 Obsidian 里调试数据库

在 Obsidian 开发者控制台里：

1. 找到日志 `Next composer database initialized.`
2. 右键日志中的 `DatabaseManager` 对象 → **Store as global variable**（会被存成 `temp1` 之类）。
3. 直接跑查询：
   ```js
   await temp1.pgClient.query(`
     SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
       AND table_type = 'BASE TABLE'
     ORDER BY table_schema, table_name;
   `)
   ```
4. 改完别忘了 `await temp1.save()` 把变更落盘。

---

## 提 PR 之前

1. 从 `main` 拉分支。
2. 跑一遍检查：
   ```bash
   npm run type:check
   npm run lint:check
   npm test
   ```
3. 改了 CSS 的话，跑 `npm run styles:build` 并把生成的 `styles.css` 一起 commit。
4. 修了 bug 或新增了值得固化的行为，就补一个测试。
5. 老老实实把 PR 模板填完 —— 包括 AI 使用声明和关联 issue。

---

## Review 预期

- Owner 用业余时间 review，第一次回复一般在一天到两周之间，大改动会更久。
- 你可以在评论里 @Lapis0x1 来召唤审查 bot，它可以被视为 Lapis0x0 的回复。

---

## License

YOLO 使用 [MIT 许可证](LICENSE)。提交 PR 即代表你同意你的贡献以同样的协议发布。

---

## 维护者备注

有写权限的维护者通过 tag 触发发版：`git tag <版本号> && git push origin <版本号>` 会触发 workflow 完成构建、发布，并自动开一个 PR 把 `manifest.json` / `versions.json` / `package.json` 里的版本号同步过去。
