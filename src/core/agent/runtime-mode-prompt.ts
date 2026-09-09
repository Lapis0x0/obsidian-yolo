import type { BuiltinChatModeId } from '../tools/types'

/**
 * Which built-in mode's contract a run presents to the model.
 * Identical to `BuiltinChatModeId` by construction rather than a parallel
 * union: a module chat mode also resolves onto one of these (see
 * `resolveModuleChatModeRuntime`), so there was never a fourth shape to
 * describe. Kept as a named alias because this is where the question is
 * asked — "what do I tell the model about where it is" — not "which mode is
 * selected".
 */
export type RuntimeMode = BuiltinChatModeId

/**
 * What this section is for: **routing**. A mode has a reach, and when a
 * request exceeds it there is a different mode that covers it. That is the
 * whole statement, and it depends only on which mode is running.
 *
 * What it deliberately no longer does: enumerate the toolsets missing from
 * the current configuration. That report took the run's tool list as input
 * and told the model where to send the user for each gap, but "the name is
 * absent from this request's tool list" cannot distinguish the three reasons
 * a toolset can be missing, which have three different remedies:
 *
 *   1. the mode never exposes it (`chatModes`) — switch modes;
 *   2. the mode exposes it and the user switched it off — Agent tool
 *      settings;
 *   3. the mode exposes it, the user has it on, and the tool's own
 *      `isAvailable` says no — `terminal_command` and `native_files` off
 *      desktop, `bash` without the `bash-engine` runtime component,
 *      `web_search` without a configured provider. No single remedy covers
 *      these.
 *
 * Collapsed into one signal, case 3 was reported with case 2's wording, so a
 * mobile run was told the user could enable a terminal that
 * `Platform.isDesktop` makes unreachable, and a run without `bash-engine`
 * was told to switch to a mode that lacks `bash` for the same reason. Those
 * are false remedies, and the machinery needed to tell the cases apart (a
 * hand-maintained tool-name table, forked once already for Max, plus a
 * `settings` snapshot threaded to all four call sites so `isAvailable` could
 * be re-evaluated) bought only a support script for a question the model is
 * already equipped to answer: `buildDefaultBehaviorSection` forbids
 * simulating a tool that is not in the request, and the model can see its
 * own tool list. A missing toolset now goes unmentioned, and "I do not have
 * that in this chat" is both what the model will say and true.
 *
 * Max returns nothing. It has nowhere to route, and `buildMaxEnvironmentPrompt`
 * already states its reach in the concrete terms that matter there (cwd,
 * platform, shell, and the out-of-vault approval behaviour).
 */
export const buildRuntimeModePrompt = (
  mode: RuntimeMode,
): string | undefined => {
  if (mode === 'max') return undefined

  if (mode === 'ask') {
    return `<runtime_mode>
You are in Ask mode: you can read and search the vault, but you cannot change it.
Editing vault files and running commands require Agent mode; what an Agent can do there depends on its enabled tools.
Files outside the vault and real shell work require Max mode, which is desktop-only.
</runtime_mode>`
  }

  // "(desktop-only)" rather than a `Platform` branch producing a mobile
  // variant: the parenthetical is true on every device, and on mobile it is
  // the more useful answer — "that needs Max mode, which is desktop-only"
  // tells the user why their vault-relative-only surface cannot do it,
  // where silence would leave them to guess.
  return `<runtime_mode>
You are in Agent mode: you act on the vault through Obsidian's API, so every file path is vault-relative and nothing outside the vault is reachable.
If a task needs a path outside the vault, a file type Obsidian does not manage, or a shell running in a real working directory, tell the user that Max mode (desktop-only) is the surface for it.
Do not raise Max for work Agent can already do.
</runtime_mode>`
}
