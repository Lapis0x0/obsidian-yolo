# Settings reference

A quick look-up of what every setting does, in the order the interface shows them. If you want to know how a feature actually works, follow the link to its own page.

The settings page has six tabs: **Models / Agent / Sparkle / Knowledge / Modules / Others**.

---

## Models

See [Models and providers](./models.md).

### Providers

A list of provider cards. Drag to reorder, click a header to expand it and see the models underneath.

Fields in the **provider editor dialog**:

| Field | What it does |
|------|------|
| ID | Local identifier only, not an API-side field |
| API key | Some local providers don't need one — leave it empty |
| Base URL | A third-party or self-hosted endpoint. **Preview:** shows the full assembled address |
| No stainless headers | Fixes CORS errors caused by `x-stainless-*` |
| Use Obsidian requestUrl | Bypasses CORS, at the cost of losing streaming responses |
| Network request method | Auto (recommended) / Browser request / Obsidian built-in request / Desktop direct connection |
| Response streaming mode | Auto (default) / Streaming / Non-streaming |
| Prompt caching | Anthropic-family only, on by default. Writing to the cache costs a premium, reading from a hit is much cheaper |
| Custom headers | Key-value pairs, as many rows as you want |

> Deleting a provider **cascades**: every chat model and embedding model under it is deleted too, and the related vector data is wiped.

**Chat models** are editable row by row, and the header has a **Connectivity Test**. A model that is currently assigned as the Default chat model or the Conversation title model can't be deleted or disabled.

**Model editor** fields: Model ID, Display name, Model type (the reasoning tier), Input modality, Built-in provider tools, Context window tokens, Max output tokens, Request parameters, Custom parameters.

### Default model policies & prompts

| Setting | Default | What it does |
|------|------|------|
| Default chat model | — | Used by every chat surface |
| Conversation title model | — | Used to auto-name conversations; a cheap small model is the right fit |
| Enable automatic recovery | On | When a streaming request fails, retry once without streaming |
| Primary request timeout | 60 seconds | Heavy thinking models hit this easily — raise it |
| Global system prompt | Empty | Prepended to every conversation. **Supports `![[Note name]]` to embed a note's full text** |
| Chat title prompt | Empty | Leave empty to use the built-in default |

---

## Agent

See [Tools and permissions](./tools-and-permissions.md) and [Agents and subagents](./assistants.md).

### Global capabilities

Two cards, **Tools** and **Skills**, each with a manage button.

The **Manage tools** dialog lists every built-in capability in three groups — **Vault / Context & Memory / External**. The switches here are a global gate: turn one off and no Agent can use it.

Some capabilities have a gear button leading to their own settings: web search (`Configure web search providers`), the analysis sandbox (`Configure analysis sandbox`, with its sub-permissions), terminal commands (`Configure terminal command`, with the `Blocked command prefixes` list), and subagents (`Configure subagent models`, with the model pool).

At the bottom of the dialog sits **MCP servers** management. **The whole block is hidden on mobile.**

The **Manage skills** dialog: Initialize Skills system, Refresh, Import Skill (drag and drop, or a GitHub link), bulk delete, and a per-skill enable toggle.

### Agents

A grid of Agent cards, drag to reorder. The built-in **Default** can't be deleted.

The Agent editor has four tabs:

**Profile** — Name, Description, Icon, Model (optionally **Follow default model**), System prompt, and three toggles:

| Toggle | Default | What it does |
|------|------|------|
| Focus sync | On | Lets it see which note / PDF page / web page position you're currently looking at |
| Current time awareness | On | Injects the time you sent the message |
| Load project instruction files | Off | Automatically loads `AGENTS.md` and `CLAUDE.md` from the vault root |

**Tools** — Enable tools, Include built-in tools, plus the enable state and approval level of each capability. MCP servers additionally get a disclosure mode (On demand / In context) and an approval mode. A token estimate sits at the top.

**Skills** — per-skill enable, plus how it loads (Full inject / On demand).

