import type { AcpResolvedCommand } from '../acp/agent-profile'
import {
  findExecutableInDirectories,
  joinForPlatform,
  resolveConfiguredExecutable,
  resolvePathEntries,
  resolveUserHome,
} from '../executable-lookup'

/**
 * CodeBuddy Code ships as the npm package `@tencent-ai/codebuddy-code`, so a
 * global install lands wherever that npm prefix points and the login-shell
 * PATH (merged in by the caller) covers it. The extra directories below are
 * the npm prefixes a shell that was never restarted after install would
 * still be missing.
 *
 * The package installs several bins for the same entry point; `cbc` is
 * deliberately left out of the probe because a two-to-three letter name on
 * PATH is too easy to collide with something unrelated. An install that only
 * exposes `cbc` is reachable through the Settings → Agent path override.
 */
export const findCodebuddyExecutable = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  const home = resolveUserHome(env, platform)
  const commonEntries =
    platform === 'win32'
      ? [
          env.APPDATA ? joinForPlatform(platform, env.APPDATA, 'npm') : '',
          home ? joinForPlatform(platform, home, '.npm-global') : '',
        ]
      : [
          joinForPlatform(platform, home, '.npm-global', 'bin'),
          joinForPlatform(platform, home, '.local', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
          '/usr/bin',
        ]
  const names =
    platform === 'win32'
      ? [
          'codebuddy.cmd',
          'codebuddy.exe',
          'codebuddy.bat',
          'codebuddy',
          'codebuddy-code.cmd',
          'codebuddy-code.exe',
          'codebuddy-code.bat',
          'codebuddy-code',
        ]
      : ['codebuddy', 'codebuddy-code']

  return findExecutableInDirectories(
    [...resolvePathEntries(env, platform), ...commonEntries],
    names,
    platform,
  )
}

/**
 * Resolves CodeBuddy Code and its ACP launch args. `cliPathOverride`
 * (Settings → Agent) takes priority; falls back to PATH/npm-prefix
 * auto-detection. Returns `null` when it cannot be found at all.
 *
 * `--acp` starts the ACP server on stdio (its default transport).
 * `--permission-mode default` pins the *process* to ask-first regardless of
 * what the user's own CodeBuddy settings default to — the product's
 * Agent/Plan/YOLO state is applied per session afterwards via
 * `session/set_mode` (see `profile.ts`), and a process that started on
 * `bypassPermissions` would have already skipped approvals for the first
 * turn by the time that lands.
 */
export const resolveCodebuddyCommand = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  cliPathOverride?: string,
): Promise<AcpResolvedCommand | null> => {
  const home = resolveUserHome(env, platform)
  const command =
    (await resolveConfiguredExecutable(cliPathOverride, home, platform)) ??
    (await findCodebuddyExecutable(env, platform))
  if (!command) return null
  return { command, args: ['--acp', '--permission-mode', 'default'] }
}
