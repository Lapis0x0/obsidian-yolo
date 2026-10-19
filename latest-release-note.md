## 1.6.12 DeepSeek Search & Fixes 🔍

- Added DeepSeek as an optional provider for the search tool.
- Fixed settings being overwritten with defaults when the settings file could not be read at startup in a synced folder, and stopped auto-indexing from frequently writing to the settings file. (#620)
- Fixed conversations getting stuck in "running" after approving a tool, so new messages could not be sent. (#622)
- Fixed conversations failing to send requests when the skills directory contains broken links. (#623)
- Fixed the response usage stats adding up every model's usage when @-mentioning multiple models at once.
- Fixed the Whiteboard and Learning Mode ribbon icons jumping position and losing their hidden state after a restart.

---

## 1.6.12 DeepSeek 搜索与问题修复 🔍

- 添加 DeepSeek 作为搜索工具的可选 Provider
- 修复同步目录下启动时读不到设置文件导致配置被默认值覆盖的问题，并停止自动索引对设置文件的高频写入。（#620）
- 修复审批工具后会话卡在运行中、无法发送新消息。（#622）
- 修复技能目录存在失效链接时对话无法发出请求。（#623）
- 修复同时 @ 多个模型时，回复用量统计把各模型的用量叠加在一起的问题
- 修复白板、学习模式的侧边栏图标重启后位置跳动、隐藏失效的问题
