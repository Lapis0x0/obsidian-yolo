<h1 align="center">YOLO</h1>

<p align="center">
  <a href="./README.md">English</a> | <b>简体中文</b> | <a href="./README_it.md">Italiano</a>
</p>

<p align="center">
  <a href="./DOC/DOC_zhCN/01-基本介绍.md">文档</a>
  ·
  <a href="https://github.com/Lapis0x0/obsidian-yolo/issues">报告 Bug</a>
  ·
  <a href="https://github.com/Lapis0x0/obsidian-yolo/discussions">参与讨论</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/🎉_现已上架_Obsidian_社区插件商店-6c5ce7?style=for-the-badge" alt="Now Available on Obsidian" height="35">
</p>

> [!NOTE]
> **可能是目前最灵活、易用、智能的 Obsidian AI 助手？**  

**YOLO（You Orchestrate, LLM Operates）** 是一款为 Obsidian 打造的面向 Agent 时代的智能助手。

你可以用 YOLO：

- 💬 在侧边栏和 LLM 进行对话讨论
- 📚 将你的整个 Vault 作为 AI 的知识库
- ✍️ 使用「Smart Space」来自由接力你的创意
- ⚡ 使用 Quick Ask 获得即时的内联 AI 助手和智能编辑
- ⌨️ 使用 Tab 补全获得流畅的 AI 写作体验
- 🧩 开启 Learning Mode、子 Agent 等实验性特性，探索个性化工作流
- 🎨 更多、更好的用户体验优化与 UI 改善

未来，YOLO 将在 Agent 编排、长程任务管理、多模型协同等方向持续演进，目标是成为你在大模型时代的**严肃学习助手与知识合作伙伴**。

## 特性预览
以下是 YOLO 的部分核心能力展示，更多细节欢迎在插件中自行探索：

## **💬 侧边栏对话**

https://github.com/user-attachments/assets/90bbd4f5-b73a-41b4-bf7d-85a5f44659ec

与大模型无缝对话，支持上下文注入、预设 prompt、自定义 provider，以及对 Markdown 内容的智能解析与生成。

## **🧠 知识库问答**

https://github.com/user-attachments/assets/cffbada7-4314-4709-bef4-9867b43d6484

## **✍️ Smart Space**

https://github.com/user-attachments/assets/fa2d32dc-51fb-4f19-a3c3-44c2ea7a5fd9

在任何地方召唤出 Smart Space，享受自然流畅高效的内容生成

## **⚡ Quick Ask**
> 该功能的编辑模式对于模型的工具调用能力有一定需求，推荐使用目前的主流推理模型

https://github.com/user-attachments/assets/5a23e55e-482d-4e03-b564-7eac6814584e

Quick Ask 是一个轻量级的内联助手，你可以在任何地方通过触发字符（默认：`@`）召唤它。它提供三种强大的模式：

- **问答模式** 💬：进行多轮对话，获取即时回答
- **编辑模式** ✏️：生成结构化编辑，预览后应用
- **编辑（完全访问）** ⚡：直接应用 AI 生成的编辑，无需确认

Quick Ask 支持三种编辑操作类型：

- **CONTINUE（续写）**：在文档末尾追加内容
- **REPLACE（替换）**：将现有文本替换为改进版本
- **INSERT AFTER（插入）**：在指定文本后插入新内容

AI 会根据你的指令智能选择合适的格式，让文档编辑无缝高效。

## **🪡 Cursor Chat**

https://github.com/user-attachments/assets/21b775d7-b427-4da2-b20c-f2ede85c2b69

一键添加，触手可得

## **⌨️ Tab 补全**

https://github.com/user-attachments/assets/d19b17c8-92ac-408d-8e98-4403d5341540

实时获得 AI 智能补全建议，让写作更加流畅自然。

## **🎛️ 模型多路支持 + i18n 国际化**

支持多模型配置（OpenAI、Claude、Gemini、DeepSeek 等），并原生支持i18n 语言切换切换。

## 开始使用

> [!WARNING]
> YOLO 无法与 [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) 共存，请在使用 YOLO 前禁用或卸载 Smart Composer。

### 从社区插件商店安装(推荐)

1. 打开 Obsidian 设置 → 社区插件
2. 点击"浏览"并搜索"YOLO"
3. 点击"安装"然后点击"启用"
4. 在插件设置中配置你的 API 密钥
   - OpenAI : [ChatGPT API 密钥](https://platform.openai.com/api-keys)
   - Anthropic : [Claude API 密钥](https://console.anthropic.com/settings/keys)
   - Gemini : [Gemini API 密钥](https://aistudio.google.com/apikey)
   - Groq : [Groq API 密钥](https://console.groq.com/keys)

### 手动安装

你也可以手动安装 YOLO：

1. 前往 [Releases](https://github.com/Lapis0x0/obsidian-yolo/releases) 页面
2. 下载最新版本的 `main.js`、`manifest.json` 和 `styles.css`
3. 在你的 Vault 插件目录下创建文件夹：`<vault>/.obsidian/plugins/obsidian-yolo/`
4. 将下载的文件复制到该文件夹中
5. 打开 Obsidian 设置 → 社区插件
6. 在插件列表中启用 "YOLO"
7. 在插件设置中配置你的 API 密钥

其余详细内容请参考[文档](./DOC/DOC_zhCN/01-基本介绍.md)

## 贡献

我们欢迎对 YOLO 的各种贡献，包括错误报告、bug 修复、文档改进和功能增强。

**对于主要的功能想法，请首先创建一个 issue 来讨论可行性和实现方法。**

## 致敬

感谢原本的 [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) 团队，没有他们就没有 YOLO。

## 许可证

该项目根据 [MIT 许可证](LICENSE) 授权。

## 支持项目

如果您觉得 YOLO很有价值，请考虑支持其发展：

<p align="center"> <a href="https://afdian.com/a/lapis0x0" target="_blank"> <img src="https://img.shields.io/badge/爱发电-支持开发者-fd6c9e?style=for-the-badge&logo=afdian" alt="爱发电"> </a> &nbsp; <a href="https://github.com/Lapis0x0/obsidian-yolo/blob/main/donation-qr.jpg" target="_blank"> <img src="https://img.shields.io/badge/微信/支付宝-赞赏码-00D924?style=for-the-badge" alt="微信/支付宝赞赏码"> </a> </p>


我也会定期在自己的[博客](https://www.lapis.cafe)中更新一些开发日志。

您的支持有助于维护和改进这个插件。每一份贡献都受到赞赏并能带来改变。感谢您的支持！

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=Lapis0x0/obsidian-yolo&type=Date)](https://star-history.com/#Lapis0x0/obsidian-yolo&Date)
