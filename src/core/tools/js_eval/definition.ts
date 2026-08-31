import { getJsSandboxSettings } from '../../mcp/jsSandboxSettings'
import {
  buildJsSandboxProxyHandlers,
  callJsSandboxTool,
  getJsSandboxTool,
} from '../../mcp/jsSandboxTool'
import { defineTool } from '../define'

// This tool's implementation is NOT inlined here — it lives in
// `core/mcp/jsSandboxTool.ts` (schema/description building, the sandboxed
// Worker runner, and — as of D6 batch 6 — the `$vault`/`$browser`/`$fetch`/
// `$db` proxy-handler construction that used to live in
// `core/mcp/localFileTools.ts`; see that file's own doc comment for why it
// moved). `execute` below is a thin adapter that gathers `ToolContext`
// dependencies and hands them to `callJsSandboxTool`, proving
// `BuiltinToolDefinition.execute` can delegate to an external implementation
// rather than inlining everything (phase2-migration.md D6 batch 6).
export const jsEvalDefinition = defineTool({
  name: 'js_eval',
  // Matches the still-live `getLocalFileTools()` projection, which calls
  // `getJsSandboxTool()` with no settings argument (`localFileTools.ts`'s
  // schema array literally has `getJsSandboxTool(),`) — `ToolCatalogContext`
  // carries no settings snapshot, so this can't diverge from that even if it
  // wanted to.
  getMcpTool: () => {
    const { name: _name, ...rest } = getJsSandboxTool()
    return rest
  },
  // Deliberately no `isAvailable` — unlike `terminal_command`, `js_eval` has
  // no platform restriction today (`jsSandboxTool.ts` makes zero references
  // to `Platform`; its "slow / mobile devices" comment treats mobile as a
  // case to accommodate, not exclude). Adding one here would be an
  // unapproved behavior change (master.md §3.1b).
  chatLabel: {
    key: 'settings.agent.builtinJsEvalLabel',
    fallback: 'Analysis Sandbox',
  },
  contextPrunable: true,
  // Ported verbatim from the `case JS_SANDBOX_TOOL_NAME` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts`), minus the abort
  // check and the outer try/catch that normalizes thrown errors to an
  // Error-status result — those are dispatcher responsibilities
  // (master.md §3.4), not tool semantics.
  //
  // Workspace-scope and YOLO-data-root enforcement are NOT dispatcher
  // responsibilities for this tool: `js_eval`'s only argument is opaque
  // `code`, so the dispatcher's raw-argument path scan
  // (`enforceBuiltinToolSecurityBoundary`) never sees a path to check —
  // any vault path the code touches only exists inside `$vault.*` proxy
  // calls the Worker makes back to the host. `workspaceScope` and
  // `allowedSkillPaths` are threaded through to `buildJsSandboxProxyHandlers`
  // below so those proxy handlers (in `jsSandboxTool.ts`) can enforce it
  // per-call, the same way `fs_read`'s per-resolved-path check does for
  // wikilinks (issue #577 follow-up: `$vault.readText`/`readBinary`/`list`
  // used to only guard the YOLO user-data root, not workspace scope at all).
  execute: async (args, ctx) => {
    const {
      app,
      settings,
      ragAccess,
      signal,
      workspaceScope,
      allowedSkillPaths,
    } = ctx
    const jsSandboxSettings = getJsSandboxSettings(settings)
    const proxyHandlers = buildJsSandboxProxyHandlers(
      app,
      jsSandboxSettings,
      ragAccess,
      settings,
      workspaceScope,
      allowedSkillPaths,
    )
    return callJsSandboxTool({
      app,
      args,
      signal,
      jsSandboxSettings,
      proxyHandlers,
    })
  },
})
