/* eslint-disable import/no-nodejs-modules -- desktop-only module, lazy-loaded behind Platform.isDesktop */
import { basename } from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import { shellEnvSync } from 'shell-env'

import { which } from './which'

export type ShellProviderFlavor = 'posix' | 'powershell'

export type ShellDoneMarker = {
  token: string
  exitCode: number
}

export type ShellProvider = {
  flavor: ShellProviderFlavor
  binary: string
  spawnArgs: string[]
  env: NodeJS.ProcessEnv
  lineEnding: string
  sessionInitScript: string
  wrapCommand: (params: {
    command: string
    token: string
    cwd?: string
  }) => string
  parseDoneMarker: (line: string) => ShellDoneMarker | null
}

const DONE_PREFIX = '__YOLO_DONE_'

const quotePosix = (value: string): string => {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const quotePowerShell = (value: string): string => {
  return `'${value.replace(/'/g, "''")}'`
}

const parseDoneMarkerLine = (line: string): ShellDoneMarker | null => {
  const match = line.trim().match(/^__YOLO_DONE_([A-Za-z0-9]+)_(-?\d+)__$/)
  if (!match) return null
  return {
    token: match[1],
    exitCode: Number(match[2]),
  }
}

const getPosixSpawnArgs = (binary: string): string[] => {
  const name = basename(binary)
  if (name.includes('bash')) {
    return ['--noprofile', '--norc']
  }
  if (name.includes('zsh')) {
    return ['-f']
  }
  return []
}

const createPosixProvider = (
  binary: string,
  env: NodeJS.ProcessEnv,
): ShellProvider => ({
  flavor: 'posix',
  binary,
  spawnArgs: getPosixSpawnArgs(binary),
  env,
  lineEnding: '\n',
  sessionInitScript: '',
  wrapCommand: ({ command, token, cwd }) => {
    if (!cwd) {
      return `{ ${command}\n}; __yolo_exit=$?; printf '\\n${DONE_PREFIX}${token}_%s__\\n' "$__yolo_exit"`
    }
    return (
      `if cd -- ${quotePosix(cwd)}; then\n` +
      `{ ${command}\n}; __yolo_exit=$?\n` +
      'else\n' +
      '__yolo_exit=$?\n' +
      'fi\n' +
      `printf '\\n${DONE_PREFIX}${token}_%s__\\n' "$__yolo_exit"`
    )
  },
  parseDoneMarker: parseDoneMarkerLine,
})

const createPowerShellProvider = (
  binary: string,
  env: NodeJS.ProcessEnv,
): ShellProvider => ({
  flavor: 'powershell',
  binary,
  spawnArgs: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'],
  env,
  lineEnding: '\r\n',
  sessionInitScript:
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Continue"',
  wrapCommand: ({ command, token, cwd }) => {
    const cdLine = cwd
      ? `Set-Location -LiteralPath ${quotePowerShell(cwd)}${'\r\n'}`
      : ''
    return (
      cdLine +
      `${command}${'\r\n'}` +
      '$__yolo_exit = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }' +
      `${'\r\n'}Write-Output ("${DONE_PREFIX}${token}_" + $__yolo_exit + "__")` +
      `${'\r\n'}$global:LASTEXITCODE = $null`
    )
  },
  parseDoneMarker: parseDoneMarkerLine,
})

const resolveFirstAvailable = async (
  candidates: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> => {
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      return candidate
    }
    const resolved = await which(candidate, env)
    if (resolved) return resolved
  }
  return null
}

export const resolveShellProvider = async (): Promise<ShellProvider> => {
  const env = shellEnvSync()

  if (process.platform === 'win32') {
    const binary = await resolveFirstAvailable(
      ['pwsh.exe', 'powershell.exe'],
      env,
    )
    if (!binary) {
      throw new Error('PowerShell executable not found in PATH.')
    }
    return createPowerShellProvider(binary, env)
  }

  const shellFromEnv = env.SHELL?.trim()
  const shellCandidates =
    shellFromEnv && /(bash|zsh|sh)$/.test(basename(shellFromEnv))
      ? [shellFromEnv, 'bash', 'zsh', 'sh']
      : ['bash', 'zsh', 'sh']
  const binary = await resolveFirstAvailable(shellCandidates, env)
  if (!binary) {
    throw new Error('No POSIX shell found in PATH.')
  }
  return createPosixProvider(binary, env)
}

export const __test__ = {
  createPosixProvider,
  createPowerShellProvider,
  parseDoneMarkerLine,
}
