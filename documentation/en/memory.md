# Memory

Memory lets YOLO remember your preferences, habits and long-running background across conversations, so you don't have to explain yourself again every time you open a new chat.

## Memory is just ordinary notes

This is the single most important thing to understand about the memory system: **YOLO has no dedicated "memory tool" — memories are ordinary Markdown files in your vault.**

The AI maintains them with the same general file read/write capabilities it uses for everything else. So you can open them, edit them directly, or delete them whenever you like — they're not a black box hidden in some database.

## Where the files live

By default, under `YOLO/memory/` in your vault, on two levels:

```
YOLO/memory/global/MEMORY.md        ← index, applies to every Agent
YOLO/memory/global/<a memory>.md     ← one specific fact

YOLO/memory/<Agent name>/MEMORY.md   ← index, applies only to this Agent
YOLO/memory/<Agent name>/<a memory>.md
```

> **The `YOLO` base folder name is changeable.** Edit it under **Settings → Others → Maintenance → YOLO base folder**, and the Skills, memory and other folders follow it. For readability this page always writes `YOLO/` — substitute your own setting.

Each folder is one `MEMORY.md` index plus a set of standalone fact files: **one fact, one file**.

### What each level is for

- **Global memory** (`global/`): facts that hold for every Agent. Who you are, your long-term preferences, the toolchain you use
- **Agent memory** (`<Agent name>/`): facts that only matter to one Agent. "Group the weekly report by department" is only useful to the weekly-report Agent

An Agent's folder name is derived from its display name, with a number appended if there's a clash. If your Agent happens to be called `global`, it gets put in `global (assistant)/` so it doesn't collide with global memory.

## How the index relates to the body

`MEMORY.md` is an index: one line per memory, a link to the file plus a one-sentence summary.

**The whole index goes into the system prompt; the bodies do not.** The AI reads the index first to work out which entries might be relevant, and only then reads the body of the one it needs. The point is to save context — you can accumulate plenty of memories and still only pay for the index every turn.

Which is why that one-sentence summary in the index matters so much: it decides whether the AI remembers the memory at the right moment.

## How the AI writes memories itself

A fixed set of memory rules is injected into the system prompt, requiring the model to:

- Keep one fact per file, with frontmatter carrying `name` (kebab-case, matching the filename) and `description` (one sentence)
- **Write down the why**, not just the conclusion — so it still transfers to a different situation
- Check the index for an existing entry on the same topic before adding a new one, and update rather than create
- Delete stale or wrong memories, and delete the index line with them
- Write absolute dates, never "last week" or "three days ago"
- Not copy in content that already exists in a vault note — point at that note instead
- **Update the index in the same turn** as every add, edit or delete

You can tell it "remember this" directly, or leave it to decide on its own.

## When memories won't be written

**Not in Ask mode.** Memory is implemented through the file editing capability, and file editing is only available in Agent mode. Ask can read memories, not write them.

The memory rules themselves are injected unconditionally (even when you have no memories at all), so the model knows the mechanism exists. But a mode without write permission naturally can't use the "write" half of it.

## Managing memories yourself

Just open the file in Obsidian and edit it — they're ordinary notes.

Once you hand-edit `MEMORY.md`, the cached snapshot of the system prompt is invalidated and the next turn re-reads it — meaning your edit takes effect immediately, no restart needed.

> The AI writing a memory itself does not trigger that invalidation (otherwise every single write would force a cache rebuild), so **a memory the model just wrote usually only takes full effect in the next session**.

## Memory and workspace scope

Memory folders are **always exempt** from workspace scope limits. Even if you lock an Agent into some subfolder, it can still read and write its own memory and global memory.

But **other Agents' memory folders are not exempt** — the exemption never lets one Agent read another Agent's private memories.

## How much context it takes

In the context usage panel in chat, memory gets its own bucket, so you can see exactly how many tokens it eats. If memories pile up, go back and prune — the index is billed every single turn.

---

## Related

- Reading context usage: [Chat](./chat.md#see-how-much-context-is-used)
- Configuring Agents: [Agents and subagents](./assistants.md)
- Memory versus Skills: [Skills](./skills.md) — memory is "facts about you", a skill is "how to do a kind of thing"
