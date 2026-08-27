/* eslint-disable import/no-nodejs-modules -- loaded only inside the desktop CLI runtime boundary */
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import type { AcpResolvedCommand } from '../acp/agent-profile'
import { resolveWindowsSpawnablePath } from '../windows-spawn'

const firstEnvironmentValue = (
  env: NodeJS.ProcessEnv,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = env[key]
    if (value) return value
  }
  return undefined
}

const unique = (values: string[], platform: NodeJS.Platform): string[] => {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (!value) return false
    const key = platform === 'win32' ? value.toLowerCase() : value
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const existingFile = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const expandHomePath = (value: string, home: string): string => {
  if (value === '~') return home
  if (value.startsWith('~/')) return path.join(home, value.slice(2))
  return value
}

/**
 * A configured override that does not point at an existing file falls
 * through to auto-detection, so a path synced from another device never
 * makes things worse than having no override at all.
 */
const resolveConfiguredExecutable = async (
  configuredPath: string | undefined,
  home: string,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  const trimmed = configuredPath?.trim().replace(/^"|"$/g, '')
  if (!trimmed) return null
  const expanded =
    platform === 'win32' ? trimmed : expandHomePath(trimmed, home)
  return resolveWindowsSpawnablePath(expanded, existingFile, platform)
}

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
  const home = firstEnvironmentValue(env, 'HOME', 'USERPROFILE') ?? homedir()
  const delimiter = platform === 'win32' ? ';' : ':'
  const pathEntries = (firstEnvironmentValue(env, 'PATH', 'Path', 'path') ?? '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  const commonEntries =
    platform === 'win32'
      ? [
          home ? path.win32.join(home, '.local', 'bin') : '',
          env.APPDATA ? path.win32.join(env.APPDATA, 'Python', 'Scripts') : '',
        ]
      : [
          path.join(home, '.local', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
        ]
  const names =
    platform === 'win32'
      ? ['hermes.exe', 'hermes.cmd', 'hermes.bat', 'hermes']
      : ['hermes']

  for (const directory of unique(
    [...pathEntries, ...commonEntries],
    platform,
  )) {
    for (const name of names) {
      const candidate =
        platform === 'win32'
          ? path.win32.join(directory, name)
          : path.join(directory, name)
      if (await existingFile(candidate)) return candidate
    }
  }
  return null
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
  const home = firstEnvironmentValue(env, 'HOME', 'USERPROFILE') ?? homedir()
  const command =
    (await resolveConfiguredExecutable(cliPathOverride, home, platform)) ??
    (await findHermesExecutable(env, platform))
  if (!command) return null
  return { command, args: ['-p', profileId, 'acp'] }
}
