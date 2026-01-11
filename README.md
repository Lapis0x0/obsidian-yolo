<h1 align="center">YOLO</h1>

<p align="center">
  <b>English</b> | <a href="./README_zh-CN.md">简体中文</a> | <a href="./README_it.md">Italiano</a>
</p>

<p align="center">
  <a href="./DOC/DOC_en/01-basic-introduction.md">Documentation</a>
  ·
  <a href="https://github.com/Lapis0x0/obsidian-yolo/issues">Report Bug</a>
  ·
  <a href="https://github.com/Lapis0x0/obsidian-yolo/discussions">Discussions</a>
</p>

> [!NOTE]
> **Possibly the most flexible, easy to use, and intelligent Obsidian AI assistant?**  

**YOLO (You Orchestrate, LLM Operates)** is an intelligent assistant for Obsidian, built for the Agent era.

With YOLO you can:

- 💬 Chat with LLMs directly in the sidebar
- 📚 Treat your entire vault as the AI's knowledge base
- ✍️ Summon Smart Space to continue your ideas anywhere
- ⚡ Use Quick Ask for instant inline AI assistance with intelligent editing
- ⌨️ Use Tab completion for a smooth AI-powered writing experience
- 🧩 Enable experimental features like Learning Mode and sub-agents to explore personalized workflows
- 🎨 Enjoy numerous UX improvements and UI polish

YOLO will keep evolving toward agent orchestration, long-range task management, and multi-model collaboration, aiming to become your **serious learning assistant and knowledge partner** in the age of large language models.

## Feature Preview
Here’s a glimpse of YOLO’s core capabilities. Explore the plugin for more details:

## **💬 Sidebar Conversations**

https://github.com/user-attachments/assets/90bbd4f5-b73a-41b4-bf7d-85a5f44659ec

Seamless conversations with LLMs, with context injection, preset prompts, custom providers, and smart Markdown parsing/generation.

## **🧠 Knowledge Base Q&A**

https://github.com/user-attachments/assets/cffbada7-4314-4709-bef4-9867b43d6484

## **✍️ Smart Space**

https://github.com/user-attachments/assets/fa2d32dc-51fb-4f19-a3c3-44c2ea7a5fd9

Summon Smart Space anywhere for natural, fluent, and efficient content generation.

## **⚡ Quick Ask**
> The edit modes of this feature require certain tool-calling capabilities from the model. We recommend using mainstream reasoning models.

https://github.com/user-attachments/assets/5a23e55e-482d-4e03-b564-7eac6814584e

Quick Ask is a lightweight inline assistant that you can summon anywhere with a trigger character (default: `@`). It provides three powerful modes:

- **Ask Mode** 💬: Engage in multi-turn conversations and get instant answers
- **Edit Mode** ✏️: Generate structured edits with preview before applying
- **Edit (Full Access)** ⚡: Apply AI-generated edits directly without confirmation

Quick Ask supports three types of edit operations:

- **CONTINUE**: Append content to the end of your document
- **REPLACE**: Replace existing text with improved versions
- **INSERT AFTER**: Insert new content after specific text

The AI intelligently chooses the appropriate format based on your instructions, making document editing seamless and efficient.

## **🪡 Cursor Chat**

https://github.com/user-attachments/assets/21b775d7-b427-4da2-b20c-f2ede85c2b69

Add it with one click—always within reach.

## **⌨️ Tab Completion**

https://github.com/user-attachments/assets/d19b17c8-92ac-408d-8e98-4403d5341540

Get real-time AI-powered completion suggestions, making your writing flow naturally.

## **🎛️ Multi-Model Support + i18n**

Supports multiple providers (OpenAI, Claude, Gemini, DeepSeek, etc.) with native i18n language switching.

## Getting Started

> [!WARNING]
> YOLO cannot coexist with [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer). Please disable or uninstall Smart Composer before using YOLO.

> [!NOTE]
> YOLO is not yet available in the Obsidian Community Plugin Store. Please install it manually following the steps below.

### Manual Installation

1. Go to the [Releases](https://github.com/Lapis0x0/obsidian-yolo/releases) page
2. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
3. Create a folder named `obsidian-yolo` in your vault's plugin directory: `<vault>/.obsidian/plugins/obsidian-yolo/`
4. Copy the downloaded files into this folder
5. Open Obsidian Settings → Community plugins
6. Enable "YOLO" in the plugin list
7. Set up your API key in plugin settings
   - OpenAI : [ChatGPT API Keys](https://platform.openai.com/api-keys)
   - Anthropic : [Claude API Keys](https://console.anthropic.com/settings/keys)
   - Gemini : [Gemini API Keys](https://aistudio.google.com/apikey)
   - Groq : [Groq API Keys](https://console.groq.com/keys)

For more detailed information, please refer to the [documentation](./DOC/DOC_en/01-basic-introduction.md)

## Contributing

We welcome all kinds of contributions to YOLO, including bug reports, bug fixes, documentation improvements, and feature enhancements.

**For major feature ideas, please create an issue first to discuss feasibility and implementation approach.**

If you're interested in contributing, please refer to our [CONTRIBUTING.md](CONTRIBUTING.md) file for detailed information on:

- Setting up the development environment
- Our development workflow
- Working with the database schema
- The process for submitting pull requests
- Known issues and solutions for developers


## Acknowledgments

Thanks to the original [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) team, without them there would be no YOLO.

## License

This project is licensed under the [MIT License](LICENSE).

## Support the Project

If you find YOLO valuable, consider supporting its development:

<p align="center"> <a href="https://afdian.com/a/lapis0x0" target="_blank"> <img src="https://img.shields.io/badge/爱发电-支持开发者-fd6c9e?style=for-the-badge&logo=afdian" alt="爱发电"> </a> &nbsp; <a href="https://github.com/Lapis0x0/obsidian-yolo/blob/main/donation-qr.jpg" target="_blank"> <img src="https://img.shields.io/badge/微信/支付宝-赞赏码-00D924?style=for-the-badge" alt="微信/支付宝赞赏码"> </a> </p>

I also regularly update development logs on my [blog](https://www.lapis.cafe).

Your support helps maintain and improve this plugin. Every contribution is appreciated and makes a difference. Thank you for your support!

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Lapis0x0/obsidian-yolo&type=Date)](https://star-history.com/#Lapis0x0/obsidian-yolo&Date)
