# Getting started

This page takes you from nothing to a working YOLO: install it, configure a model that works, and have your first chat. About five minutes end to end.

## Install

### From the community plugin store (recommended)

1. Open Obsidian settings → **Community plugins** → **Browse**
2. Search for **YOLO**
3. Install it, then enable it

### Manual install

1. Download the latest `main.js`, `manifest.json` and `styles.css` from [Releases](https://github.com/Lapis0x0/obsidian-yolo/releases)
2. Create the folder `<your vault>/.obsidian/plugins/obsidian-yolo/`
3. Drop the three files in there, go back to Obsidian settings and enable the plugin

> **YOLO cannot be enabled alongside [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer).** YOLO is a fork of Smart Composer, and the two conflict with each other. Disable or uninstall Smart Composer first.

## Configure a model that works

Right after installing, YOLO can't do anything yet — it needs a model. Open **Settings → YOLO → Models**.

### Step 1: add a provider

Click **Add provider**. A picker opens, grouped by region and type:

- **International**: OpenAI, Anthropic, Gemini, Mistral, Groq, xAI and others
- **China**: DeepSeek, Moonshot, Zhipu, Doubao, SiliconFlow, MiniMax and others
- **Gateway**: OpenRouter, APIMart, Fluxion AI — one key, many models
- **Cloud**: Azure OpenAI, Amazon Bedrock
- **Local**: Ollama, LM Studio — the model runs on your own machine
- **Custom provider**: any OpenAI-compatible endpoint; just fill in Base URL and API key

Pick one and paste in your API key. Keys for the common services are issued here:

- [OpenAI](https://platform.openai.com/api-keys)
- [Anthropic](https://console.anthropic.com/settings/keys)
- [Gemini](https://aistudio.google.com/apikey)
- [Groq](https://console.groq.com/keys)

> **Don't want to pay for API usage?** If you already subscribe to ChatGPT Plus or Claude, look for the entries with an **OAuth** badge in the provider list (ChatGPT OAuth, Gemini OAuth, Claude OAuth). Sign in with your account and you reuse your subscription quota — no API key needed. See [Models and providers](./models.md#sign-in-with-a-subscription-account-oauth).

### Step 2: add a model

Once the provider is added, expand its card and click **Add chat model**.

You can pick from the list of available models it fetches automatically, or type a model ID by hand. If you want to add several at once, switch to **Batch** mode and tick them off.

![Models settings: expanding a provider shows the chat models under it](../assets/settings-models.png)

> Screenshots in this documentation show the English interface.

### Step 3: make it the default

Scroll down to **Default model policies & prompts** at the bottom of the Models tab and set **Default chat model** to the model you just added.

## Your first chat

Click the YOLO icon in the left ribbon to open the chat panel and type something.

To make it read your notes, type `@` in the input box — the first item in the menu is usually **Current file**. Select it, then ask your question, e.g. "summarize the key points of this note".

### Meet the three modes first

Next to the input box there's a mode dropdown. This is YOLO's single most important switch: it decides **what it is allowed to do**.

| Mode | What it can do | When to use it |
|------|-----------|-----------|
| **Ask** | Read notes, search, go online, but **won't touch the body of your notes** | Questions, summaries, suggested edits |
| **Agent** | Everything Ask does, plus **editing notes**, running multi-step tasks, using the terminal | When you want it to actually change notes and tidy up your vault |
| **Max** | Read and write **any file on the machine**, not just your vault (desktop only) | Work that reaches outside Obsidian; the widest permissions |

If you're new, stay on **Ask** for a while to get a feel for it, and switch to **Agent** when you want it to start editing.

For the full explanation of the modes, plus the high-risk auto-approve switch, see [Chat](./chat.md#three-modes).

### Editing your notes requires your consent

In Agent mode the model doesn't overwrite your files directly. It shows you a diff first, and nothing is written until you click **Apply**; every round of changes also has an undo entry underneath it.

That said, **undo relies on a local snapshot and does not sync with your notes.** For anything important, keep using Git or Obsidian's own file recovery as your safety net.

## What to do next

Getting it to chat is just the starting point. Pick a direction based on what you need:

- **You want answers grounded in your whole vault** → [Knowledge base and search](./knowledge-base.md): index your vault so answers have sources. A local embedding model that needs no API key is supported too.
- **You want AI while you write** → [Sparkle](./sparkle.md): tab completion, selection rewrites and the Quick Ask panel, all without leaving the editor.
- **You're worried it'll mess with your files** → [Tools and permissions](./tools-and-permissions.md): see exactly what it can do, and how to confine it to a specific folder.
- **You want it to remember your preferences** → [Memory](./memory.md)
- **You want several personas for different jobs** → [Agents](./assistants.md)

Hit a problem? Check the [FAQ](./faq.md) first.