**Workspace** — the **Limit autonomous working range** toggle and a scope editor. **Read the note at the bottom: when terminal commands or a third-party MCP are enabled this range can be bypassed, so it is not a security boundary.**

### Agent capabilities

Four collapsible cards, all of them global settings:

**Image reading**

| Setting | Default | What it does |
|------|------|------|
| Image reading | On | Turning it off hides the three settings below |
| Fetch external image URLs | **Off** | Also fetches image-host / CDN links found in Markdown. 5-second timeout per image, anything over 10MB is skipped. Off by default because it sends requests to third parties |
| Image compression | On | |
| Compression quality | 85 | **Controls size and quality at the same time**: 60 means scaled to 60% of the original dimensions *and* 60% quality — not two separate knobs |

**Context compaction**

| Setting | Default | What it does |
|------|------|------|
| Automatic context compaction | **Off** | |
| Compaction threshold mode | — | Absolute prompt tokens / Fraction of context window |
| Prompt token threshold | 100000 | Used in absolute mode |
| Context window usage (%) | 80% | Used in fraction mode; needs the model's context window value to be filled in |

> Hitting the threshold **nudges the Agent to compact**. The plugin doesn't hard-truncate anything.

**External agent access** — lets an outside MCP client use your vault the other way round. **Desktop only**, default port 28124. See [MCP](./mcp.md#expose-yolo-to-external-agents).

> The token is only generated the first time you turn this on; there is no separate regenerate button. If you need a new one, toggle it off and back on.

**CLI runtimes** — **desktop only**. Point each of the six CLIs at its executable, or leave it empty for auto-detection. Stored on this device only, never synced with the vault. See [CLI Agent](./cli-agent.md).

### Notifications

> In the interface this block lives at the **very bottom of the Agent tab** (its translation keys are under the etc namespace, which makes it easy to look in the wrong place in the code).

| Setting | Default |
|------|------|
| Enable notifications | **Off** |
| Notification method | Sound only |
| Notification timing | Only when unfocused |
| Notify when approval is required | On |
| Notify when a task finishes | On |

---

## Sparkle

See [Sparkle](./sparkle.md).

### Snippets

Stored in `YOLO/snippets.md`, triggered by typing `/` in the chat input. The first time, click **Initialize snippets** to create the template.

### Quick ask

| Setting | Default |
|------|------|
| Enable quick ask | On |
| Auto dock to top right | On |
| Trigger character | `@` (1–3 characters) |
| Context before cursor (chars) | 5000 |
| Context after cursor (chars) | 2000 |

There's also a **Continue writing presets** entry point for managing the quick actions of the Write mode (name, prompt, category, icon, drag to reorder). Quick actions can only be deleted — there's no "hide but keep" switch.

### Cursor chat

The toolbar that floats up after you select text. You can define your own actions, each with an execution method: Quick Ask ask / Quick Ask rewrite / Add to chat input / Add to chat input and send.

**Every custom action is automatically registered as an Obsidian command** (prefixed `[Cursor Chat]`), so you can bind a hotkey to it individually.

### Tab completion

| Setting | Default | What it does |
|------|------|------|
| Enable tab completion | **Off** | This is the most common reason Sparkle "does nothing" |
| Completion model | Follows the Write model | A small, fast model is the right fit |
| Request timeout (seconds) | — | 1–120 seconds |
| Tab completion constraints | Empty | Extra instructions, e.g. "write in English" |
| Triggers table | 6 built-in rules | Chinese and English commas, colons, line breaks, list items |
| Trigger delay (ms) | 3000ms | Minimum 200ms |
| Auto completion after idle | **Off** | |
| Auto completion idle delay (ms) | 3000ms | |
| Auto completion cooldown (ms) | 15000ms | |

> Finer knobs like Completion length live in the **Sparkle panel inside the editor**, not on this settings page.

---

## Knowledge

See [Knowledge base and search](./knowledge-base.md).

**The status bar at the top** changes with state: when indexing is off it shows an **Enable and index** button; when everything is running it shows how many documents are indexed, how many are pending update, the **Auto update** toggle, an **Update now** button, and a "…" menu (Rebuild all indexes / Manage index data / Disable indexing).

**Each knowledge base card** has four things to configure: Name, Description (handed to the model so it can decide which base to query), the scope to include, and the scope to exclude.

**Embedding model** is split into API models and a local shelf.

> After selecting an API model you **still have to click Set as current**. That extra step exists because changing the embedding model means rebuilding the entire index.

Local embedding is **desktop only**, with a CPU / GPU switch.

**Advanced settings** (global, not per knowledge base):

| Setting | Default | What it does |
|------|------|------|
| Index PDF files | On | Turning it off speeds up a large vault |
| Chunk size | 1000 | **You have to rebuild the index manually for a change to take effect** |
| Minimum similarity | 0.0 | |
| Limit | 10 | How many results each search returns |
| Embedding concurrency | 10 | 1–24. **If you hit 429 rate limits, lower it** |

---

## Modules

The left-hand navigation is **Manage modules** and **Runtime components**, and below that the settings of each enabled module.

There are four **runtime components**: Tokenizer, PDF engine, Bash engine, Embedding engine (desktop only).

> The runtime component switch controls **whether the component exists**; the switch in Manage tools controls **whether the tool is visible to the AI**. Similar names, different things.

See [Modules](./modules.md) and [Tools and permissions](./tools-and-permissions.md#runtime-components).

---

## Others

### Support the project

Star YOLO, Afdian (CN), Buy Me a Coffee, plus Report Bug and Feature Request links (they come pre-filled with your version and system information).

### Interaction

| Setting | Default | What it does |
|------|------|------|
| Ribbon icon opens chat in | Right sidebar | Or New tab / Right split / New window (desktop only) / Last used location |
| Use Enter to start a new line | Off | By default Enter sends. Turn it on and Cmd/Ctrl+Enter sends instead |
| Mention display position | Inside input box | Or Top badges |
| @ file context injection mode | **Light mode** | Light mode only injects the path, properties and structure, encouraging the AI to read on demand. **This one directly affects token usage** |
| Chat apply behavior | Review before apply | Switch it to Write directly to file and Apply no longer asks for a second confirmation — a risk switch |
| Keep selection block highlight | On | |
| Chat UI scale | 100% | 70%–150% |

### Chat export

| Setting | Default |
|------|------|
| Export thinking process | Off |
| Export tool calls | Off |

### Maintenance

| Setting | Default | What it does |
|------|------|------|
| Update notifications | On | Turn it off and neither the plugin itself nor its modules will tell you about new versions |
| Auto-download updates | On | Only works on desktop, and only when the plugin folder is writable |
| Export settings / Import settings | — | For moving to another vault |
| **YOLO base folder** | `YOLO` | A path relative to the vault. Changing it is a **move operation** — see below |
| Enable LLM request debugging | Off | Adds a Debug button to every message so you can inspect the raw request and response |

Watch out with the **YOLO base folder**: it can't start with `/`, and it can't be a hidden folder (anything starting with `.` is rejected). Changing it makes the plugin try to move the contents of the old folder to the new path, and **if the target already exists and isn't empty it refuses and keeps the old setting**. This is a high-risk operation — back up first.

The contents of **LLM request debugging** only live in memory for the current session and are cleared when you restart Obsidian. Exports have API keys redacted, **but they still contain the raw conversation** — check them yourself before sharing.

### Destructive actions

All of them ask for a second confirmation:

| Action | What it does |
|------|------|
| Clear chat history | Deletes every conversation and message |
| Clear chat snapshots and cache | Deletes context snapshots, edit snapshots and timeline height cache, **not the messages themselves**. Opening an old conversation for the first time afterwards is slower — that's not data loss |
| Reset providers and models | Restores the default configuration, **overwriting rather than merging** |
| Reset agents | Deletes every custom Agent, keeping only Default |
| Reset settings | Factory-resets everything; it's the last item on the whole page |
