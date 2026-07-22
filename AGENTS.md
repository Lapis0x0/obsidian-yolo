# Repository Guidelines

YOLO is an Obsidian plugin for AI chat, agent workflows, RAG, writing assistance, and independently shipped product modules such as FSRS-based Learning.

## Commands

- `npm run dev` - Build first-party modules, then watch the host app, host styles, and dev-vault artifacts
- `npm run build` - Production build with host and module type checking
- `npm run type:check` / `npm run module:typecheck` - Type-check the host or first-party modules
- `npm run module:build` - Rebuild first-party module artifacts and the bundled module catalog
- `npm run lint:check` / `npm run lint:fix` - Check or fix Prettier and ESLint
- `npm test` - Run the full Jest suite; use `npx jest <test-file> --runInBand` for serial debugging
- `npm run styles:build` - Regenerate the host `styles.css` from `src/styles/**`
- `npx drizzle-kit generate --name <name>` then `npm run migrate:compile` - Generate and compile database migrations

## Architecture

- `src/main.ts` owns the host plugin lifecycle. `src/ChatView.tsx` and `src/components/chat-view/` own the main chat surface.
- `src/core/modules/` owns module discovery, installation, loading, activation, lifecycle, and the versioned Host API. `modules/host-sdk.d.ts` is the module-facing API contract.
- `modules/<id>/` owns an independently built product module: its UI, domain logic, host adapters, styles, assets, workers, and tests. `modules/learning/` contains the complete Learning product implementation.
- `src/core/agent/` owns the shared native agent runtime, tool gateway, conversation service, subagents, and background tasks. Quick Ask, Sidebar Chat, and Agent Chat run through `AgentService.run`; permissions come from `resolveChatModeRuntime`.
- `src/core/ai/single-turn.ts` is the low-latency path for Smart Space and Write Assist. Do not route these features through the agent runtime or introduce another orchestration path.
- `src/core/llm/`, `auth/`, `rag/`, `mcp/`, and `skills/` own shared model, provider, retrieval, and tool capabilities.
- `src/features/` contains host-shipped cross-cutting features. `src/database/`, `src/settings/`, and `src/styles/` own host persistence, settings, and global styles.

## Module Boundaries

- Put a large, optional product capability in `modules/` when it can be installed, enabled, and released independently. Keep small or inherently host-integrated capabilities in `src/features/`.
- A module may depend on the versioned Host API and its declared package dependencies. It must not import `src/core/`, `src/components/`, `YoloPlugin`, or `obsidian` directly.
- First-party modules follow the same boundary as external modules. Repository co-location does not grant access to host implementation details.
- Add a capability to the Host API only when it is broadly useful to modules. Keep module-specific policy and behavior inside the owning module.
- Core must not import module source or bundle module implementation into the host artifact. Communicate only through registration, manifests, and Host API contracts.
- Treat versioned `entry.js`, module `style.css`, generated manifest metadata (hashes, sizes, and URLs), and `modules/bundled.json` as build outputs. Change source or compatibility declarations, run `npm run module:build`, and commit the regenerated artifacts rather than editing generated metadata.

## Critical Cross-Cutting Constraints

### YOLO Managed Paths

- Resolve host-managed Vault paths from current settings through `src/core/paths/`; never hardcode `YOLO`. Modules consume current path snapshots through the Host API instead of reproducing host path rules.
- Long-lived services must read current settings or path snapshots through getters so base-directory changes take effect without restart.

### Runtime Boundaries

- Never statically import desktop-only dependencies (`node:*`, `proxy-agent`, `shell-env`, local servers, child processes, stream adapters, etc.). Load them with `await import(...)` inside desktop-only branches so mobile can load the host or module.
- PGlite cannot use its default `node:fs` path in Obsidian. `DatabaseManager.ts` lazily loads its data, WASM, and vector extension and supplies them during initialization; preserve the build shims for `process` and `import.meta.url`.
- `src/utils/chat/responseGenerator.ts` was removed. Do not recreate a parallel chat or agent orchestration path.

### Database Schema Changes

1. Edit `src/database/schema.ts`.
2. Run `npx drizzle-kit generate --name <migration-name>`.
3. Review the generated files in `drizzle/`.
4. Run `npm run migrate:compile` to update `src/database/migrations.json`.

## Obsidian and Style Constraints

- React event handlers that call async functions must use `void` wrappers.
- Do not directly set `element.style.cursor` or `element.style.userSelect`; use `setCssProps`.
- Every `eslint-disable` directive must include a reason.
- All CSS classes must use the `yolo-` prefix. Host styles live in `src/styles/**`; module styles live with their module.
- When styling native controls, assume Obsidian core and theme styles apply globally. Use component-scoped `element.yolo-*` selectors, explicitly reset affected properties, and use `!important` only for a confirmed host-style collision.
- Organize host styles by responsibility as documented in `src/styles/README.md`. Before changing popovers or dropdowns, read the ownership rules in `src/styles/popover/surface.css`.

## Verification

- Host code: run `npm run type:check` and relevant tests.
- Module code: run `npm run module:typecheck`, relevant tests, `npm --prefix modules/<id> run test:boundary` when available, and `npm run module:build`.
- Host CSS: run `npm run styles:build`. Module CSS is rebuilt by the module build.
- Run `npm run build` for changes that affect production bundling, module boundaries, runtime loading, or cross-platform behavior.