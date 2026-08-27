# Repository Guidelines

YOLO is an Obsidian plugin for AI chat, agent workflows, RAG, writing assistance, and independently shipped product modules such as FSRS-based Learning.

For a behavior ↔ code-location ↔ verification-path index (complements this file's directory-ownership rules, doesn't restate them), see `FEATURE_MAP.md`.

## Commands

- `npm run dev` - Build runtime components and first-party modules, then watch the host app, host styles, and dev-vault artifacts
- `npm run build` - Production build with host, module, and runtime component type checking
- `npm run type:check` / `npm run module:typecheck` / `npm run runtime:typecheck` - Type-check the host, first-party modules, or runtime components
- `npm run module:build` - Rebuild first-party module artifacts and the bundled module catalog
- `npm run runtime:build` / `npm run runtime:verify` - Rebuild runtime component artifacts and their registry, or verify the host bundle doesn't statically pull in a runtime component's dependencies
- `npm run lint:check` / `npm run lint:fix` - Check or fix Prettier and ESLint
- `npm test` - Run the full Jest suite; use `npx jest <test-file> --runInBand` for serial debugging
- `npm run styles:build` - Regenerate the host `styles.css` from `src/styles/**`

## Architecture

- `src/main.ts` owns the host plugin lifecycle. `src/ChatView.tsx` and `src/components/chat-view/` own the main chat surface.
- `src/core/modules/` owns module discovery, installation, loading, activation, lifecycle, and the versioned Host API. `modules/host-sdk.d.ts` is the module-facing API contract.
- `modules/<id>/` owns an independently built product module: its UI, domain logic, host adapters, styles, assets, workers, and tests. `modules/learning/` contains the complete Learning product implementation.
- `src/core/runtime-components/` owns discovery, download, and lifecycle of on-demand runtime components (heavy native/WASM engines). `runtime-components/<id>/` at the repo root owns each component's source and build output; `runtime-components/sdk.d.ts` is the component-facing contract.
- `src/core/agent/` owns the shared native agent runtime, tool gateway, conversation service, subagents, and background tasks. Quick Ask, Sidebar Chat, and Agent Chat run through `AgentService.run`; permissions come from `resolveChatModeRuntime`.
- `src/core/ai/single-turn.ts` is the low-latency path for Sparkle (tab completion, selection rewrite, continuation). Do not route these features through the agent runtime or introduce another orchestration path.
- `src/core/tools/` owns every built-in tool: `capabilities/` is the single registration point, and the tool catalog, settings rows, approval policy, and persisted keys are all derived from it — never add a side table. `dispatcher.ts` is the only execution path.
- `src/core/llm/`, `auth/`, `rag/`, `mcp/`, and `skills/` own shared model, provider, retrieval, and MCP capabilities.
- `src/features/` contains host-shipped cross-cutting features. `src/database/`, `src/settings/`, and `src/styles/` own host persistence, settings, and global styles.

## Module Boundaries

- Put a large, optional product capability in `modules/` when it can be installed, enabled, and released independently. Keep small or inherently host-integrated capabilities in `src/features/`.
- A module may depend on the versioned Host API and its declared package dependencies. It must not import `src/core/`, `src/components/`, `YoloPlugin`, or `obsidian` directly.
- First-party modules get no access to host implementation details from repository co-location.
- Add a capability to the Host API only when it is broadly useful to modules. Keep module-specific policy and behavior inside the owning module.
- Core must not import module source or bundle module implementation into the host artifact. Communicate only through registration, manifests, and Host API contracts.
- A module ships skills as packages: declared files are projected on activation into `<YOLO base>/modules/<moduleId>/skills/<package>/` and are then ordinary Vault skills. Do not introduce a module-skill path protocol.
- Treat versioned `entry.js`, module `style.css`, generated manifest metadata (hashes, sizes, and URLs), and `modules/bundled.json` as build outputs. Change source or compatibility declarations, run `npm run module:build`, and commit the regenerated artifacts rather than editing generated metadata.

## Critical Cross-Cutting Constraints

### YOLO Managed Paths

- Resolve host-managed Vault paths from current settings through `src/core/paths/`; never hardcode `YOLO`. Modules consume current path snapshots through the Host API instead of reproducing host path rules.
- Long-lived services must read current settings or path snapshots through getters so base-directory changes take effect without restart.

