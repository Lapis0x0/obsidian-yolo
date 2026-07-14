# Repository Guidelines

YOLO is an Obsidian plugin for AI chat, agent workflows, RAG, writing assistance, and FSRS-based learning with AI generation and Anki import.

## Commands

- `npm run dev` - Watch app and styles; `npm run build` - production build with type checking
- `npm run type:check` - TypeScript only; `npm run lint:check` / `npm run lint:fix` - Prettier and ESLint
- `npm test` - Full Jest suite; `npm test -- <test-file>` - one test file. For serial debugging, use `npx jest <test-file> --runInBand`, not `npm test -- ... --runInBand`
- `npm run styles:build` - Regenerate `styles.css` from `src/styles/**`
- `npx drizzle-kit generate --name <name>` then `npm run migrate:compile` - Generate and compile database migrations

## Architecture

- `src/main.ts` owns plugin lifecycle; `src/ChatView.tsx` and `src/LearningView.tsx` are the main ItemView entries, backed by `src/components/chat-view/` and `src/components/learning-view/`.
- `src/core/agent/` contains the shared native agent runtime, loop worker, tool gateway, conversation service, subagents, and background tasks. Quick Ask, Sidebar Chat, and Agent Chat all run through `AgentService.run` → `NativeAgentRuntime` → `loop-worker` / `AgentToolGateway`, with permissions resolved by `resolveChatModeRuntime`. Ask mode filters the built-in local file mutation, terminal, and task-state writing tools; Agent mode uses the full configured tool set. Quick Ask and Sidebar Chat share the same runtime profile but differ in UI and session behavior.
- `src/core/ai/single-turn.ts` is the low-latency execution path used by Smart Space and Write Assist; do not route these features through the agent runtime.
- `src/core/learning/` owns Markdown-backed learning projects, generation, scanning, FSRS state, and recoverable Anki import.
- `src/core/llm/`, `auth/`, `rag/`, `mcp/`, and `skills/` own model/provider integration and retrieval/tool capabilities.
- `src/features/editor/` contains editor behaviors; `src/features/chat/`, `config-transfer/`, and `pdf-screenshot/` contain cross-cutting feature integrations.
- `src/database/` combines PGlite/Drizzle vector storage with Vault-backed JSON stores for conversations, attachments, snapshots, and caches. `src/settings/` owns the Zod settings schema and versioned migrations.
- `src/core/project-instructions.ts` cascades Vault `AGENTS.md` / `CLAUDE.md` files into agent workspace instructions.
- `src/utils/chat/responseGenerator.ts` has been removed; do not reintroduce a parallel orchestration path.

## Build & Style System

- `esbuild.config.mjs` includes PGlite asset handling and browser shims.
- `styles.css` is generated. Edit `src/styles/**`, then run `npm run styles:build`.

## Critical Implementation Details

**YOLO Managed Paths**

- Vault-managed files must resolve from `settings.yolo.baseDir`; never hardcode `YOLO` or call write-path helpers without current settings. Long-lived services must read current settings through a getter so base-directory changes take effect.
- Learning Markdown is the content source of truth. Each card heading's embedded 8-character `cardUuid` is its stable SRS identity, while the project directory slug keys the project SRS file; preserve these identities or explicitly migrate state when renaming them.
- FSRS state and recoverable Anki import journals are sidecar data under the configured JSON database directory; access them through `src/core/paths/` and `LearningSrsStore`, not direct paths.

**PGlite in Obsidian Browser Environment**

- PGlite default `node:fs` path is unavailable in Obsidian.
- `DatabaseManager.ts` lazily loads Postgres data/WASM/vector extension and passes them at init time.
- Build config supplies the required `process` and `import.meta.url` compatibility behavior.

**Database Schema Changes**

1. Edit `src/database/schema.ts`
2. Run `npx drizzle-kit generate --name <migration-name>`
3. Review generated files in `drizzle/`
4. Run `npm run migrate:compile` to update `src/database/migrations.json`

## Obsidian Constraints

- React event handlers that call async functions must use `void` wrappers.
- Do not directly set `element.style.cursor` or `element.style.userSelect`; use `setCssProps`.
- Every `eslint-disable` directive must include a reason.
- Never statically import desktop-only dependencies (`node:*`, `proxy-agent`, `shell-env`, local servers, child processes, stream adapters, etc.). Load them with `await import(...)` inside desktop-only branches so mobile can load the plugin.
- When styling native controls (`button`, `input`, etc.), assume Obsidian core and theme styles apply globally: use component-scoped `element.yolo-*` selectors, explicitly reset affected properties, and verify computed styles. Use `!important` only for a confirmed host-style collision.


## Style Conventions

- All CSS classes must use the `yolo-` prefix.
- Styles are organized by **responsibility**, not "first caller". See [`src/styles/README.md`](src/styles/README.md).
- Before writing/modifying popovers or dropdowns, read the header comments in [`src/styles/popover/surface.css`](src/styles/popover/surface.css) (variant ownership, visual/size separation, checklist for new popovers).

## Verification

- Run `npm run type:check` for code changes and add/run relevant tests for logic changes. For CSS changes, regenerate `styles.css`.
