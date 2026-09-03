/* eslint-disable import/no-nodejs-modules -- loaded only inside the desktop CLI runtime boundary */
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import type { AcpResolvedCommand } from '../acp/agent-profile'
import { resolveWindowsSpawnablePath } from '../windows-spawn'

const existingFile = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
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

const cleanEnvironmentPath = (value: string): string =>
  value.trim().replace(/^"|"$/g, '')

const resolveUserHome = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string =>
  cleanEnvironmentPath(
    (platform === 'win32'
      ? firstEnvironmentValue(env, 'USERPROFILE', 'HOME')
      : firstEnvironmentValue(env, 'HOME', 'USERPROFILE')) ?? homedir(),
  )

const expandHomePath = (
  value: string,
  home: string,
  platform: NodeJS.Platform,
): string => {
  if (value === '~') return home
  if (value.startsWith('~/')) {
    return platform === 'win32'
      ? path.win32.join(home, value.slice(2))
      : path.join(home, value.slice(2))
  }
  return value
}

const resolveConfiguredExecutable = async (
  configuredPath: string | undefined,
  home: string,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  const trimmed = configuredPath ? cleanEnvironmentPath(configuredPath) : ''
  if (!trimmed) return null
  const expanded = expandHomePath(trimmed, home, platform)
  return resolveWindowsSpawnablePath(expanded, existingFile, platform)
}

export const findGrokExecutable = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  const home = resolveUserHome(env, platform)
  const configuredGrokHome = firstEnvironmentValue(env, 'GROK_HOME')
  const grokHome = configuredGrokHome
    ? expandHomePath(cleanEnvironmentPath(configuredGrokHome), home, platform)
    : ''
  const delimiter = platform === 'win32' ? ';' : ':'
  const pathEntries = (firstEnvironmentValue(env, 'PATH', 'Path', 'path') ?? '')
    .split(delimiter)
    .map(cleanEnvironmentPath)
    .filter(Boolean)
  const grokHomeEntries = grokHome
    ? [
        platform === 'win32'
          ? path.win32.join(grokHome, 'bin')
          : path.join(grokHome, 'bin'),
      ]
    : []
  const commonEntries =
    platform === 'win32'
      ? [home ? path.win32.join(home, '.grok', 'bin') : '']
      : [
          path.join(home, '.grok', 'bin'),
          path.join(home, '.local', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
          '/usr/bin',
        ]
  const names =
    platform === 'win32'
      ? ['grok.exe', 'grok.cmd', 'grok.bat', 'grok']
      : ['grok']

  for (const directory of unique(
    [...grokHomeEntries, ...pathEntries, ...commonEntries],
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

/** Resolve the official Grok CLI and launch a dedicated, ask-first ACP server. */
export const resolveGrokCommand = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  cliPathOverride?: string,
): Promise<AcpResolvedCommand | null> => {
  const home = resolveUserHome(env, platform)
  const command =
    (await resolveConfiguredExecutable(cliPathOverride, home, platform)) ??
    (await findGrokExecutable(env, platform))
  if (!command) return null
  return {
    command,
    args: [
      '--no-auto-update',
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      'stdio',
    ],
  }
}
