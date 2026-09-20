# Sparkle

Sparkle is a set of AI features that **never make you leave the editor**: completion at the cursor, rewriting the paragraph you selected, calling up a floating panel to ask a question.

It runs on a completely different path from [Chat](./chat.md) — single-turn generation, low latency, no tool calls and no approvals. That's why it's fast, but it also means it won't read your other notes and won't touch other files.

Where to configure: **Settings → YOLO → Sparkle**.

## The Quick Ask panel

Ask something on the spot, rewrite something on the spot, and the result lands right at your cursor.

### How to open it

Two ways:

- **Type `@` at the start of an empty line** — the Trigger character can be changed in settings (1–3 characters). The character is removed as soon as it fires, and the panel pops up near the cursor
- **Command palette → `Trigger quick ask`**

By default the panel **auto docks to the top right** of the editor after you send a question, so it doesn't cover your text. Once you've dragged it manually, it stops following.

### The three modes

You switch between them with Tab inside the panel; they aren't three separate entry points:

| Mode | What it does |
|------|--------|
| **Ask** | Q&A with read-only access, same as Ask mode in the sidebar chat |
| **Agent** | Runs the Agent inside the same panel: it can read and write notes and work through multi-step tasks |
| **Write** | Skips the Agent and the tool chain and continues the text right at the cursor |

**Write mode can be sent with nothing typed in it** — it just keeps writing from the current context. You can also give it a specific instruction to steer the direction, like "now add three counterexamples".

### What to do with the result

The panel gives you: **Copy**, **Insert** (at the cursor), **Open in sidebar** (moves this conversation into the sidebar so you can keep going, handy when a quick question turns into a real one), **Stop**, and **Clear conversation**.

### How much context it sends

Quick Ask carries the text around your cursor: by default 5000 characters before (**Context before cursor (chars)**) and 2000 after (**Context after cursor (chars)**). Both are adjustable in settings.

### Continue writing presets

Write mode can have quick actions configured so you don't retype the same instruction every time. Click **Configure quick actions** in settings; each action gets a name, a prompt, a category (Suggestions / Writing / Thinking · inquiry · dialogue / Custom) and an icon, and you can drag them into the order you want.

There are nine built-in presets, and **Reset to default** brings them back if you've made a mess.

> Quick actions can only be deleted. There's no "hide but keep" switch.

## Tab completion

While you type, a grey suggestion appears at the cursor; press Tab to accept it.

> **Tab completion is off by default.** This is by far the most common reason for "why isn't Sparkle doing anything". Go turn it on in settings.

### When it fires

Two kinds of trigger, and you can have both on at once:

**Pattern triggers** (on by default) — a suggestion appears when the text in front of the cursor matches a rule. Six rules ship built in: Chinese and English commas, Chinese and English colons, a newline, and list-item prefixes (`- ` `* ` `+ `). In the **Triggers** table you can switch each rule on or off, add and remove rules, or change one to a Regex match.

**Idle triggers** (off by default) — **Auto completion after idle** fires once you stop typing for a while, 3 seconds by default. It has a 15-second cooldown so it doesn't interrupt you constantly.

You can also fire one by hand with the command palette's `Trigger tab completion`.

### Accepting and rejecting

| Key | What it does |
|------|------|
| `Tab` | Accept the suggestion |
| `↑` / `↓` | Cycle through multiple candidates |
| `Shift+Tab` / `Esc` / `Backspace` | Reject and clear the suggestion |

The command palette also has an `Accept completion` command, so you can bind it to a different key or call it from a plugin like Commander.

### The knobs you can turn

- **Completion model** — can be separate from your chat model. A small fast model is the right fit here; latency matters more than intelligence
- **Request timeout (seconds)** — 1 to 120
- **Tab completion constraints** — extra instructions attached to the prompt, like "write in another language" or "don't complete code blocks"
- **Trigger delay (ms)** — 200 ms minimum

> Those are the only basics on the settings page. Finer adjustments like Completion length live in the Sparkle panel inside the editor, not in the plugin settings.

## Selection rewrites

Select some text and a toolbar floats up (not the system right-click menu) with these actions:

| Action | What it does |
|------|------|
| **Add to chat** | Adds the selection as a quote in the current chat input box |
| **Add to sidebar** | Sends it to the sidebar chat, opening the sidebar if it isn't open |
| **Custom rewrite** | Type a rewrite instruction; only this selection changes |
| **Custom ask** | Ask a question about this piece of text |
| **Explain in depth** / **Provide suggestions** / **Translate to Chinese** | Built-in preset actions |
| **Adjust length** | Drag the handle to tighten or expand (table selections aren't supported yet) |

In the Custom rewrite input box, **Shift+Enter confirms**, Enter starts a new line, and Esc closes it.

A rewrite **only affects what's inside the selection** — it won't go after the whole document or other files the way the Agent would. If you edit the original text while waiting for the result and invalidate the selection, it'll ask you to select again.

### Custom quick actions

The **Cursor chat** block in settings is where you add and remove these quick actions. Each one takes a label, the instruction text, an execution method, and the Agent it's bound to.

There are four execution methods:

- **Quick Ask ask** — sends automatically
- **Quick Ask rewrite** — goes to a preview, where you can then choose between opening an input box or generating directly from the preset instruction
- **Add to chat input** — fills it in without sending
- **Add to chat input and send**

Every custom action is **automatically registered as an Obsidian command** (prefixed `[Cursor Chat]`), so you can give it its own key binding in the hotkeys settings.

## Similar notes

The Sparkle tab in the sidebar has a **Similar notes** panel. It runs a vector search based on the note you currently have open, lists the other notes related to it, and lets you expand a result to see the matching passage or insert a link at your cursor.

It depends on the [knowledge base](./knowledge-base.md) — you need an embedding model configured, and the current note has to already be indexed. When that isn't set up, the panel gives you the button to go and fix it.

## Esc cancels everything

Pressing **Esc** at any time cancels every AI continuation and rewrite still in flight. This is global, and it doesn't interfere with what Esc normally does otherwise (closing a dialog, for instance).

---

## Related

- For multi-step, cross-file work: [Chat](./chat.md)
- How to set the completion model and the continuation model: [Models and providers](./models.md#what-each-default-model-slot-is-for)
- The index that Similar notes depends on: [Knowledge base and retrieval](./knowledge-base.md)
