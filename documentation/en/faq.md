# FAQ

## Install and startup

### Nothing happens after I install it, or it clashes with another plugin

**YOLO can't be enabled at the same time as [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer).** YOLO is a fork of it, and the two conflict with each other. Disable or uninstall Smart Composer first.

### Why are there no keyboard shortcuts at all

**YOLO ships no default hotkeys.** On a fresh install every command is unbound — go to Obsidian's **Settings → Hotkeys**, search for the command name and bind it yourself.

This is deliberate, so nothing fights with the hotkeys you already have.

---

## Models and requests

### I'm getting CORS errors

Try these in order:

1. Turn on **No stainless headers** in the provider settings — that fixes errors caused by headers like `x-stainless-os`
2. If that's not enough, turn on **Use Obsidian requestUrl** to bypass CORS. **The cost is that streaming responses get buffered and arrive all at once**, so no more typewriter effect
3. On desktop you can also change **Network request method** to **Desktop direct connection**

### Replies stopped appearing word by word

You almost certainly turned on **Use Obsidian requestUrl**. It buffers the whole response — that's the unavoidable price of bypassing CORS. If your CORS problem is solved, turn it back off.

Also check whether **Response streaming mode** got set to Non-streaming.

### My reasoning model keeps timing out

Go to **Models → Default model policies & prompts → Primary request timeout**. The default of 60 seconds is short for heavy thinking models, so raise it.

Leave **Enable automatic recovery** next to it switched on — it retries once without streaming when a streaming request fails.

### I can't delete a model, clicking does nothing

That model is currently set as the **Default chat model** or the **Conversation title model**. The interface doesn't grey the button out in advance; you only get the message after clicking. Point the default at a different model first, then come back and delete it.

### Can I use my Claude subscription for ordinary chats

Yes. Add **Claude OAuth** as a provider, sign in, add models to it as usual, and pick them in chat like any other model. Underneath it goes through the Claude Agent SDK rather than an HTTP endpoint, so transport-layer options like Network request method don't apply to it.

This is a different thing from Claude Code in [CLI Agent](./cli-agent.md) — that one drives a CLI process on your own machine.

---

## Chat

### Why doesn't it know which note I'm looking at

Chat does not read your currently open file by default. Reference it with `@` — the first item in the menu is usually Current file.

You can also turn on **Focus sync** in the Agent editor so it can see where you are.

### It can read my notes but can't edit them

You're probably in **Ask** mode. Ask can't edit the body of a note — switch to **Agent**.

Note that Ask isn't strictly read-only either: it can run file-management operations like `mkdir`, `mv` and `rm`. It just won't change the words inside your notes.

### I can't find Max mode

Max is **desktop only**. On mobile the mode falls back to Agent automatically.

### Context window usage shows tokens but no percentage

That model has no context window tokens configured. Fill it in in the model settings and the percentage can be calculated.

### Undo failed

Undo relies on **local snapshots**, and snapshots don't sync with your notes. Three things break it:

- You're trying to undo a change from another device
- The file was modified in the meantime
- The snapshot has expired and is gone

For anything that actually matters, rely on Git or Obsidian's own file recovery.

### Can I send a message while it's generating

Yes, it queues up. Two situations block it: a tool waiting for your approval has to be dealt with first, and a question from the model has to be answered first.

If you abort the conversation, any queued message that hasn't been sent goes back into the input box. Nothing is lost.

---

## Sparkle

### Tab completion does nothing at all

**Tab completion is off by default.** Go to **Settings → YOLO → Sparkle → Enable tab completion** and turn it on.

If it still doesn't fire after that, check two things: whether the rules in the triggers table actually match how you type (by default it only fires after a comma, colon, line break or list item), and whether turning on **Auto completion after idle** helps — that fires after you stop typing regardless.

### Typing `@` doesn't open Quick Ask

Quick Ask only fires when you type the trigger character **at the start of an empty line**. Typing `@` in the middle of a line with content in it is just ordinary text.

If you genuinely need `@` at the start of lines, change the trigger character in the settings.

---

## Knowledge base

