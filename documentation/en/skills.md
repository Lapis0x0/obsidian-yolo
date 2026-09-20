# Skills

A skill is an operating manual written in Markdown that teaches YOLO to do a kind of task your way.

The difference from [memory](./memory.md): memory is "facts about you", a skill is "how to do a kind of thing".

## What problem it solves

Say that every time you tidy up meeting notes you have to spell out "split it into discussion points, decisions and action items, and every action item needs an owner and a due date". Write that down as a skill and you can just say "tidy up these meeting notes" — it already knows how.

The value isn't saving you those few sentences. It's that **the method is pinned down** and won't drift from one time to the next.

## Progressive loading

A skill has two levels:

- **frontmatter** (name + description) — always in context
- **body** — loaded only when it's needed

The model **decides whether to use a skill purely from the description**. Which means how well the description is written directly determines whether the skill ever fires — more so than how well the body is written.

Each skill can be set to:

- **On demand** (`lazy`, the default) — only the description up front, the body is read once it triggers
- **Full inject** (`always`) — the body sits in context every turn

With a handful of skills it barely matters; with a lot of them, full injection visibly eats context. Leave it on demand by default, and only spend a full injection on the kind of rule that must be obeyed every time.

## Built-in skills

YOLO ships four:

| Skill | Loading | What it does |
|------|---------|------|
| **obsidian-cli** | On demand | Drives the official Obsidian CLI through the terminal to handle backlinks, properties, daily notes and command palette actions that ordinary file tools can't reach |
| **obsidian-output-format** | Full inject | Sets the formatting conventions for Markdown editing suggestions |
| **skill-creator** | On demand | The "meta skill" that teaches the AI how to write skills |
| **snippet-creator** | On demand | Teaches the AI how to maintain your `/` snippet library |

When you want to write your own skill, just ask the AI to do it with **skill-creator** — it knows the format requirements.

## Writing your own

Skills live under `YOLO/skills/` in your vault (`YOLO` is the changeable base folder name, see **Settings → Others → Maintenance → YOLO base folder**), in one of two shapes:

- **Single file**: `YOLO/skills/my-skill.md`
- **Folder package**: `YOLO/skills/my-skill/SKILL.md`, for when you need to ship scripts or reference material alongside it

### Format

```markdown
---
name: meeting-notes
description: Turn raw meeting notes into a structured summary. Use when the user pastes meeting content, asks for a meeting summary, or asks to extract action items.
mode: lazy
---

# Meeting notes cleanup

## When to use
The user has pasted meeting notes or a transcript, or has asked for a meeting summary or a list of action items.

## Steps
1. Pull out the attendees, topics and conclusions
2. Output three sections: Discussion points / Decisions / Action items
3. Every action item must carry an owner and a due date — if that isn't clear, ask the user

## Output format
Use level-three headings: `### Discussion points`, `### Decisions`, `### Action items`
```

Three frontmatter fields:

- **`name`** — kebab-case, unique in the vault, serving as both the identifier and the display name
- **`description`** — **the most important line**. It has to cover both "what it does" and "when to use it", because that sentence is all the model has to decide whether to activate the skill
- **`mode`** — `lazy` (default) or `always`

### Writing a description that actually works

Compare:

- ❌ `description: Meeting notes tool` — the model has no idea what counts as "time to use this"
- ✅ `description: Turn raw meeting notes into a structured summary. Use when the user pastes meeting content, asks for a meeting summary, or asks to extract action items.`

A good description answers both "what is this for" and "what conditions should remind the model of it". Once you've written one, test it on yourself: if you were the model, and this sentence was all you had, could you tell whether to use it?

### What a skill is allowed to use

A skill can only use in-vault tools (file editing, the virtual terminal and so on). It has **no independent external API access**. If you need to call an outside service, that's [MCP](./mcp.md) territory.

## Importing existing skills

**Settings → Agent → Skills → Import Skill**, from three sources:

- **Drag and drop** a file or folder in
- **Pick a file or folder**
- **Paste a GitHub link**, in any of three forms:
  - A whole repository: `https://github.com/owner/repo`
  - A subfolder (treated as one skill package): `https://github.com/owner/repo/tree/main/path`
  - A single file: `https://github.com/owner/repo/blob/main/path.md`

On a name clash you can choose **Overwrite all** or **Skip conflicts**.

> A skill you import off the internet is a block of instructions that will enter your system prompt. Skim the body before installing it and confirm it does what you think it does — especially the ones that involve terminal operations.

## Enabling and disabling

Two layers:

- **Global**: Settings → Agent → the Skills list, one switch each. Turn it off and no Agent can use it
- **Per Agent**: switch it individually in the Skills tab of the Agent editor, where you can also override the loading mode

The first time you use skills you need to click **Initialize Skills system** once, which writes the template files into your skills folder.

---

## Related

- Getting an Agent to remember facts rather than methods: [Memory](./memory.md)
- Reaching external services: [MCP](./mcp.md)
- Giving different Agents different skills: [Agents and subagents](./assistants.md)
