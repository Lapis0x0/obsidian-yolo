# CLI Agent

If you already use command-line AI tools like Claude Code or Codex, YOLO can drive them straight from the chat interface and put them to work inside your vault — no switching to a terminal, no second API bill.

**Desktop only.** These runtimes all spawn a local child process, so they aren't available on mobile.

## What's supported

| Runtime | Notes |
|--------|------|
| **Claude Code** | The most complete of the lot, and the only one with Plan mode |
| **Codex** | The only one that lets you watch subtasks run in real time |
| **Hermes** | |
| **Pi** | Can switch between the Pi and omp channels |
| **omp** (Oh My Pi) | A Pi variant; it doesn't get its own row — switch channels from the Pi row to reach it |
| **Grok** | The most limited of the lot, see the comparison below |

## What you need first

**These are "local runtimes"** — what YOLO does is spawn the matching CLI as a child process on your machine, not connect to their services on your behalf. So:

1. Install the CLI tool on your system first
2. Finish its own login/auth (for instance, you have to have signed into `claude` yourself)

Once it's installed, YOLO detects the executable automatically. If it doesn't, go to **Settings → Agent → CLI runtimes** and fill in the executable path for that CLI by hand (the output of `which claude`, or `where claude` on Windows).

If the path is wrong, a red message appears underneath saying it doesn't exist on this machine, and YOLO falls back to auto-detection.

> This path is **stored on this device only and does not sync with your vault**. On a new computer you'll have to fill it in again.

## How to switch over

1. Open any chat (sidebar, tab, split or its own window — all fine)
2. In the runtime switcher at the top, go from **Agent** to **CLI**
3. A **CLI provider** dropdown appears; pick one

Once you've switched, the whole conversation is driven by that CLI process and the interface changes to its session view. **It no longer goes through YOLO's own tool and permission system** — permissions are each CLI's own business.

## Choosing permissions

There's another set of switches at the top, orthogonal to the CLI provider: **Agent / Plan** modes plus a **YOLO (auto-approve)** toggle.

Different CLIs map these two switches onto different things, because their native permission models differ in the first place. YOLO only provides a single place to set them:

**Claude Code**
- Plan → its native plan mode
- Agent (YOLO off) → `acceptEdits`: file edits are accepted automatically, everything else still gets confirmed by Claude Code's own policy
- Agent + YOLO → `bypassPermissions`: every confirmation is skipped

**Codex**
- Plan → approval policy `on-request` + sandbox `workspace-write` (only the workspace is writable)
- YOLO off → same as above
- YOLO on → approval policy `never` + sandbox `danger-full-access`, and the workspace boundary stops mattering

**Grok** has no YOLO toggle.

> Codex has no native Plan mode; picking it degrades to permissions equivalent to "Agent with YOLO off".

## How it compares with YOLO's native Agent

Switching to a CLI **gets you** its native ecosystem (its own skills, MCP and plugin systems), but **costs you** a batch of YOLO's own interface capabilities.

The table below comes from the capability matrix in the code:

| Capability | YOLO native | Claude Code | Codex | Hermes | Pi / omp | Grok |
|------|:---------:|:-----------:|:-----:|:------:|:--------:|:----:|
| Plan mode | — | ✓ | — | — | — | — |
| YOLO auto-approve toggle | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Native skills panel | — | ✓ | ✓ | — | — | — |
| Native MCP status panel | — | ✓ | ✓ | — | — | — |
| Plugin management | — | ✓ | — | — | — | — |
| **Agent (Assistant) picker** | ✓ | — | — | — | — | — |
| **Export conversation to vault** | ✓ | — | — | — | — | — |
| **YOLO's own model picker** | ✓ | — | — | — | — | — |
| **Queuing messages while it generates** | ✓ | — | — | — | — | — |
| Image attachments | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Context compaction | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Rewriting a message you already sent | — | ✓ | ✓ | — | ✓ | — |
| Watching subtasks in real time | — | — | ✓ | — | — | — |

The four bolded rows are **native to YOLO only**: switch to any CLI and you lose them. The one people complain about most is **Export conversation to vault** — a CLI session can't be exported as a note.

**Grok's column is empty all the way down**: no images, no context compaction, no auto-approve toggle. Know that before you pick it.

## Are sessions saved

Yes. CLI sessions have their own session index and you can find and resume them from the chat history list (where **My conversations** and **Task conversations** are kept apart).

But that index is **local to the device and does not sync with your vault**. Move to another computer and your earlier CLI sessions are gone from view — unlike YOLO's native conversations, whose records live in the syncable data folder.

## When to use it

**A CLI is a good fit when**: you already pay for a Claude Code or Codex subscription and want to reuse that quota; or the task needs their native skills and MCP ecosystem; or that's simply the way you like to work.

**YOLO's native side is still better when**: you need to switch between Agents with different personas depending on the job; you want to archive conversations as notes; you want to move freely between models from different vendors in one interface; you need chat history synced across devices.

---

## Related

- Everything a native YOLO conversation can do: [Chat](./chat.md)
- Running native chats on a Claude subscription (no CLI involved): [Models and providers](./models.md#sign-in-with-a-subscription-account-oauth)
- How to configure a native Agent: [Agents and subagents](./assistants.md)