### I get 429 / rate limit errors while indexing

Lower **Embedding concurrency**. It defaults to 10, which is too high for free tiers or services with a per-minute quota (Azure S0, for instance); 2–3 usually behaves.

### I changed the chunk size and search results didn't change

A chunk size change **only affects content indexed afterwards**. Existing vectors aren't recomputed.

Run **Rebuild entire vault index** from the command palette.

Same goes for switching the embedding model — that also requires a rebuild.

### I selected an embedding model but it didn't take effect

After picking it in the dropdown you **also have to click Set as current**.

That step isn't redundant: switching the embedding model invalidates every existing vector, which means rebuilding the whole vault. The extra click is there so a slip of the hand doesn't kick off a full rebuild.

### Where do I download local embedding models, and can I delete them

In the embedding model area of the Knowledge tab, on the **Local (on-device)** shelf. **Desktop only.**

The model files live in the plugin's own folder, not inside your vault, and they don't sync. To delete one, confirm twice on the model entry.

---

## Tools and permissions

### Can I use workspace scope as a security sandbox

**No.** If the Agent has terminal commands or third-party MCP tools enabled, the scope can be bypassed — the terminal runs a real shell and MCP runs in an external process, and neither goes through YOLO's path checks.

Think of it as "keep the AI focused on the relevant folders", a constraint on its initiative, not "lock the AI in a cage".

If you need real isolation, the way to get it is to not give that Agent a terminal or untrusted MCP servers — not to lean on the scope setting.

### Why doesn't it ask me before searching the web

**Web search defaults to Full access**, so there's no prompt. If that bothers you, go to Manage tools and raise its approval level, or just turn it off.

### If I turn on auto-approve, will it `rm -rf` my stuff

The blocked command prefix list **applies in every case**, including auto-approve mode. By default it blocks commands starting with `rm`, `dd`, `mkfs`, `fdisk`, `shutdown`, `reboot`, `poweroff` and `halt`.

But that's only the last line of defence, and it's no substitute for backups. Before you turn on auto-approve, make sure your vault is in Git.

### MCP doesn't work on my phone

**MCP is desktop only** — not just the local-process kind. Remote HTTP / SSE / WebSocket servers are disabled on mobile too.

### External agent access says the port is taken

Default port 28124 is occupied — most often by a plugin like Local REST API. Just pick another port.

---

## Data and migration

### Can I rename the folder YOLO creates in my vault

Yes. **Settings → YOLO → Others → Maintenance → YOLO base folder**, which defaults to `YOLO`.

Be aware this is a **move operation**: after the change the plugin tries to move the contents of the old folder to the new path. If the target path already exists and isn't empty, it refuses and keeps the old setting. Back up first.

It also can't be a hidden folder (it can't start with `.`), or Obsidian won't index it.

### How do I move my configuration to a new computer

**Settings → YOLO → Others → Maintenance → Export settings**, export to JSON, then import on the new device.

Be aware that some things are **local to the device and don't travel**: CLI executable paths, CLI session history, local embedding model files, and runtime components.

### Will clearing snapshots lose my conversations

No. **Clear chat snapshots and cache** deletes context snapshots, edit snapshots and the timeline height cache. **The chat messages themselves are untouched.**

Opening an old conversation for the first time after that is a bit slow (it has to rebuild the context and layout). That's normal, not corruption.

The one that actually deletes conversations is **Clear chat history**.

---

## Still stuck

Open an issue:

- 🐛 [Report a bug](https://github.com/Lapis0x0/obsidian-yolo/issues/new?template=bug_report.yml)
- ✨ [Suggest an idea](https://github.com/Lapis0x0/obsidian-yolo/issues/new?template=feature_request.yml)

Including your Obsidian version, operating system, plugin version, reproduction steps and what actually happened helps the most.

If the problem is in a model request, turn on **Settings → YOLO → Others → Maintenance → Enable LLM request debugging**, reproduce it once, and export the raw request from the Debug button on the message. API keys are redacted in the export, **but it contains the raw conversation** — check it yourself before pasting it anywhere.
