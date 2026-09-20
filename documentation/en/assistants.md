# Agents and subagents

An Agent is a reusable configuration bundle: a persona, a model, which tools it can use, which skills it can read, which folders it can wander into. Set one up and you can switch to it in chat with a single click.

> **About the name**: the settings page calls this an **Agent** — the create button reads `New agent` and the list is headed `Agents`. In the chat interface the selector and the `@` menu category call it an **Assistant**. They're the same thing; this page says Agent throughout.

Where to configure: **Settings → YOLO → Agent → Agents**.

## You already have one

There's a built-in Agent called **Default** that **can't be deleted**. It's what you're using when you haven't configured anything.

## Creating an Agent

Click **New agent** to open the editor. Four tabs down the left: **Profile / Tools / Skills / Workspace**.

### Profile

- **Name**, **Description**, **Icon**
- **Model** — pick a specific model, or choose **Follow default model**
- **System prompt** — this Agent's persona and way of working. The expand button in the top right opens a full-screen editor (Esc closes it)

The system prompt supports `![[note name]]` to **embed a whole note**. Writing long conventions, glossaries and project background into notes and referencing them is far easier to maintain than stuffing a wall of text into the box.

Below that are three switches:

| Switch | Default | What it does |
|------|------|------|
| **Focus sync** | On | Lets the AI see which note you're looking at, which page of a PDF, where you are on a web page |
| **Current time awareness** | On | Injects the time you sent the message into the model |
| **Load project instruction files** | Off | Automatically loads `AGENTS.md` and `CLAUDE.md` from the vault root as project instructions |

**Load project instruction files** exists for compatibility with the project convention files used by Codex, Claude Code and Cursor. If your vault doubles as a code repository, or you've already written an `AGENTS.md`, turning it on reuses what's there.

> The editor has **no** temperature, Top P or other sampling parameters. Those are configured on the model itself ([Models and providers](./models.md#model-parameters)), not at the Agent layer.

### Tools

Two master switches first: **Enable tools** and **Include built-in tools**.

Below them, every capability is listed by category. Each one can be enabled individually and given an approval level (Full access / Require approval / Approve dangerous operations). Connected MCP servers are listed here too, and can be expanded to see each tool they provide.

The top of the panel shows the number of enabled tools and a rough **token estimate** — tool definitions occupy context, so the more you enable the more every turn costs, and that number helps you weigh it up.

MCP servers get two extra dropdowns:

- a disclosure dropdown — **On demand** puts only a tool name in the system prompt and loads the full definition when the model wants to use it; **In context** carries the full definition every turn. For servers with lots of tools, on demand saves a good deal of tokens
- an **Approval** dropdown — the same approval levels as above

> A capability you turned off in the global **Manage tools** doesn't appear here at all. Global is the gate in front — see [Tools and permissions](./tools-and-permissions.md).

### Skills

Lists every skill, each of which can be enabled for this Agent individually, with the loading mode overridden:

- **Full inject** — the skill body enters context every turn
- **On demand** — only the name and description are supplied, and the body is loaded when the model judges it necessary

There's a token estimate at the top here too, along with a count of how many are full-inject and how many are on-demand. Skills disabled globally don't show up here.

How to write a skill: see [Skills](./skills.md).

### Workspace

Turn on **Limit autonomous working range** and you can specify which folders this Agent may browse and edit on its own.

Three rules you have to understand (**especially the third**):

1. Files you reference with `@` and the file currently open are **never restricted** — the range limits what the AI goes digging for itself, not what you hand it
2. Memory folders and authorised skill folders are **always exempt**
3. **This is not a security boundary**: if this Agent has terminal commands or third-party MCP tools, the range can be bypassed

The full explanation of rule three is in [Tools and permissions](./tools-and-permissions.md#workspace-scope-limiting-where-it-can-wander-on-its-own). In short: real isolation comes from not giving it the terminal and untrusted MCP tools, not from this range setting.

## Switching in chat

There's an Agent selector above the input box, and you can also type `@` in the input box and pick the **Assistant** category. Choosing **Default** means no Agent is bound and you talk to the global system prompt directly.

The Quick Ask panel can be pointed at its own Agent, separate from the one the main chat uses — so your main chat can run a rigorous research Agent while Quick Ask runs a light, fast writing assistant.

## How to split Agents up sensibly

The value of an Agent is that it **bundles persona and permissions together**, not that it swaps out a prompt. A few splits that genuinely pay off:

- **By trust level**: a read-only "asking" Agent (no editing capability) and a hands-on "tidying" Agent (editing plus terminal). Switch over only when you want it to act, and the rest of the time you don't have to worry about accidents
- **By project**: one Agent per project, workspace scope locked to that project's folder, the project's background note embedded in the system prompt
- **By language or style**: a writing assistant pinned to one set of style requirements

---

# Subagents

A subagent is a temporary helper that the main Agent **sends out itself** while working on a task, to handle a subtask that can be completed independently.

## You don't trigger it manually

You can't "start a subagent" directly. What you can do is give the main Agent the capability and let it decide when to use it.

Setup:

1. In the **Tools** tab of the Agent editor, enable **Delegate Subagent** (off by default)
2. In that capability's settings, configure the **Subagent model pool**: add a few of your existing models to the pool and set a preferred model. When the main Agent doesn't specify a model, the preferred one is used

## How it relates to the main conversation

Understanding these points saves you a lot of confusion:

**A subagent cannot see the main conversation's history.** It's an isolated, throwaway session, and the main Agent has to write everything necessary into the delegation instructions. So if a subagent comes back with something wildly off target, it's usually because the main Agent didn't spell out the context.

**It's asynchronous.** Delegating returns a task ID immediately, the subagent runs in the background, and the result is handed back to the main Agent when it's done. **The result does not automatically become an answer to you** — the main Agent decides how to use it and whether to tell you about it.

**It inherits the main Agent's model and authorised tools**, with two exclusions: it can't delegate subagents of its own (no infinite nesting), and it can't use tools that require interacting with you (asking the user a question, for instance).

**Its tool calls still need approval** through exactly the same flow as ordinary tools, just aggregated into an `Awaiting approval` card where you can `Approve all` or `Reject all`.

When a subagent card appears in the conversation, you can expand it to see its activity log, how many tool calls it made and how many tokens it burned.

## When it's worth enabling

Subagents suit work that can be "stated clearly up front and reported back as a conclusion" — something like "summarise each of these twenty notes in three sentences". The main Agent delegates and carries on with something else, without pulling the full text of twenty notes into its own context. **That's the real payoff: isolating context consumption.**

Conversely, a task that needs repeated back-and-forth with you, or that leans heavily on the current conversation history, only gets worse when handed to a subagent.

---

## Related

- Tool capabilities and approval: [Tools and permissions](./tools-and-permissions.md)
- Skills: [Skills](./skills.md)
- Getting an Agent to remember you across conversations: [Memory](./memory.md)
