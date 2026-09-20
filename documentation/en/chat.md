# Chat

Chat is YOLO's main surface. It's where you ask questions, let it read and write notes, and run multi-step tasks. This page covers everything the chat surface can do.

If you haven't configured a model yet, start with [Getting started](./getting-started.md).

## Opening a chat

YOLO has exactly one chat view, but it can be opened in four places: the **sidebar**, a **new tab**, a **right split**, or a **separate window**. All four are functionally identical — they only differ in how they use your screen. The sidebar suits asking while you write; a separate window is handy when you want the agent to grind through a long task while you keep working in the main window.

There are three ways to open it:

- **The ribbon icon on the left**: clicking the YOLO icon opens it in the default location. **Right-click the icon** to pick a location for this one time, without changing your default.
- **The command palette**: search for `Open chat`, `Open new chat (new tab)`, `Open new chat (right split)`, `Open new chat (new window)`.
- **The menu inside the chat view**: once a chat is open, you can move it elsewhere from its menu.

> **YOLO ships no keyboard shortcuts.** All of the commands above are unbound on a fresh install. If you want a hotkey to summon the chat, go to Obsidian's **Settings → Hotkeys**, search for the command name and bind it yourself. The same goes for every command mentioned below.

## Giving it your notes: mentions

By default the chat has no idea which note you're looking at. To let it read something, you have to mention it explicitly.

### The @ menu

Type `@` in the input box and the mention menu opens, with five categories:

| Category | What it does |
|------|------|
| **File** | Mention a note. The top of the menu usually offers **Current file** directly — the one you'll use most |
| **Folder** | Mention a whole folder |
| **Mode** | Switch straight to Ask / Agent / Max |
| **Assistant** | Switch the agent you're currently using |
| **Model** | Switch the model for this turn |

Keep typing after the `@` and it fuzzy-searches across all categories, so you don't have to pick a category first.

Modes, agents and models live in the `@` menu so you can switch them mid-sentence, without moving your hand to a dropdown somewhere else.

### Web pages, images and files

These three **don't go through the `@` menu**; each has its own entry point:

- **Web pages**: paste a URL straight into the input box and it turns into a web page mention. Nothing else to do.
- **Images**: use the "+" button in the input box, paste an image from your clipboard, or drag an image file into the input area.
  This requires the **current model to support image input**. If the model doesn't have image capability enabled, uploading will prompt you to turn on the Vision modality in the model settings first.
- **File attachments**: also the "+" button. Supports PDF, Word / PPT / Excel, and plain-text formats like txt, md, csv, json, yaml, xml and log.
  PDFs get special treatment: for models that read PDFs natively (Anthropic, Gemini) YOLO hands over the original file; it also extracts the text as a fallback, so the PDF still works if you switch to a different model.

Two more small but handy entry points: on a PDF you can use `Capture PDF region to chat` to marquee a region and send it as an image; and in the file list you can **right-click** a note or folder for `Add file to chat` and `Add folder to chat`.

## Three modes

The mode decides **what YOLO is allowed to do**. It's the single most important concept in the plugin — pick the wrong one and you'll either think "why can't it do anything?" or "why is it touching my files?".

Switch modes in the dropdown next to the input box, or with `@` → Mode.

### Ask — for questions, polish and rewrites

Mostly read-only. It can read notes, search the knowledge base, search the web and find files in the vault, but it **cannot edit the body of your notes**.

One counter-intuitive detail deserves its own mention: in Ask mode YOLO can still run **file management operations** like `mkdir`, `mv` and `rm` (create folders, move files, delete files). So Ask is not the same as "strictly read-only" — it won't change the words in your notes, but it can move the files around. Those dangerous operations **require your approval every single time**, and cannot be set to "always allow".

### Agent — tools enabled, for multi-step work

On top of Ask, it adds four capabilities:

- **Editing note content** (targeted edits or a full rewrite)
- **Task List**: for multi-step work it writes its own plan and works through it item by item
- **Analysis Sandbox**: runs JavaScript in an isolated environment for calculations and bulk statistics
- **Terminal Commands**: a real local terminal (desktop only, approval required by default)

This is the tier you use day to day when you want AI to tidy up notes, reformat things in bulk, or write a new note from source material.

### Max — direct access to local files and the terminal (desktop only)

Max breaks out of the vault boundary: it can read and write **files at any path on the machine**, not limited to your vault and not limited to Markdown. Its terminal capability is more complete too — it's the only mode where the terminal can be set to "always allow".

Good for jobs that cross the Obsidian boundary, like "sort that pile of PDFs on my desktop into the vault". **The cost is that it can reach far beyond your notes**, so make sure you understand that before using it.

> If you're using an external CLI agent (Claude Code and friends), you'll also see a **Plan** mode: it explores and proposes a plan first, and only acts once you confirm. See [CLI Agent](./cli-agent.md).
> Once modules are installed, they may register modes of their own too — the Whiteboard module's dedicated mode, for example.

### YOLO auto-approve

Agent and Max each have a sub-switch underneath them; turn it on and **tool calls are no longer confirmed one by one**. It isn't a fourth mode, it's a gear layered on top of those two modes.