### Runtime Boundaries

- Never statically import desktop-only dependencies (`node:*`, `proxy-agent`, `shell-env`, local servers, child processes, stream adapters, etc.). Load them with `await import(...)` inside desktop-only branches so mobile can load the host or module.
- Never statically import a heavy or native/WASM dependency closure into the host or a module (e.g. tokenizer, PDF, bash, or embedding libraries). Package it as a runtime component under `runtime-components/` instead; `npm run runtime:verify` fails the build if one leaks into the host bundle.
- The RAG vector store is IndexedDB-backed (`src/database/vector-store/`); schema v1 is final — a schema change requires bumping `VECTOR_DATABASE_VERSION` and adding an upgrade path in `vectorDatabase.ts`.
- Do not create a second chat or agent orchestration path.

### Chat Runtime Invariants

- Agent conversation state is structurally shared: a message object's reference changes if and only if its content changes. Never mutate messages or state arrays in place; dev builds deep-freeze published snapshots to catch this.
- While a message is generating, its content and reasoning live in `assistantRenderStreamStore`, not in the conversation snapshot; snapshots fold the stream back only at semantic boundaries. Never publish per-token conversation snapshots.
- All scroll writes in chat surfaces go through the scroll controller in `src/components/chat-view/scroll/`; never set `scrollTop` directly, and never infer user intent from it — paging direction comes from the input event, position only gates the edge.

### Popout / Multi-window

Obsidian popouts are separate BrowserWindows. Plugin JS still runs in one realm, but each window has its own `document`, `window`, and keymap. Global `document` / `window` are the **main** window.

- View-local DOM work (portals, listeners, `requestAnimationFrame`, `ResizeObserver`, `IntersectionObserver`, `getComputedStyle`, `activeElement`, timers) must use the node's `ownerDocument` / `defaultView`. Use `src/utils/dom/window-context.ts`; do not default to the globals.
- Keyboard, Escape layering, and menus belong to Obsidian's keymap (`Scope` + `app.keymap.pushScope` / `popScope`, `Menu`, `Modal`). A React `onKeyDown` plus Radix/document-capture stack only sees keys that reach a node in that document, so it works in the main window and fails in the popout.
- Overlay, shortcut, and portal behavior is not done until it has been checked in a popout, not only the main window.

## Obsidian and Style Constraints

- React event handlers that call async functions must use `void` wrappers.
- Do not directly set `element.style.cursor` or `element.style.userSelect`; use `setCssProps`.
- Every `eslint-disable` directive must include a reason.
- All CSS classes must use the `yolo-` prefix. Host styles live in `src/styles/**`; module styles live with their module.
- When styling native controls, assume Obsidian core and theme styles apply globally. Use component-scoped `element.yolo-*` selectors, explicitly reset affected properties, and use `!important` only for a confirmed host-style collision.
- Organize host styles by responsibility as documented in `src/styles/README.md`. Before changing popovers or dropdowns, read the ownership rules in `src/styles/popover/surface.css`.
- Never hardcode user-visible text; route it through i18n, and resolve the current locale at use time rather than caching a locale-bound translator.
- Animate only `opacity` and `transform`, with durations and easings from `src/styles/tokens/motion.css` / `motion.ts` (paired files — keep both in sync). Animating layout properties requires an inline exemption comment.
- CSS animations get reduced-motion handling for free from a global fallback; do not add per-component disable blocks. JS-driven animations (framer-motion / WAAPI) must degrade via `useReducedMotion`.

## Verification

- Host code: run `npm run type:check` and relevant tests.
- Module code: run `npm run module:typecheck`, relevant tests, `npm --prefix modules/<id> run test:boundary` when available, and `npm run module:build`.
- Runtime component code: run `npm run runtime:typecheck`, relevant tests, `npm run runtime:build`, and `npm run runtime:verify`.
- Host CSS: run `npm run styles:build`. Module CSS is rebuilt by the module build.
- Run `npm run build` for changes that affect production bundling, module boundaries, runtime loading, or cross-platform behavior.
- Dependency hygiene: `npm run deps:check` enforces the circular-dependency ratchet; after removing cycles, tighten the baseline with `npm run deps:baseline`.
