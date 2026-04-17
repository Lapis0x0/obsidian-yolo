<h1 align="center">YOLO</h1>
<p align="center">
  Agent-native AI assistant for Obsidian — chat, write, knowledge base, and orchestration, all in one place.
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
  <b>English</b> | <a href="./README_zh-CN.md">简体中文</a> | <a href="./README_it.md">Italiano</a>
</p>

## What's New

- `1.5.5`: Refreshed knowledge-base foundations with fully upgraded hybrid search and indexing—and smarter, more relevant results.
- `1.5.4`: Built for long chats and complex tasks: smarter context pruning and compression, multi-model branches, a virtualized chat timeline, and automatic compression to keep agents running smoothly.
- `1.5.3`: Native multi-window chat plus background Agents—automation that stays out of your way.
- `1.5.2`: The new memory system is now live, allowing YOLO to more naturally remember your preferences, habits, and long-term context across conversations.
- `1.5.1`: YOLO introduced an all-new Agent mode, turning AI from a chat assistant into something that can call tools, organize steps, and actively help get real work done.

## Highlights

### 🤖 Agent Mode

YOLO's Agent mode lets LLMs go beyond just "Q&A machines" — they can actually operate on your Vault.

| Tool Calling + MCP | Custom Skills |
|:--:|:--:|
| ![Agent Tools](./assets/agenttools.gif) | ![Agent Skills](./assets/agentskills.gif) |
| Freely configure toolchains so Agents can read, write, edit, and organize your files directly | Encapsulate experience and SOPs into reusable skills, invoke with a single sentence — let the Agent work your way |

| Multi-Window Chat | Quick Ask |
|:--:|:--:|
| ![Chat Window](./assets/chatwindow.gif) | ![Quick Ask](./assets/Quickask.gif) |
| Handle different tasks and contexts in parallel across multiple chat windows, making multitasking feel more natural | Trigger with a character (default `@`) to open an inline assistant for Q&A, editing, and continuation, making document editing seamless |

### 🧠 Knowledge Base Q&A + ✍️ Smart Space

| Knowledge Base Q&A | Smart Space |
|:--:|:--:|
| ![RAG Vault](./assets/ragvault.gif) | ![Smart Space](./assets/Smartspace.gif) |
| Turn your entire Vault into the AI's knowledge base, powered by RAG to answer with context from your notes instead of generic output | Summon anywhere to freely continue your creative flow with smooth content generation |

## Features

Beyond the core capabilities above, YOLO also provides:

| Feature | Description |
|---------|-------------|
| 💬 Sidebar Chat | Seamless LLM conversation with context injection, preset prompts, Markdown smart parsing |
| 🧠 Memory System | Lets YOLO remember preferences, habits, and long-term context for more consistent conversations |
| 🪡 Cursor Chat | One-click context addition, conversation at your fingertips |
| ⌨️ Tab Completion | Real-time AI-powered completion for smoother, more natural writing |
| 🎛️ Multi-Model Support | OpenAI, Claude, Gemini, DeepSeek and other mainstream models, freely switch |
| 🌍 i18n | Native multi-language support |
| 🧩 Experimental Features | Learning Mode, sub-Agents, explore personalized workflows |

## Quick Start

1. Open Obsidian Settings → Community Plugins → Browse → Search **"YOLO"**
2. Install and enable
3. Configure your API key in plugin settings, or use your own ChatGPT OAuth / Gemini OAuth:
   - [OpenAI](https://platform.openai.com/api-keys) / [Anthropic](https://console.anthropic.com/settings/keys) / [Gemini](https://aistudio.google.com/apikey) / [Groq](https://console.groq.com/keys)
4. Open the sidebar to start chatting — or try Quick Ask by typing `@` in the editor

## Installation

### Community Plugin Store (Recommended)

See Quick Start above.

### Manual Installation

1. Go to [Releases](https://github.com/Lapis0x0/obsidian-yolo/releases) and download the latest `main.js`, `manifest.json`, `styles.css`
2. Create folder: `<vault>/.obsidian/plugins/obsidian-yolo/`
3. Copy files to that folder, then enable the plugin in Obsidian Settings

> [!WARNING]
> YOLO cannot coexist with [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer). Please disable or uninstall Smart Composer before using YOLO.

## Mobile Support Note

Due to the capability gap between Obsidian mobile and desktop, YOLO cannot fully match the desktop feature set and overall experience on mobile in the short term. With limited personal maintenance bandwidth, I can currently only guarantee that YOLO remains usable on mobile, not that every feature will reach desktop-level parity.

If you use YOLO on mobile, you may still encounter unavailable features, inconsistent behavior, or incomplete adaptations for some workflows. Please keep that expectation in mind.

## Roadmap

- [x] Better and stronger Vault AI search
- [ ] Background Agent (long-running task automation)
- [ ] Cron scheduled tasks
- [ ] Multi-Agent orchestration
- [ ] Learning Mode
- [ ] Better AI whiteboard

## Contributing

All forms of contribution are welcome — bug reports, documentation improvements, feature enhancements.

**Please open an issue first to discuss feasibility and implementation for major features.**

## Acknowledgments

Thanks to [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) for the original work — without them, there would be no YOLO.

Special thanks to [Kilo Code](https://kilo.ai) for their sponsorship. Kilo is an open-source AI coding assistant platform with 500+ AI models, helping developers build and iterate faster.

<p align="center">
  <a href="https://kilo.ai" target="_blank">
    <img src="https://img.shields.io/badge/Sponsored_by-Kilo_Code-FF6B6B?style=for-the-badge" alt="Sponsored by Kilo Code" height="30">
  </a>
</p>

## Support

If you find YOLO valuable, consider supporting the project:

<p align="center">
  <a href="https://afdian.com/a/lapis0x0" target="_blank">
    <img src="https://img.shields.io/badge/爱发电-Support Developer-fd6c9e?style=for-the-badge" alt="爱发电">
  </a>
  &nbsp;
  <a href="https://github.com/Lapis0x0/obsidian-yolo/blob/main/donation-qr.jpg" target="_blank">
    <img src="https://img.shields.io/badge/WeChat/Alipay-Donation QR-00D924?style=for-the-badge" alt="WeChat/Alipay Donation QR">
  </a>
</p>

Development logs are regularly updated on the [blog](https://www.lapis.cafe).

## License

[MIT License](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Lapis0x0/obsidian-yolo&type=Date)](https://star-history.com/#Lapis0x0/obsidian-yolo&Type=Date)
