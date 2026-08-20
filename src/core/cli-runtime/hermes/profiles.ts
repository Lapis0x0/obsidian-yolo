/* eslint-disable import/no-nodejs-modules -- loaded only inside the desktop CLI runtime boundary */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import { parseYaml } from 'obsidian'

export const HERMES_DEFAULT_PROFILE_ID = 'default'

export type HermesProfile = Readonly<{
  id: string
  displayName: string
  /** Model configured in the profile's `config.yaml`, when it declares one. */
  model?: string
}>

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

/**
 * Root directory Hermes stores every profile under. `HERMES_HOME`, when set,
 * *is* the root (matches Hermes's own resolution — see `hermes -p`); otherwise
 * it defaults to `~/.hermes` (`%LOCALAPPDATA%/hermes` on Windows).
 */
export const resolveHermesRoot = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string => {
  const override = firstEnvironmentValue(env, 'HERMES_HOME')
  if (override) return override
  if (platform === 'win32') {
    const localAppData =
      firstEnvironmentValue(env, 'LOCALAPPDATA') ??
      path.win32.join(
        firstEnvironmentValue(env, 'USERPROFILE') ?? homedir(),
        'AppData',
        'Local',
      )
    return path.win32.join(localAppData, 'hermes')
  }
  const home = firstEnvironmentValue(env, 'HOME') ?? homedir()
  return path.join(home, '.hermes')
}

const joinPath = (platform: NodeJS.Platform, ...segments: string[]): string =>
  platform === 'win32' ? path.win32.join(...segments) : path.join(...segments)

/**
 * Reads a profile directory's display name from its `profile.yaml`. Returns
 * `null` when the file is missing, unreadable, or carries no usable `name`
 * field — callers fall back to the profile id in that case.
 */
const readProfileDisplayName = async (
  profileDir: string,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  try {
    const contents = await readFile(
      joinPath(platform, profileDir, 'profile.yaml'),
      'utf8',
    )
    const parsed: unknown = parseYaml(contents)
    const name =
      parsed && typeof parsed === 'object' && 'name' in parsed
        ? (parsed as { name: unknown }).name
        : undefined
    if (typeof name !== 'string') return null
    const trimmed = name.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/**
 * Reads a profile directory's configured model from its `config.yaml`.
 * Hermes accepts both a bare string and a `{ default, provider, ... }` map
 * there (mirrors `hermes_cli/profiles.py`'s `_read_config_model`), so both
 * shapes resolve here. Returns `null` when the file is missing, unreadable,
 * or declares no model.
 */
const readProfileModel = async (
  profileDir: string,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  try {
    const contents = await readFile(
      joinPath(platform, profileDir, 'config.yaml'),
      'utf8',
    )
    const parsed: unknown = parseYaml(contents)
    const model =
      parsed && typeof parsed === 'object' && 'model' in parsed
        ? (parsed as { model: unknown }).model
        : undefined
    const resolved =
      typeof model === 'string'
        ? model
        : model && typeof model === 'object'
          ? ((): unknown => {
              const { default: preferred, model: nested } = model as {
                default?: unknown
                model?: unknown
              }
              return typeof preferred === 'string' ? preferred : nested
            })()
          : undefined
    if (typeof resolved !== 'string') return null
    const trimmed = resolved.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/** Reads one profile directory's display name and model in one pass. */
const readProfile = async (
  id: string,
  profileDir: string,
  platform: NodeJS.Platform,
): Promise<HermesProfile> => {
  const [displayName, model] = await Promise.all([
    readProfileDisplayName(profileDir, platform),
    readProfileModel(profileDir, platform),
  ])
  return {
    id,
    displayName: displayName ?? id,
    ...(model ? { model } : {}),
  }
}

/**
 * Enumerates Hermes profiles under `<hermes root>/profiles/<id>/`. `default`
 * (the root `HERMES_HOME` directory itself) always exists as the first
 * entry, even when `profiles/` is missing entirely — Hermes always has at
 * least the root profile.
 */
export const discoverHermesProfiles = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<HermesProfile[]> => {
  const root = resolveHermesRoot(env, platform)
  const profiles: HermesProfile[] = [
    await readProfile(HERMES_DEFAULT_PROFILE_ID, root, platform),
  ]

  const profilesDir = joinPath(platform, root, 'profiles')
  let entries: string[]
  try {
    entries = (await readdir(profilesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return profiles
  }

  for (const id of [...entries].sort((a, b) => a.localeCompare(b))) {
    profiles.push(
      await readProfile(id, joinPath(platform, profilesDir, id), platform),
    )
  }
  return profiles
}