The first time you turn it on you get a risk warning and have to tick the acknowledgement box:

- Tool calls are no longer confirmed individually (the blocked command prefix list still applies)
- It may burn a lot of tokens
- Back things up beforehand

Max plus auto-approve is the most permissive combination there is: any path on the machine, plus writing terminal commands, all without approval. Only use it when you're completely clear about the boundaries of the task.

## Switching models and agents

**The model** can be switched any time in the dropdown above the input box. It only affects later messages; already-generated history doesn't change.

**An agent** is a persona config bundling "system prompt + tool preferences + skills", independent of both the model and the mode. You could have an "academic writing" agent locked to a particular prompt, then pair it with any model and any mode. See [Agents and subagents](./assistants.md).

> In the settings this concept is called **Agents**, while the switcher dropdown in the chat says **Assistant** — same thing, two names.

## Sending messages

By default **Enter sends and Shift+Enter starts a new line**.

If you often write multi-line messages, turn on **Use Enter to start a new line** in the settings and the behaviour flips: **Enter starts a new line, Cmd/Ctrl+Enter sends**.

On mobile Enter always starts a new line, so you can't send by accident.

**You can keep typing and sending while the agent is running** — messages queue up and go out once the current turn finishes. Two things will stop you, though: if a tool is waiting for approval you have to approve or reject it first, and if the model is asking you a question you have to answer it first. When you abort a chat, queued messages that haven't been sent are returned to the input box rather than lost.

## While a chat is running

### Tool approval

With auto-approve off, every tool call the model makes shows up as a tool call card in the chat, offering these choices:

- **Allow** — let this one through
- **Reject** — don't run it; the model receives the rejection and carries on
- **Always allow this tool** — never ask about this tool again
- **Allow for this chat** — stop asking for the rest of this chat only
- **Abort** — stop the whole turn

Dangerous operations like deleting and moving pop up an extra confirmation that lists the exact paths to be deleted or moved. Delegating to a subagent has its own set of approval buttons (Approve / Reject / Approve all / Reject all / View parameters).

The model may also turn around and ask you something — the card is titled **The agent has questions for you**, with at most three questions at a time, which may be single choice, multiple choice or free text. Submit your answers with Cmd/Ctrl+Enter, or cancel the round of questions.

### Landing changes in your notes

When the model edits a note it doesn't just overwrite it. It shows you a diff first, and nothing is written until you click **Apply** (which you can also abort partway through).

There's also a finer-grained **Review changes** view where you decide hunk by hunk: accept this change / reject this change / keep this change / revert this change / accept both, with **Previous change** and **Next change** to jump between them, plus accept-all and reject-all in one go.

Under each reply there's an **edit summary** showing how many files that turn touched and which were created or deleted. You can undo the whole thing, or undo just one file.

> **Undo relies on a local snapshot, and snapshots do not sync with your notes.** That means you can't undo these changes from another device; and if the file has been modified in the meantime, or the snapshot is gone, the undo fails and tells you so. For changes that genuinely matter, rely on Git or Obsidian's own file recovery.

### Stopping, retrying, editing a question, branching

- **Stop generation**: the button by the input box. Also, **Esc works globally** — pressing it cancels every in-flight AI continuation and rewrite task.
- **Regenerate**: under each reply.
- **Editing a message you already sent**: click your own message to edit it; resubmit and the conversation after it re-runs on the new content.
- **Create branch from here**: create a new branch chat from a given reply, keeping the context up to that point and then going in a different direction. Useful for comparing two lines of thinking; the original chat is unaffected.

## Managing chats

### History

The clock icon at the top opens the history list; the command `Open chat history` does the same (only available while you're in the chat view).

In the list you can search, pin, rename, archive and delete (click twice to confirm), and filter by category — **My conversations** and **Task conversations** are kept separate, and task conversations can be filtered further by source, including the ones started by an **External Agent**.

### Export

The download icon at the top, or the command `Export current conversation to vault`, saves the whole chat as a Markdown note in your vault. Only chats that have already been saved can be exported.

### See how much context is used

Near the input box there's a **Context window usage** readout; open it for the breakdown: how many tokens go to the system prompt, tools, rules, skills, memory, conversation and reasoning, plus the cache hit rate from the previous turn.

Two things to know: this is a **local estimate** and will differ from what the server actually bills you; and the percentage only shows up if you've configured a context window limit for the model — otherwise it tells you to go fill that in in the model settings.

### Compacting the context

When a chat gets too long, type `/` in the input box and pick **Compact Context**: earlier history is squeezed into a summary, and the current task continues in a fresh context window. YOLO also compacts automatically when the context genuinely won't fit.

After compaction a divider appears in the chat marking that everything above has been summarized and everything below continues from the summary, along with the estimated token count after compaction.

Compaction requires that nothing is currently generating and no tool is waiting for approval; otherwise it asks you to deal with those first.

---

## Next

- Use AI without leaving the editor: [Sparkle](./sparkle.md)
- Get answers grounded in your whole vault: [Knowledge base and search](./knowledge-base.md)
- Work out exactly what it can do to your files: [Tools and permissions](./tools-and-permissions.md)
