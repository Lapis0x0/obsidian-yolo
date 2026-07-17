<!-- Thanks for contributing! Please fill this out so review can move quickly. -->

> 👋 Before opening this PR, please confirm you've read [CONTRIBUTING.md](https://github.com/Lapis0x0/obsidian-yolo/blob/main/CONTRIBUTING.md) — it covers what we welcome, the AI-assisted PR policy, and PR size guidelines. PRs that ignore those guidelines may be closed without detailed review.

## Summary

<!-- What does this PR do, in 1–3 sentences? Avoid "see commits" / "self-explanatory". -->

## Linked issue / discussion

<!-- Required for 🟡 (significant changes) and any PR over ~2,000 lines net diff. See CONTRIBUTING.md. -->
<!-- Examples: "Closes #123", "Refs #456", "Discussion: <link>" -->

## Type of change

<!-- Pick the one that fits best. -->

- [ ] 🐛 Bug fix
- [ ] ✨ Feature
- [ ] ♻️ Refactor (no behavior change)
- [ ] 📝 Docs / comments
- [ ] 🎨 Style / CSS only
- [ ] 🧪 Tests only
- [ ] 🔧 Build / tooling / chore

## Size

<!-- Self-estimate of net diff. PRs marked XL **must** have a linked issue. -->

- [ ] S (< 100 lines)
- [ ] M (100–500 lines)
- [ ] L (500–2,000 lines)
- [ ] XL (> 2,000 lines)

## AI assistance disclosure

<!-- Be honest. This is informational, not a filter. See CONTRIBUTING.md → "On AI-generated code". -->

- [ ] No AI-generated code in this PR
- [ ] AI was used to write part or all of this PR

If you checked the second box, please confirm:

- [ ] I understand what changed and why, and I can explain any part of the diff if asked during review.

## Why this approach

<!-- 1–3 sentences on the reasoning. Especially useful for non-trivial changes: -->
<!-- - What alternatives did you consider? -->
<!-- - What could realistically break? -->

## Screenshots / recordings

<!-- For UI changes. Skip if not applicable. -->

## Pre-submit checklist

- [ ] I've read [CONTRIBUTING.md](https://github.com/Lapis0x0/obsidian-yolo/blob/main/CONTRIBUTING.md)
- [ ] `npm run type:check` passes
- [ ] `npm run lint:check` passes (or `npm run lint:fix` was run)
- [ ] `npm test` passes
- [ ] I tested this manually in Obsidian
- [ ] If CSS changed: I edited `src/styles/**`, ran `npm run styles:build`, and committed the regenerated `styles.css`
- [ ] If schema changed: I ran `npx drizzle-kit generate` and `npm run migrate:compile`, and committed the results
