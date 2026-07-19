<h1 align="center">YOLO</h1>
<p align="center">
  Agent-native AI assistant for Obsidian — 对话、写作、知识库、编排，一站式搞定。
</p>

<p align="center"><a href="https://github.com/Lapis0x0/obsidian-yolo/commits/main">
    <img src="https://img.shields.io/github/last-commit/Lapis0x0/obsidian-yolo/main?style=flat-square&color=6c5ce7" alt="Last Commit">
  </a>
  <a href="https://github.com/Lapis0x0/obsidian-yolo/stargazers">
    <img src="https://img.shields.io/github/stars/Lapis0x0/obsidian-yolo?style=flat-square&color=6c5ce7" alt="GitHub Stars">
  </a>
  <a href="https://github.com/Lapis0x0/obsidian-yolo/releases/latest">
    <img src="https://img.shields.io/github/v/release/Lapis0x0/obsidian-yolo?style=flat-square&color=00b894" alt="Latest Release">
  </a>
  <a href="https://github.com/Lapis0x0/obsidian-yolo/releases">
    <img src="https://img.shields.io/github/downloads/Lapis0x0/obsidian-yolo/total?style=flat-square&color=0984e3" alt="Downloads">
  </a>
  <a href="https://github.com/Lapis0x0/obsidian-yolo/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/Lapis0x0/obsidian-yolo?style=flat-square&color=636e72" alt="License">
  </a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <b>简体中文</b> | <a href="./README_it.md">Italiano</a> | <a href="./README_es.md">Español</a>
</p>

<p align="center">
  QQ 群: <code>793057867</code> | <a href="./assets/wechat-group.png">微信群</a>
</p>

## 最近更新

- **`1.6`**：推出全新的学习模式，可根据学习主题、目标和参考资料生成个性化学习项目，包括结构化大纲、知识点、闪卡与交互式知识地图；并通过 FSRS 间隔复习和 Anki 卡包导入，将知识整理、学习与长期复习串成完整工作流

- **`1.5`**：引入全新 Agent 运行时，让 AI 从「问答」升级为「协作」，完整支持工具调用、MCP、Skills、桌面 Bash、子 Agent 与联网搜索；同时带来长会话上下文与记忆、混合检索 RAG、焦点同步与 PDF 感知，以及多窗口对话与后台 Agent

## Highlights

| 跨端可用的完整 Agent 体验 | 让 Vault 里的知识真正被你掌握 |
|:-:|:-:|
| ![Agent Tools](./assets/agenttools.gif) | ![Learning Mode](./assets/learning-mode.gif) |
| 不止回答问题。YOLO 能理解并操作你的 Vault，调用工具与 MCP，并通过 Skills 按你的方式完成任务。 | 把主题与资料转化为专属学习内容，再用闪卡与 FSRS 持续复习，让知识从被收藏走向真正掌握。 |

## Features

除了上述核心能力，YOLO 还提供：

| 特性 | 说明 |
|------|------|
| 🔌 外部 Agent 支持 | 通过 MCP，让 Hermes、OpenClaw 等外部 Agent 使用 YOLO 的 Vault 搜索，或派遣已配置的 YOLO Agent 执行任务 |
| ⚡ Quick Ask 与 Smart Space | 无需离开编辑器即可提问、修改和续写内容 |
| 🔎 Vault RAG | 检索整个 Vault，让回答建立在你自己的笔记之上 |
| 🪟 多窗口对话 | 在独立对话窗口中并行处理不同任务与上下文 |
| 🧠 记忆系统 | 让 YOLO 记住你的偏好、习惯与长期上下文，让连续对话更稳定、更懂你 |
| 🪡 Cursor Chat | 一键添加上下文，触手可得的对话体验 |
| ⌨️ Tab 补全 | 实时 AI 智能补全，让写作更加流畅自然 |
| 🎛️ 多模型支持 | OpenAI、Claude、Gemini、DeepSeek 等主流模型，自由切换 |
| 🌍 i18n 国际化 | 原生多语言支持 |


## Quick Start

