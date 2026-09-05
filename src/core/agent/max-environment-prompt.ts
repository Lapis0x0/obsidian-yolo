import { type App, Platform } from 'obsidian'

import { getVaultBasePath } from '../tools/native/paths'

import type { BashCommandFlavor } from './bash/command-classifier'

/**
 * The environment facts a Max run has to state up front, because none of them
 * are discoverable from the tool schemas alone: where relative paths resolve,
 * which OS the shell commands will run under, and what "today" means.
 *
 * Ask and Agent need none of this — their tools take vault-relative paths and
 * never reach a real shell — which is why this is a Max-only prompt section
 * rather than something the base behaviour block grew.
 */
export type MaxEnvironmentFacts = {
  /** Absolute path relative paths resolve against, and the shell's cwd. */
  cwd: string
  /** `process.platform`, e.g. `darwin`, `win32`, `linux`. */
  platform: string
  /** `process.arch`, e.g. `arm64`, `x64`. */
  arch: string
  /** Which shell dialect commands are written in — same split the read-only
   * command classifier uses (`Platform.isWin ? 'powershell' : 'posix'`). */
  shell: BashCommandFlavor
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string
}

const pad2 = (value: number): string => value.toString().padStart(2, '0')

const formatLocalDate = (now: Date): string =>
  `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`

/**
 * Pure renderer, so the wording is testable without a vault, a platform, or a
 * clock. `resolveMaxEnvironmentPrompt` gathers the facts.
 */
export const buildMaxEnvironmentPrompt = ({
  cwd,
  platform,
  arch,
  shell,
  date,
}: MaxEnvironmentFacts): string => `<max_environment>
- Working directory (the user's Obsidian vault): ${cwd}
- Platform: ${platform} (${arch})
- Shell: ${shell}
- Today: ${date}

- Prefer edit_file over rewriting a file through the shell (sed, awk, output redirection): the edit is exact and fails loudly instead of silently mangling the file.
- Read a file before you edit it. edit_file replaces text that must match exactly and occur once.
- Paths may be absolute, start with ~, or be relative to the working directory.
- A file path or a terminal cwd outside the working directory may pause for the user's approval, which they can then grant for the rest of this chat. Stay inside unless the task is genuinely about a path elsewhere.
- Shell output is truncated before you see it. Narrow it at the source (| head, | rg, | wc -l) instead of printing everything.
</max_environment>`

/**
 * The live facts for this machine, or `undefined` when they cannot be
 * established — a non-desktop platform, or a vault that is not backed by the
 * local filesystem. Both are cases where Max is not selectable in the first
 * place (`availableBuiltinChatModes`, `resolveEffectiveChatMode`), so this is
 * a guard rather than a fallback: `process` must never be touched off
 * desktop, and `getVaultBasePath` throws on a non-filesystem adapter.
 */
export const resolveMaxEnvironmentPrompt = (app: App): string | undefined => {
  if (!Platform.isDesktop) return undefined
  let cwd: string
  try {
    cwd = getVaultBasePath(app)
  } catch {
    return undefined
  }
  return buildMaxEnvironmentPrompt({
    cwd,
    platform: process.platform,
    arch: process.arch,
    shell: Platform.isWin ? 'powershell' : 'posix',
    date: formatLocalDate(new Date()),
  })
}
