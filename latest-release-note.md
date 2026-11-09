## 1.6.16 Auto Retry & Fixes 🔁

- Added the mathjax-engine component, powering high-performance rendering in YOLO Whiteboard.
- Model requests now retry automatically, up to 3 times, when rate-limited or the service is overloaded. (#642)
- The annotation editor is now multi-line, so long annotations can be read in full while editing; fixed it being covered by the scrollbar near the right edge. (#639)
- Fixed the context-usage ring and send button rendering as squares under third-party themes such as Primary. (#641)

---

## 1.6.16 自动重试与问题修复 🔁

- 新增 mathjax-engine 组件，服务 YOLO 白板的高性能渲染。
- 模型请求被限流或服务过载时自动重试，最多重试 3 次。（#642）
- 批注编辑框改为多行，长批注编辑时能完整看到；修复贴右时被滚动条遮挡的问题。（#639）
- 修复上下文圆环和发送按钮在 Primary 等第三方主题下显示成方块的问题。（#641）
