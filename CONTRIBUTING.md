# Contributing to YOLO

Thanks for your interest in contributing! This document covers what we welcome, how to land a PR, and the few rules that exist to keep review tractable.

> 中文版：[CONTRIBUTING_zh-CN.md](./CONTRIBUTING_zh-CN.md)

---

## TL;DR

- **Open an issue first** for changes identified below as needing prior discussion. We'd rather discuss the direction than reject finished code.
- **You can use AI to help write code.** You just need to understand what you changed, why, and where things could go wrong — enough to defend the PR yourself.
- **PRs over ~2,000 lines of net change that are highly disruptive must have a linked issue.** This applies to AI-generated work too.
- Run `npm run type:check && npm run lint:check && npm test` before opening the PR.

---

## What we welcome (and what we don't)

Review bandwidth is limited, so contributions land faster when they fit the project's direction. The categories below are a rough guide, not a hard rulebook.

### 🟢 Welcome — go ahead, no prior discussion needed

- Bug fixes with a clear reproduction
- Documentation, README, and translation improvements
- Small UX polish (copy, spacing, keyboard shortcuts, accessibility)
- Test coverage for existing behavior
- Performance improvements with measurements
- Adding a new model to an existing provider

### 🟡 Please open an issue first

These need alignment before you write code, otherwise the PR is likely to get reshaped or closed:

- New LLM providers, MCP integrations, or built-in tools
- New built-in skills or major skill-system changes
- Changes to Agent runtime, RAG retrieval, or core chat flow
- New settings, especially anything that needs a settings migration
- UI restructuring (new panels, layout changes, theme system changes)
- Anything touching how user data is stored or migrated

### 🔴 Please don't open a PR for these without talking to the owner first

These are areas where the maintainer has a specific direction in mind, and unsolicited PRs are usually closed:

- Items on the README Roadmap (Learning Mode, Annotation Mode, the built-in assistant, the AI whiteboard, voice input / meeting notes)
- Renames or refactors of core architecture (`src/core/agent/`, `src/core/ai/`, `src/core/llm/`)
- Anything described as "experimental" in the codebase

If you're unsure which bucket your idea falls into, just open an issue and ask.

---

## On AI-generated code

Most people use AI to write code now, including the maintainer. Using AI is fine. **What's not fine is opening a PR you can't explain.**

The bar is simple:

- You should be able to describe what changed, why this approach, and what could break — in your own words, without re-prompting an LLM mid-review.
- If a reviewer asks "why did you do it this way?", "what does this branch handle?", or "did you check X edge case?", you should have an answer.
- AI sometimes writes code that's better than what a human would write. That's fine. AI also sometimes confidently writes code that doesn't make sense in this codebase. The PR author is responsible for catching the second case before submitting.

The PR template asks you to disclose AI usage. **This is informational, not gatekeeping** — be honest about it. PRs marked as AI-assisted aren't reviewed differently; PRs that fail the "can the author defend it?" test get closed regardless of who wrote them.

### What might get PRs closed quickly

- Net change > 2,000 lines that is highly disruptive and hasn't been discussed in a linked issue
- Author can't explain a non-trivial part of the diff during review
- "I asked the AI to fix it again" iteration loops with no human reasoning visible
- Sweeping refactors, file moves, or stylistic rewrites mixed into a feature PR

---

## PR size guide

Smaller PRs land faster. Use this as a self-check:

| Size | Net diff | Notes |
|------|----------|-------|
| **S** | < 100 lines | Quick fixes, docs, small polish. Usually merged same-day if green. |
| **M** | 100–500 lines | Most feature work. Should be focused on one thing. |
| **L** | 500–2,000 lines | Needs a clear scope and ideally a linked issue. |
| **XL** | > 2,000 lines | Highly disruptive changes must have a linked issue with the design discussed and agreed. |

---

## Development setup

Clone into your Obsidian vault's plugins directory so you can test in a real Obsidian environment:

```bash
git clone https://github.com/Lapis0x0/obsidian-yolo.git \
  /path/to/your/vault/.obsidian/plugins/obsidian-yolo
cd /path/to/your/vault/.obsidian/plugins/obsidian-yolo
npm install
npm run dev
```

Then enable the plugin in Obsidian. Use the [Hot Reload plugin](https://github.com/pjeby/hot-reload) for automatic reloads during development, or reload Obsidian manually (`Cmd/Ctrl + R` in the dev console).

### Common scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Watch mode for code + styles |
| `npm run build` | Production build (includes type check) |
| `npm run type:check` | Type check without emitting |
| `npm run lint:check` / `lint:fix` | Prettier + ESLint |
| `npm test` | Jest tests |
| `npm run styles:build` | Rebuild `styles.css` from `src/styles/**` |

### Style/CSS changes

`styles.css` at the repo root is **generated** — don't edit it directly. Edit files under `src/styles/**` and rebuild with `npm run styles:build`. All CSS classes use the `yolo-` prefix.

For popovers/dropdowns, read the comment header in `src/styles/popover/surface.css` first.

---

## Database schema changes

YOLO uses PGlite + Drizzle ORM. If your change touches the schema:

1. Edit `src/database/schema.ts`.
2. Generate a migration: `npx drizzle-kit generate --name <migration-name>`
3. Review the generated files under `drizzle/`.
4. Compile migrations into the bundle: `npm run migrate:compile` — this updates `src/database/migrations.json`, which is what actually runs at startup. **Migration files in `drizzle/` have no effect until compiled.**

Prefer one migration file per logical change. If you've generated several while iterating, squash them before submitting:

1. Delete the new migration files in `drizzle/`.
2. Delete the new snapshot files in `drizzle/meta/`.
3. Remove the new entries from `drizzle/meta/_journal.json`.
4. Re-run `npx drizzle-kit generate --name <final-name>` to produce a single consolidated file.
5. Run `npm run migrate:compile` again.

### Debugging the database in Obsidian

In the Obsidian developer console:

1. Find the log message `Next composer database initialized.`
2. Right-click the `DatabaseManager` object in the log → **Store as global variable** (it'll be saved as `temp1` or similar).
3. Run queries directly:
   ```js
   await temp1.pgClient.query(`
     SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
       AND table_type = 'BASE TABLE'
     ORDER BY table_schema, table_name;
   `)
   ```
4. Call `await temp1.save()` to persist changes to disk.

---

## Before opening a PR

1. Branch from `main`.
2. Run the checks:
   ```bash
   npm run type:check
   npm run lint:check
   npm test
   ```
3. If you changed CSS, run `npm run styles:build` and commit the regenerated `styles.css`.
4. If you fixed a bug or added behavior worth pinning down, add a test.
5. Fill in the PR template honestly — including the AI usage disclosure and linked issue if applicable.

---

## Review expectations

- The maintainer reviews PRs as time allows. Expect anywhere from a day to a couple of weeks for a first response, longer for large changes.
- You can summon the review bot by mentioning `@Lapis0x1` in a comment — its replies count as Lapis0x0's.

---

## License

YOLO is [MIT licensed](LICENSE). By submitting a PR you agree your contribution is released under the same license.

---

## Maintainer notes

For maintainers with write access, releases are tag-driven: `git tag <version> && git push origin <version>` triggers the workflow that builds, releases, and opens a version-bump PR for `manifest.json` / `versions.json` / `package.json`.
