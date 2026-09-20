# Tools and permissions

This page answers one question: **what can YOLO actually do to my stuff, and how do I keep it in check.**

If you just want to feel safe quickly, remember three things:

1. **The mode sets the ceiling.** Ask can't rewrite the body of your notes, Agent can edit files in the vault, Max can touch any file on the machine.
2. **By default, editing files and running the terminal both need your approval.** You can switch that off, but that's a choice you make deliberately.
3. **Workspace scope is not a sandbox.** It constrains what the AI does on its own initiative, not what it is technically able to reach — the difference is explained below.

## How tools are organised

YOLO packages its abilities into 13 **tool capabilities**. The unit you enable, disable and set approval on is the capability, not the individual tool.

Where to manage them: **Settings → YOLO → Agent → Global capabilities → Tools → Manage tools**.

The switches here are a **global gate**: turn one off and no Agent can use it. Each Agent can narrow things further in its own config — the two layers are AND-ed together, so a capability that is on globally but off for a given Agent is still unavailable to that Agent.

### The full capability list

| Capability | What it does | Modes | Default | Default approval |
|------|--------|-------------|------|---------|
| **Read** | Read files in the vault, Skills, and open web pages | Ask / Agent | On | Full access |
| **Virtual terminal** | A sandboxed shell over the vault: `ls`/`grep`/`find` for searching, plus `mkdir`/`mv`/`rm` | Ask / Agent | On | Approve dangerous operations |
| **File Editing Toolset** | Patch a note or rewrite it wholesale | Agent only | On | Require approval |
| **Vault Search** | Semantic search plus keyword search, blended | All | On | Full access |
| **Web Search Toolset** | Search the web, fetch page content | All | On | Full access |
| **Ask User** | Pause and ask you when it doesn't have enough to go on | All | On | Full access |
| **Task List** | Break down and track multi-step work on its own | Agent / Max | On | Full access |
| **Prune Tool Results** | Drop old tool results out of the following context | All | Off | Full access |
| **Compact Context** | Squash earlier conversation into a summary | All | Off | Full access |
| **Analysis Sandbox** | Run JavaScript in an isolated environment for calculations and stats | Agent only | Off | Full access |
| **Terminal Commands** | Your machine's **real** terminal | Agent / Max | Off | Require approval |
| **Delegate Subagent** | Send an isolated, throwaway agent off to do a subtask | All | Off | Full access |
| **Local Filesystem Toolset** | Read and write files **anywhere on the machine** | **Max only** | On | Full access |

### Things people get wrong

**The "Virtual terminal" is not a real terminal.** It's a sandboxed shell reimplemented in JavaScript, mounted on your vault root, with no reach into the operating system's filesystem. The only capability that can actually execute commands on your machine is **Terminal Commands**, which is off by default, desktop-only, requires approval by default, and **cannot be set to "always allow"**.

**Ask mode is not the same as read-only.** The virtual terminal is on in Ask, which means Ask can run `mkdir`, `mv`, `rm` — it won't change the words inside your notes, but it can move and delete files. Each of those dangerous operations is asked about individually.

**Web search is allowed through by default.** So out of the box, searching the web and fetching pages won't prompt you. If that bothers you, go to **Manage tools** and raise its approval level or turn it off entirely.

**The "Local Filesystem Toolset" only exists in Max mode.** Agent mode can never get it. That's deliberate: Agent works through Obsidian's vault interface, Max is the identity that genuinely operates on local disk, and the two are mutually exclusive.

**The analysis sandbox's sub-permissions are enabled one by one.** Even with the sandbox turned on, `Allow Network Fetch`, `Allow Vault Read`, `Allow Open Web Page Read`, `Allow Knowledge Base Query` and `Allow External Scripts` are still separate switches, each with a risk confirmation the first time you enable it. `Allow External Scripts` is flagged **EXTREME RISK** — it can pull down and execute arbitrary remote JavaScript with the same privileges as a browser tab.

## Approval: staying in control when it wants to act

### Three approval levels

Every capability can be set to:

- **Full access** — no questions, just run it
- **Require approval** — stop and wait for your confirmation on every call
- **Approve dangerous operations** — only the virtual terminal has this one: read-only commands and `mkdir` go straight through, while `mv` and `rm` stop and ask, one at a time

The level is set per Agent in the **Agent editor → Tools** tab. External MCP tools are configured in the same place, per server.

### Your options when an approval prompt appears

- **Allow** — this one call only
- **Allow for this chat** — stop asking for the rest of this conversation
- **Reject** — you can attach a reason, which the model receives and adapts to
- **Abort** — stop the whole task

