# Repository Guidelines

## Project Overview

YOLO (You Orchestrate, LLM Operates) is an Obsidian plugin for AI chat, RAG, writing assistance, and agent workflows. It integrates multiple LLM providers, vector search, and MCP (Model Context Protocol) servers.

## Development Commands

**Development & Build**

- `npm run dev` - Start app watch + styles watch in parallel
- `npm run dev:app` - Start esbuild watch mode only
- `npm run build` - Production build with type checking (`tsc -noEmit -skipLibCheck`)
- `npm run styles:build` - Build `styles.css` from `src/styles/index.css`
- `npm run styles:watch` - Watch `src/styles/**` and rebuild `styles.css`
- `npm run type:check` - Type check without emitting files
- `npm test` - Run Jest tests

**Code Quality**

- `npm run lint:check` - Run Prettier and ESLint checks
- `npm run lint:fix` - Auto-fix Prettier and ESLint issues

**Database**

- `npx drizzle-kit generate --name <migration-name>` - Generate migration after schema changes
- `npm run migrate:compile` - Compile drizzle migrations to `src/database/migrations.json`

## Architecture (High Level)

**Entry & UI**

- `src/main.ts` - Plugin entry and lifecycle
- `src/components/` - React UI (chat-view, apply-view, settings, modals, panels, common)
- `src/contexts/` - React context providers
- `src/hooks/` - Custom React hooks
- `src/settings/` - Settings tab UI + schema and migrations

**Core**

- `src/core/ai/` - Shared single-turn execution kernel (stream/non-stream, timeout fallback, tool-call aggregation)
- `src/core/agent/` - Unified runtime entry with fast path + loop-worker orchestration, tool gateway, conversation service
- `src/core/llm/` - LLM provider clients and adapters
- `src/core/auth/` - OAuth flows for ChatGPT / Gemini / Qwen and other auth providers
- `src/core/rag/` - Embedding + vector retrieval orchestration
- `src/core/mcp/` - MCP (Model Context Protocol) server management and tool execution
- `src/core/skills/` - Skills system
- `src/core/memory/` - Memory / conversation management
- `src/core/edits/` - Edit and diff operations
- `src/core/search/` - In-vault search
- `src/core/web-search/` - Web search integration
- `src/core/background/` - Background activities and tasks
- `src/core/notifications/` - Notification coordination
- `src/core/paths/` - Path resolution helpers
- `src/core/update/` - Update checking

**Features & Support**

- `src/features/` - Editor-facing behaviors. Includes: `inline-suggestion`, `tab-completion`, `smart-space`, `write-assist`, `quick-ask`, `selection-chat`, `selection-highlight`, `diff-review`
- `src/database/` - PGlite + Drizzle schema/migrations/data access
- `src/utils/` - Prompt/response/diff/edit and utility helpers
- `src/i18n/` - Localization resources (en, it, zh)
- `src/constants/` - Shared constants

**Runtime Profiles**

- Quick Ask: single-turn profile (`enableTools=false`, single iteration), routed to runtime fast path.
- Smart Space / Write Assist: reuse `src/core/ai/single-turn.ts` directly for low-latency editor suggestions.
- Agent Chat: multi-turn profile with `loop-worker` + `AgentToolGateway`.

**Legacy Removal**

- `src/utils/chat/responseGenerator.ts` has been removed; avoid reintroducing duplicated orchestration logic.

## Build & Style System

- `esbuild.config.mjs` uses custom plugins (including PGlite asset copy and browser shims).
- `src/styles/index.css` is the modular style source entry.
- `styles.css` is generated artifact; do not edit directly.
- For CSS changes: edit `src/styles/**`, then run `npm run styles:build`.

## Critical Implementation Details

**PGlite in Obsidian Browser Environment**

- PGlite default `node:fs` path is unavailable in Obsidian.
- `DatabaseManager.ts` manually loads Postgres data/WASM/vector extension and passes them at init time.
- Build config injects `process = {}` and `import.meta.url` compatibility behavior.

**Database Schema Changes**

1. Edit `src/database/schema.ts`
2. Run `npx drizzle-kit generate --name <migration-name>`
3. Review generated files in `drizzle/`
4. Run `npm run migrate:compile` to update `src/database/migrations.json`

**Working Branch**

- Main branch: `main`

## Coding Conventions

- TypeScript + React (`react-jsx`), 2-space indent, single quotes.
- Prefer strict types; avoid `any` (use `unknown` / structured types).
- Components: PascalCase; hooks: `use*` camelCase.
- Before commit: at least run `npm run type:check` and relevant checks.

## Obsidian-Specific Standards

**Promise Handling in React**

- Event handlers calling async functions must use `void` wrappers.

```tsx
onClick={() => void handleAsync()}
onDragEnd={(event) => void handleDragEnd(event)}
```

**DOM Style Manipulation**

- Do not directly set `element.style.cursor` / `element.style.userSelect`.
- Use `setCssProps` instead.

```tsx
document.body.setCssProps({
  '--my-cursor': 'grabbing',
  '--my-user-select': 'none',
})
```

**ESLint Directives**

- Disallow bare `eslint-disable`; always include reason.

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Legacy API requires any
```

**Error Handling**

- Narrow `unknown` errors before stringify/rethrow.

```ts
if (error instanceof Error) throw error
throw new Error(typeof error === 'string' ? error : JSON.stringify(error))
```

**Mobile Compatibility**

- Desktop-only dependencies (`node:*`, `proxy-agent`, `shell-env`, local server, child process, stream adapter, etc.) must NOT be statically imported at the top level.
- They must be lazy-loaded inside desktop-only branches via `await import(...)`.

## Style Conventions

- New CSS classes must use the `yolo-` prefix; existing `smtcmp-*` classes are not subject to mass renaming.
- Styles are organized by **responsibility**, not "first caller". See [`src/styles/README.md`](src/styles/README.md).
- Before writing/modifying popovers or dropdowns, read the header comments in [`src/styles/popover/surface.css`](src/styles/popover/surface.css) (variant ownership, visual/size separation, checklist for new popovers).

## Testing

- Jest + ts-jest (`src/**/*.test.ts(x)`, mocks in `__mocks__/`).
- For normal code changes: run `npm run type:check`; for logic changes add/run tests.

## Git & PR Notes

- Preferred base branch for PRs: `main` (unless explicitly targeting another branch).
- For style-related PRs, ensure `styles.css` is regenerated from `src/styles/**`.
