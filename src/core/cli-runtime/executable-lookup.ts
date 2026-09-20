/* eslint-disable import/no-nodejs-modules -- loaded only inside the desktop CLI runtime boundary */
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import { resolveWindowsSpawnablePath } from './windows-spawn'

/**
 * Shared "where is this CLI installed" probing for the desktop CLI runtimes.
 *
 * Every runtime answers the same question the same way — honour the Settings
 * → Agent path override first, otherwise walk the login-shell PATH plus a few
 * install locations that shell never picked up — and only the *inputs* differ
 * (which directories, which file names). Those inputs are what a runtime
 * declares here; the walk itself lives in one place so a third agent does not
 * mean a third copy of it.
 */

const existingFile = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Strips surrounding whitespace and the quotes a pasted shell path carries. */
const cleanEnvironmentPath = (value: string): string =>
  value.trim().replace(/^"|"$/g, '')

export const firstEnvironmentValue = (
  env: NodeJS.ProcessEnv,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = env[key]
    if (value) return value
  }
  return undefined
}

/** Joins with the *target* platform's rules, so cross-platform tests hold. */
export const joinForPlatform = (
  platform: NodeJS.Platform,
  ...segments: string[]
): string =>
  platform === 'win32' ? path.win32.join(...segments) : path.join(...segments)

export const resolveUserHome = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string =>
  cleanEnvironmentPath(
    (platform === 'win32'
      ? firstEnvironmentValue(env, 'USERPROFILE', 'HOME')
      : firstEnvironmentValue(env, 'HOME', 'USERPROFILE')) ?? homedir(),
  )

export const expandHomePath = (
  value: string,
  home: string,
  platform: NodeJS.Platform,
): string => {
  if (value === '~') return home
  if (value.startsWith('~/')) {
    return joinForPlatform(platform, home, value.slice(2))
  }
  return value
}

/** The login-shell PATH, split and cleaned into probeable directories. */
export const resolvePathEntries = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] =>
  (firstEnvironmentValue(env, 'PATH', 'Path', 'path') ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map(cleanEnvironmentPath)
    .filter(Boolean)

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

/**
 * A configured override that does not point at an existing file falls
 * through to auto-detection, so a path synced from another device never
 * makes things worse than having no override at all.
 */
export const resolveConfiguredExecutable = async (
  configuredPath: string | undefined,
  home: string,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  const trimmed = configuredPath ? cleanEnvironmentPath(configuredPath) : ''
  if (!trimmed) return null
  const expanded = expandHomePath(trimmed, home, platform)
  return resolveWindowsSpawnablePath(expanded, existingFile, platform)
}

/**
 * Probes `directories` in order for the first `names` entry that exists and
 * is executable. Directory order is the caller's priority order; duplicates
 * (case-insensitively on Windows) are probed once.
 */
export const findExecutableInDirectories = async (
  directories: readonly string[],
  names: readonly string[],
  platform: NodeJS.Platform,
): Promise<string | null> => {
  for (const directory of unique([...directories], platform)) {
    for (const name of names) {
      const candidate = joinForPlatform(platform, directory, name)
      if (await existingFile(candidate)) return candidate
    }
  }
  return null
}
