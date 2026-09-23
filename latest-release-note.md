## 1.6.9.6 Faster Startup ⚡

- Improved plugin startup/loading performance and reduced the distributed plugin size (about 40%).
- Redesigned how context and chain-of-thought content are passed along, improving cache hit rates.
- Refined prompt design to reduce conflicting, inaccurate, or unnecessary constraints.
- Fixed provider cards becoming unclickable after being expanded on mobile.
- Fixed a bug where the "prune tool call results" tool removed the entire tool message.
- Fixed a bug where reading a whiteboard file in Max mode wrongly returned the raw JSON content.

---

## 1.6.9.6 启动提速 ⚡

- 优化插件启动/加载性能，缩小分发插件体积（约 40%）
- 优化上下文与思维链内容传递机制设计，提高缓存命中效率
- 优化相关提示词设计，减少冲突/不符合实际情况/不必要的约束
- 修复移动端 Provider 卡片展开之后无法点击的问题
- 修复「剪裁工具调用结果」Tool 会移除掉整条工具消息的 bug
- 修复 max 模式下读取白板文件会错误返回原始 json 内容的 bug
