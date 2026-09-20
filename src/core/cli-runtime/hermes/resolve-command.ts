import type { AcpResolvedCommand } from '../acp/agent-profile'
import {
  findExecutableInDirectories,
  joinForPlatform,
  resolveConfiguredExecutable,
  resolvePathEntries,
  resolveUserHome,
} from '../executable-lookup'

/**
 * Hermes (NousResearch/hermes-agent) is installed via `uv tool install` /
 * `pipx`, both of which default to `~/.local/bin` on macOS/Linux and a
 * per-user `Scripts` directory on Windows — not the npm-oriented locations
 * Claude/Codex probe. `install.sh` appends that directory to the user's
 * shell rc files, so the login-shell PATH (merged in by the caller) already
 * covers most installs; these are defensive fallbacks for shells that were
 * never restarted since install.
 */
export const findHermesExecutable = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  const home = resolveUserHome(env, platform)
  const commonEntries =
    platform === 'win32'
      ? [
          home ? joinForPlatform(platform, home, '.local', 'bin') : '',
          env.APPDATA
            ? joinForPlatform(platform, env.APPDATA, 'Python', 'Scripts')
            : '',
        ]
      : [
          joinForPlatform(platform, home, '.local', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
        ]
  const names =
    platform === 'win32'
      ? ['hermes.exe', 'hermes.cmd', 'hermes.bat', 'hermes']
      : ['hermes']

  return findExecutableInDirectories(
    [...resolvePathEntries(env, platform), ...commonEntries],
    names,
    platform,
  )
}

/**
 * Resolves the Hermes executable and its ACP launch args
 * (`hermes -p <profileId> acp`). `cliPathOverride` (Settings → Agent) takes
 * priority; falls back to PATH/common-install-dir auto-detection. Returns
 * `null` when Hermes cannot be found at all.
 *
 * `profileId` is always required and always forwarded as `-p`, including for
 * `'default'` — `hermes -p default acp` is confirmed equivalent to omitting
 * `-p` entirely, so there is no special case to omit it. Without this,
 * Hermes falls back to whatever profile the user last selected via
 * `hermes profile use` in a terminal (a process-wide sticky default this
 * plugin must not depend on).
 */
export const resolveHermesCommand = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  cliPathOverride: string | undefined,
  profileId: string,
): Promise<AcpResolvedCommand | null> => {
  const home = resolveUserHome(env, platform)
  const command =
    (await resolveConfiguredExecutable(cliPathOverride, home, platform)) ??
    (await findHermesExecutable(env, platform))
  if (!command) return null
  return { command, args: ['-p', profileId, 'acp'] }
}
