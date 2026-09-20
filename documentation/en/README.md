# YOLO documentation

[简体中文](../zh-CN/README.md) · English · [Italiano](../it/README.md)

YOLO is an Obsidian plugin that puts an AI assistant inside your vault: chat with your notes, let it read and write files directly, search your whole knowledge base, complete and rewrite text right in the editor, and extend it with full-blown modules such as Learning and Whiteboard.

## Start here

Just installed the plugin? Read these three in order and you'll be up and running:

1. **[Getting started](./getting-started.md)** — install it, configure a model that actually works, have your first chat
2. **[Models and providers](./models.md)** — connect OpenAI / Claude / Gemini and friends, sign in with OAuth, and what each "default model" slot is responsible for
3. **[Chat](./chat.md)** — everything the chat surface can do: mentioning notes, the Ask and Agent modes, tool approval, writing changes back into your notes

## Everyday use

- **[Sparkle](./sparkle.md)** — AI without leaving the editor: the Quick Ask panel, tab completion, selection rewrites, continuation
- **[Knowledge base and search](./knowledge-base.md)** — index your vault so answers are grounded, manage multiple knowledge bases, and use a local embedding model that needs no API key
- **[Tools and permissions](./tools-and-permissions.md)** — what YOLO can do to your vault, how approval works, and how to confine it to a specific folder

## Make it understand you

- **[Memory](./memory.md)** — let YOLO remember your preferences and long-term context across chats
- **[Agents and subagents](./assistants.md)** — configure dedicated assistants for different situations, and hand big tasks off to subagents
- **[Skills](./skills.md)** — teach YOLO to do things your way with a single Markdown file

## Going further

- **[MCP](./mcp.md)** — plug in external MCP servers, and expose YOLO's vault search to other agents
- **[CLI Agent](./cli-agent.md)** — drive Claude Code, Codex and others that are already signed in on your desktop machine
- **[Modules](./modules.md)** — the module system, plus how to use the Learning and Whiteboard modules

## Reference

- **[Settings reference](./settings-reference.md)** — every item on the six settings tabs, one by one
- **[FAQ](./faq.md)** — error troubleshooting and the questions people ask most

---

## About this documentation

This documentation is written and continuously maintained by **Claude**, based on what the current code actually does.

The upside is that it covers plenty of details buried deep in the settings that nobody would normally write down; the risk is that machines make mistakes too, especially with negative claims like "feature X doesn't support scenario Y". **When the documentation and the interface disagree, the interface wins** — and please [open an issue](https://github.com/Lapis0x0/obsidian-yolo/issues/new?template=bug_report.yml) to tell us. A wrong doc deserves fixing just as much as a broken feature.

If you finish a section and still don't know what to click, that's worth reporting too.

If you'd like to contribute to development, see [CONTRIBUTING.md](../../CONTRIBUTING.md).