The virtual terminal and terminal commands **do not offer** "Allow for this chat", because they are deliberately designed so that per-call confirmation can't be skipped.

### Auto-approval (the YOLO switch)

Agent and Max mode each carry a **YOLO** switch. Turn it on and **no tool call in that mode is confirmed individually** any more.

The first time you enable it you get a risk dialog, **Please confirm before enabling YOLO Mode**, with a checkbox reading **I understand the risks above and accept responsibility for proceeding**. All three things the dialog warns you about are true:

- Tool calls are no longer confirmed one by one, but the **blocked command prefix list still blocks them**
- Running autonomously can burn a fair amount of tokens
- Back up first

**The block list applies under all circumstances**, auto-approval included. By default it blocks commands starting with `rm`, `dd`, `mkfs`, `fdisk`, `shutdown`, `reboot`, `poweroff`, `halt`. You can add and remove entries under `Configure terminal command` → `Blocked command prefixes`.

## Workspace scope: limiting where it can wander on its own

Where to set it: **Agent editor → Workspace** tab, turn on **Limit autonomous working range**, then mark what's included and excluded in the visual folder picker.

### Three rules you have to know

**One: anything you hand over yourself is unrestricted.** Files you reference with `@` and the file you're currently editing are always readable, even if they sit outside the range. That design is right — the range limits what the AI **goes digging for on its own**, not what **you pass to it**.

**Two: memory and Skill folders are always exempt.** Even if you never put them in the included range, the AI can still read and write its own memory and the Skills it has been granted.

**Three, and this is the big one — this is not a security boundary.**

> If this Agent has **Terminal Commands** or **third-party MCP tools** enabled, workspace scope can be bypassed.

The reason isn't hard to see: terminal commands run a real shell, and MCP tools run in an external process, and neither goes through YOLO's path checks. So think of workspace scope as **an autonomy constraint — "keep the AI focused on the relevant folders, don't let it rummage everywhere"** — and not as **an isolation mechanism that puts the AI in a cage**.

If you genuinely need isolation, the right move is to not give that Agent the terminal or untrusted MCP tools, rather than leaning on the scope setting.

One more thing: YOLO's own internal data folder (`data` under the base folder) is hidden from the AI no matter how the range is set. Accessing it returns "file does not exist" rather than "not permitted" — that way even its existence isn't leaked.

## Runtime components

Some capabilities depend on runtime components that are downloaded separately, managed under **Settings → YOLO → Modules → Runtime components**:

| Component | What it backs | What happens without it | Size |
|------|---------|-----------|------|
| **Tokenizer** | Counting context tokens | No accurate token budgeting | ~1MB |
| **PDF engine** | Extracting PDF text, rendering pages | PDFs can't be read | ~2.3MB |
| **Bash engine** | The virtual terminal | The virtual terminal tool is simply unavailable | ~1.3MB |
| **Embedding engine** | Running embedding models locally (desktop only) | Local embedding unavailable, retrieval falls back to a remote embedding service | ~0.5MB plus ~27MB of runtime assets |

These components are downloaded into the plugin's own folder. They are **not in your vault and are not synced**, and they don't show up in Obsidian's file list.

> Keep two layers apart here. The runtime component switch controls **whether the component exists at all**; the switch under **Manage tools** controls **whether the tool is visible to the AI**. Similar names, different things — turn off the Bash engine and the virtual terminal has no underlying support; turn off the virtual terminal under Manage tools and the engine is still there, the AI just can't use it.

The interface only offers Enable / Disable, and disabling does not delete the files that were already downloaded. To actually reclaim the space you have to clean out `runtime/` in the plugin folder by hand.

## How should I set this up

A few common positions and the config that matches:

**"I just want to ask questions safely"** — Ask mode, and don't touch any settings.

**"I want it to edit my notes, but I want to see every step"** — Agent mode, auto-approval off, file editing left on Require approval.

**"I trust it, let it run to completion"** — Agent plus auto-approval. Make sure your vault is in Git first, or at minimum that Obsidian's file recovery is on.

**"I don't want it touching certain folders"** — configure workspace scope, and **do not** give that Agent terminal commands, or the scope is decorative.

**"I don't want it going online at all"** — turn off the Web Search Toolset under Manage tools. Note that this doesn't affect calls to the model API itself.

---

## Related

- Full explanation of the modes: [Chat](./chat.md#three-modes)
- Setting up roles with different permissions for different jobs: [Agents](./assistants.md)
- The risks of plugging in external tools: [MCP](./mcp.md)
