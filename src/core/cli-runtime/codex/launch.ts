/* eslint-disable import/no-nodejs-modules -- loaded only inside the desktop CLI runtime boundary */
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
/* eslint-enable import/no-nodejs-modules */

import { resolveWindowsSpawnablePath } from '../windows-spawn'

export type ResolvedCodexLaunch = {
  command?: string
  launchArgs?: string[]
  runtimeCwd: string
  spawnCwd: string
  mapRuntimePathToHost?: (runtimePath: string) => string
}

const execFileAsync = promisify(execFile)

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

export const isWindowsStylePath = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/u.test(value) ||
  value.startsWith('\\\\') ||
  /\.(?:exe|cmd|bat)$/i.test(value)

/**
 * A configured override that does not point at an existing file falls through
 * to auto-detection, so a path synced from another device never makes things
 * worse than having no override at all.
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

export const findCodexExecutable = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
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
          home ? path.win32.join(home, 'scoop', 'shims') : '',
        ]
      : [
          path.join(home, '.local', 'bin'),
          path.join(home, '.volta', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
          '/usr/bin',
          // The Codex desktop app bundles the CLI binary; users who only
          // installed the app still get a working runtime.
          ...(platform === 'darwin'
            ? [
                path.join(
                  home,
                  'Applications',
                  'Codex.app',
                  'Contents',
                  'Resources',
                ),
                '/Applications/Codex.app/Contents/Resources',
                path.join(
                  home,
                  'Applications',
                  'Codex.app',
                  'Contents',
                  'MacOS',
                ),
                '/Applications/Codex.app/Contents/MacOS',
              ]
            : []),
        ]
  const names =
    platform === 'win32'
      ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']
      : ['codex']

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

export const inferWslDistro = (vaultPath: string): string | null => {
  const match = vaultPath
    .replace(/\//g, '\\')
    .match(/^\\\\wsl\$\\([^\\]+)(?:\\|$)/i)
  return match?.[1] ?? null
}

const decodeWslOutput = (output: string | Buffer): string => {
  if (typeof output === 'string') return output
  const sampleLength = Math.min(output.length - (output.length % 2), 512)
  let oddNulls = 0
  for (let index = 1; index < sampleLength; index += 2) {
    if (output[index] === 0) oddNulls += 1
  }
  const utf16 =
    (output[0] === 0xff && output[1] === 0xfe) ||
    (sampleLength >= 4 && oddNulls / (sampleLength / 2) >= 0.2)
  return output.toString(utf16 ? 'utf16le' : 'utf8')
}

export const parseDefaultWslDistro = (
  output: string | Buffer,
): string | null => {
  for (const line of decodeWslOutput(output)
    .replace(/\uFEFF/g, '')
    .split(/\r?\n/)) {
    const match = line.match(/^\s*\*\s*([^\s]+)/)
    if (match?.[1]) return match[1]
  }
  return null
}

const resolveDefaultWslDistro = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['--list', '--verbose'], {
      encoding: null,
      timeout: 5_000,
      windowsHide: true,
    })
    return parseDefaultWslDistro(stdout)
  } catch {
    return null
  }
}

export const windowsPathToWsl = (
  value: string,
  distro: string,
): string | null => {
  const normalized = value.replace(/\//g, '\\')
  const unc = normalized.match(/^\\\\wsl\$\\([^\\]+)(?:\\(.*))?$/i)
  if (unc) {
    if (unc[1].toLowerCase() !== distro.toLowerCase()) return null
    return `/${(unc[2] ?? '').replace(/\\/g, '/')}`.replace(/\/$/, '') || '/'
  }
  const drive = normalized.match(/^([A-Za-z]):(?:\\(.*))?$/)
  if (!drive) return null
  const tail = drive[2] ? `/${drive[2].replace(/\\/g, '/')}` : ''
  return `/mnt/${drive[1].toLowerCase()}${tail}`
}

export const wslPathToWindows = (value: string, distro: string): string => {
  const drive = value.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/)
  if (drive) {
    return `${drive[1].toUpperCase()}:\\${(drive[2] ?? '').replace(/\//g, '\\')}`
  }
  return `\\\\wsl$\\${distro}${value.replace(/\//g, '\\')}`
}

const wslHasCodex = async (
  distro: string,
  command: string,
): Promise<boolean> => {
  try {
    await execFileAsync(
      'wsl.exe',
      [
        '--distribution',
        distro,
        '--exec',
        'sh',
        '-lc',
        'command -v -- "$1"',
        'sh',
        command,
      ],
      { timeout: 5_000, windowsHide: true },
    )
    return true
  } catch {
    return false
  }
}

export const resolveCodexLaunch = async (
  vaultPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  configuredCliPath?: string,
): Promise<ResolvedCodexLaunch> => {
  const home = firstEnvironmentValue(env, 'HOME', 'USERPROFILE') ?? homedir()

  if (platform !== 'win32') {
    const command =
      (await resolveConfiguredExecutable(configuredCliPath, home, platform)) ??
      (await findCodexExecutable(env, platform)) ??
      undefined
    return { command, runtimeCwd: vaultPath, spawnCwd: vaultPath }
  }

  const pathDistro = inferWslDistro(vaultPath)
  const nativeCommand = pathDistro
    ? null
    : ((await resolveConfiguredExecutable(configuredCliPath, home, platform)) ??
      (await findCodexExecutable(env, platform)))
  if (nativeCommand) {
    return {
      command: nativeCommand,
      runtimeCwd: vaultPath,
      spawnCwd: vaultPath,
    }
  }

  // Inside WSL a configured non-Windows-style value overrides the command
  // the distribution resolves; Windows-style overrides only apply natively.
  const configuredWslCommand = configuredCliPath?.trim()
  const wslCommand =
    configuredWslCommand && !isWindowsStylePath(configuredWslCommand)
      ? configuredWslCommand
      : 'codex'

  const distro = pathDistro ?? (await resolveDefaultWslDistro())
  if (distro && (pathDistro || (await wslHasCodex(distro, wslCommand)))) {
    const runtimeCwd = windowsPathToWsl(vaultPath, distro)
    if (runtimeCwd) {
      return {
        command: 'wsl.exe',
        launchArgs: ['--distribution', distro, '--cd', runtimeCwd, wslCommand],
        runtimeCwd,
        spawnCwd: vaultPath,
        mapRuntimePathToHost: (runtimePath) =>
          wslPathToWindows(runtimePath, distro),
      }
    }
  }

  return { runtimeCwd: vaultPath, spawnCwd: vaultPath }
}
