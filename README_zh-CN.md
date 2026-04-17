<h1 align="center">YOLO</h1>
<p align="center">
  Agent-native AI assistant for Obsidian — 对话、写作、知识库、编排，一站式搞定。
</p>

<p align="center"><a href="https://github.com/Lapis0x0/obsidian-yolo/stargazers">
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
  <a href="./README.md">English</a> | <b>简体中文</b> | <a href="./README_it.md">Italiano</a>
</p>

<p align="center">
  QQ 群: <code>793057867</code>
</p>

## 最近更新

- `1.5.5`：知识库底层焕新，混合检索与索引体验全面升级，搜索结果更智能
- `1.5.4`：面向长会话与复杂任务做「省上下文」—— 引入智能裁剪与压缩、多模型并行、长对话虚拟化与自动压缩等功能
- `1.5.3`：引入原生多窗口对话和后台 Agent，让自动化更顺手
- `1.5.2`：记忆系统正式上线，YOLO 现在能够更自然地记住你的偏好、习惯与长期上下文，让连续对话更懂你
- `1.5.1`：YOLO 迎来全新的 Agent 模式，AI 不再只是回答问题，还可以调用工具、组织步骤并真正参与完成任务

## Highlights

### 🤖 Agent 模式

YOLO 的 Agent 模式让大模型不再只是"问答机器"——它可以真正操作你的 Vault。

| 工具调用 + MCP | 自定义 Skills |
|:-:|:-:|
| ![Agent Tools](./assets/agenttools.gif) | ![Agent Skills](./assets/agentskills.gif) |
| 自由配置工具链，让 Agent 直接读写、编辑、整理你的文件 | 将经验与 SOP 封装为可复用技能，一句话调用，让 Agent 按你的方式工作 |

| 独立 Chat 窗口 | Quick Ask |
|:-:|:-:|
| ![Chat Window](./assets/chatwindow.gif) | ![Quick Ask](./assets/Quickask.gif) |
| 多窗口并行处理不同任务与上下文，让多线程协作更自然 | 通过触发字符（默认 `@`）唤起内联助手，支持问答、编辑、续写三种模式，让文档编辑无缝高效 |

### 🧠 知识库问答 + ✍️ Smart Space

| 知识库问答 | Smart Space |
|:-:|:-:|
| ![RAG Vault](./assets/ragvault.gif) | ![Smart Space](./assets/Smartspace.gif) |
| 将整个 Vault 变成 AI 知识库，基于 RAG 检索增强生成，回答更贴合你的笔记上下文与知识体系 | 随时随地召唤，自由接力你的创意，享受流畅的内容生成体验 |

## Features

除了上述核心能力，YOLO 还提供：

| 特性 | 说明 |
|------|------|
| 💬 侧边栏对话 | 与大模型无缝对话，支持上下文注入、预设 prompt、Markdown 智能解析 |
| 🧠 记忆系统 | 让 YOLO 记住你的偏好、习惯与长期上下文，让连续对话更稳定、更懂你 |
| 🪡 Cursor Chat | 一键添加上下文，触手可得的对话体验 |
| ⌨️ Tab 补全 | 实时 AI 智能补全，让写作更加流畅自然 |
| 🎛️ 多模型支持 | OpenAI、Claude、Gemini、DeepSeek 等主流模型，自由切换 |
| 🌍 i18n 国际化 | 原生多语言支持 |
| 🧩 实验性特性 | Learning Mode、子 Agent 等，探索个性化工作流 |


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
- [ ] 后台 Agent（长程任务自动执行）
- [ ] Cron 定时任务
- [ ] 多 Agent 协同编排
- [ ] 学习模式
- [ ] 更好的 AI 白板


## Contributing

欢迎各种形式的贡献——Bug 报告、文档改进、功能增强都可以。

**重大功能请先开 issue 讨论可行性和实现方案。**


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
