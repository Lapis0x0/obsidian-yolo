/* eslint-disable import/no-nodejs-modules -- loaded only inside the desktop CLI runtime boundary */
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import { resolveWindowsSpawnablePath } from '../windows-spawn'

export type PiResolvedCommand = { command: string }

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
 * pi (earendil-works/pi, npm-distributed as `@earendil-works/*`, command
 * name still `pi`) is installed the same way Codex is — global npm/pnpm/
 * volta/nvm install — so this probes the same common bin directories rather
 * than Hermes's Python-tooling ones.
 */
export const findPiExecutable = async (
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
          env.APPDATA ? path.win32.join(env.APPDATA, 'npm') : '',
          env.LOCALAPPDATA
            ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'nodejs')
            : '',
          env.NVM_SYMLINK ?? '',
          env.VOLTA_HOME ? path.win32.join(env.VOLTA_HOME, 'bin') : '',
          env.PNPM_HOME ??
            (env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'pnpm') : ''),
          env.FNM_MULTISHELL_PATH ?? '',
        ]
      : [
          path.join(home, '.local', 'bin'),
          path.join(home, '.volta', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
          '/usr/bin',
        ]
  const names =
    platform === 'win32' ? ['pi.exe', 'pi.cmd', 'pi.bat', 'pi'] : ['pi']

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
 * Resolves the `pi` executable. `cliPathOverride` (Settings → Agent) takes
 * priority; falls back to PATH/common-install-dir auto-detection. Returns
 * `null` when pi cannot be found at all.
 */
export const resolvePiCommand = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  cliPathOverride?: string,
): Promise<PiResolvedCommand | null> => {
  const home = firstEnvironmentValue(env, 'HOME', 'USERPROFILE') ?? homedir()
  const command =
    (await resolveConfiguredExecutable(cliPathOverride, home, platform)) ??
    (await findPiExecutable(env, platform))
  if (!command) return null
  return { command }
}