1. 打开 Obsidian 设置 → 社区插件 → 浏览 → 搜索 **"YOLO"**
2. 安装并启用
3. 在插件设置中配置你的 API Key，或者使用你自己的 ChatGPT OAuth / Gemini OAuth：
   - [OpenAI](https://platform.openai.com/api-keys) / [Anthropic](https://console.anthropic.com/settings/keys) / [Gemini](https://aistudio.google.com/apikey) / [Groq](https://console.groq.com/keys)
4. 打开侧边栏，开始对话——或者在编辑器里输入 `@` 试试 Quick Ask


## Installation

### 社区插件商店（推荐）

见上方 Quick Start。

### 手动安装

1. 前往 [Releases](https://github.com/Lapis0x0/obsidian-yolo/releases) 下载最新版本的 `main.js`、`manifest.json`、`styles.css`
2. 在 Vault 插件目录下创建文件夹：`<vault>/.obsidian/plugins/obsidian-yolo/`
3. 将文件复制到该文件夹，然后在 Obsidian 设置中启用插件

> [!WARNING]
> YOLO 无法与 [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) 共存，请在使用前禁用或卸载 Smart Composer。

## 移动端说明

受限于 Obsidian 移动端与桌面端之间的能力差异，YOLO 在移动端暂时无法完整对齐桌面端的全部功能与体验。再加上个人维护精力有限，我目前只能保证移动端可用，而难以保证所有功能都能达到桌面端同等水准。

如果你在移动端使用 YOLO，可能会遇到部分功能暂不可用、体验不一致或适配尚不完善的情况，还请理解。


## Roadmap

- [x] 更好，更强的 Vault AI 搜索
- [x] 后台 Agent（长程任务自动执行）
- [x] 多 Agent 协同编排（通过 subagent 实现）
- [x] 学习模式 —— 一个专用的学习视图
- [ ] 批注模式 —— 对笔记进行实时的 AI 评注与建议
- [ ] 内置助手 —— 右下角常驻，统管配置与 agent，支持自动压缩与定时任务
- [ ] 更好的 AI 白板
- [ ] 语音输入与会议纪要


## 反馈与 Issue

遇到 bug、有困惑或新想法,欢迎开 issue:

🐛 [报告 bug](https://github.com/Lapis0x0/obsidian-yolo/issues/new?template=bug_report_zh.yml) · ✨ [提出想法](https://github.com/Lapis0x0/obsidian-yolo/issues/new?template=feature_request_zh.yml)

这样的反馈最有帮助:

- 带清晰复现步骤的 bug(Obsidian 版本、操作系统、插件版本、操作过程、实际现象)
- "我做了 X 结果是 Y" 类问题——交互细节、文案混乱、文档过时、翻译错漏
- 有具体使用场景的功能想法("我在做 A 时希望能 B,因为 C")

提交前请先搜一下已有 issue,避免重复。


## Contributing

欢迎各种形式的贡献——Bug 报告、文档改进、功能增强都可以。

**重大功能请先开 issue 讨论可行性和实现方案。**

详细规则请看 [CONTRIBUTING_zh-CN.md](./CONTRIBUTING_zh-CN.md)：什么样的贡献会被欢迎、AI 辅助 PR 的要求、PR 体量参考、开发环境搭建。


## Acknowledgments

感谢 [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) 团队的原始工作，没有他们就没有 YOLO。

特别感谢 [Kilo Code](https://kilo.ai) 的赞助支持。Kilo 是一个开源 AI 编程助手平台，支持 500+ AI 模型，帮助开发者更快地构建与迭代。

<p align="center">
  <a href="https://kilo.ai" target="_blank">
    <img src="https://img.shields.io/badge/Sponsored_by-Kilo_Code-FF6B6B?style=for-the-badge" alt="Sponsored by Kilo Code" height="30">
  </a>
</p>


## Support

如果觉得 YOLO 有价值，欢迎支持项目发展：

<p align="center">
  <a href="https://afdian.com/a/lapis0x0" target="_blank">
    <img src="https://img.shields.io/badge/爱发电-支持开发者-fd6c9e?style=for-the-badge" alt="爱发电">
  </a>
  &nbsp;
  <a href="https://github.com/Lapis0x0/obsidian-yolo/blob/main/donation-qr.jpg" target="_blank">
    <img src="https://img.shields.io/badge/微信/支付宝-赞赏码-00D924?style=for-the-badge" alt="微信/支付宝赞赏码">
  </a>
</p>

开发日志会定期更新在[博客](https://www.lapis.cafe)上。


## License

[MIT License](LICENSE)


## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Lapis0x0/obsidian-yolo&type=Date)](https://star-history.com/#Lapis0x0/obsidian-yolo&Date)
