import type {
  SpawnOptions,
  SpawnedProcess,
} from '@yolo/claude-agent-sdk-runtime'

import { assertCliRuntimeAvailable } from '../desktop'

import type { ClaudeProcessSupport } from './types'

type SpawnedChild = {
  stdin?: unknown
  stdout?: unknown
  stderr?: unknown
  kill(signal?: string | number): boolean | undefined
}

type SpawnImplementation = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: Record<string, string | undefined>
    stdio: ['pipe', 'pipe', 'pipe' | 'ignore']
    windowsHide: boolean
  },
) => SpawnedChild

type ResolveClaudeProcessSupportOptions = {
  configuredCliPath?: string
  loadEnvironment?: () => Promise<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  homedir?: string
  fileExists?: (path: string) => Promise<boolean>
  spawn?: SpawnImplementation
}

const isJavaScriptEntrypoint = (command: string): boolean =>
  /\.(?:c|m)?js$/i.test(command)

const getPathValue = (
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string => {
  if (platform === 'win32') {
    return env.PATH ?? env.Path ?? env.path ?? ''
  }
  return env.PATH ?? env.path ?? ''
}

const joinPath = (platform: NodeJS.Platform, ...parts: string[]): string => {
  const separator = platform === 'win32' ? '\\' : '/'
  const [head = '', ...tail] = parts
  const normalizedHead = head.replace(/[\\/]+$/, '')
  const normalizedTail = tail.map((part) =>
    part.replace(/^[\\/]+|[\\/]+$/g, ''),
  )
  return [normalizedHead, ...normalizedTail].filter(Boolean).join(separator)
}

const basename = (value: string): string =>
  value.split(/[\\/]/).filter(Boolean).at(-1) ?? value

const dirname = (value: string): string => {
  const separatorIndex = Math.max(
    value.lastIndexOf('/'),
    value.lastIndexOf('\\'),
  )
  return separatorIndex <= 0
    ? value.slice(0, separatorIndex + 1)
    : value.slice(0, separatorIndex)
}

const dedupePaths = (values: string[], platform: NodeJS.Platform): string[] => {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (!value) return false
    const key = platform === 'win32' ? value.toLowerCase() : value
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const findExisting = async (
  candidates: string[],
  fileExists: (path: string) => Promise<boolean>,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  for (const candidate of dedupePaths(candidates, platform)) {
    if (await fileExists(candidate)) return candidate
  }
  return null
}

const getClaudeCandidates = ({
  configuredCliPath,
  env,
  homedir,
  platform,
}: {
  configuredCliPath?: string
  env: Record<string, string | undefined>
  homedir: string
  platform: NodeJS.Platform
}): string[] => {
  const pathSeparator = platform === 'win32' ? ';' : ':'
  const pathEntries = getPathValue(env, platform)
    .split(pathSeparator)
    .filter(Boolean)
  const executableNames =
    platform === 'win32' ? ['claude.exe', 'claude'] : ['claude']
  const configuredPath = configuredCliPath?.trim()
  const candidates: string[] = []
  if (configuredPath) {
    if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(configuredPath)) {
      const configuredDirectory = dirname(configuredPath)
      candidates.push(
        joinPath(
          platform,
          configuredDirectory,
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'cli-wrapper.cjs',
        ),
        joinPath(
          platform,
          configuredDirectory,
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'cli.js',
        ),
      )
    } else {
      candidates.push(configuredPath)
    }
  }

  for (const entry of pathEntries) {
    for (const name of executableNames) {
      candidates.push(joinPath(platform, entry, name))
    }

    const prefix =
      basename(entry).toLowerCase() === 'bin' ? dirname(entry) : entry
    const packageParent =
      platform === 'win32' ? prefix : joinPath(platform, prefix, 'lib')
    candidates.push(
      joinPath(
        platform,
        packageParent,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'cli-wrapper.cjs',
      ),
      joinPath(
        platform,
        packageParent,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'cli.js',
      ),
    )
  }

  if (platform === 'win32') {
    candidates.push(
      joinPath(platform, homedir, '.claude', 'local', 'claude.exe'),
      joinPath(platform, homedir, '.local', 'bin', 'claude.exe'),
      joinPath(platform, homedir, 'AppData', 'Local', 'Claude', 'claude.exe'),
    )
  } else {
    candidates.push(
      joinPath(platform, homedir, '.claude', 'local', 'claude'),
      joinPath(platform, homedir, '.local', 'bin', 'claude'),
      joinPath(platform, homedir, '.volta', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    )
  }

  return candidates
}

const getNodeCandidates = ({
  env,
  homedir,
  platform,
}: {
  env: Record<string, string | undefined>
  homedir: string
  platform: NodeJS.Platform
}): string[] => {
  const pathSeparator = platform === 'win32' ? ';' : ':'
  const nodeName = platform === 'win32' ? 'node.exe' : 'node'
  const candidates = getPathValue(env, platform)
    .split(pathSeparator)
    .filter(Boolean)
    .map((entry) => joinPath(platform, entry, nodeName))

  if (platform === 'win32') {
    candidates.push(
      joinPath(
        platform,
        env.ProgramFiles ?? 'C:\\Program Files',
        'nodejs',
        'node.exe',
      ),
      joinPath(platform, homedir, '.volta', 'bin', 'node.exe'),
    )
  } else {
    candidates.push(
      joinPath(platform, homedir, '.volta', 'bin', 'node'),
      joinPath(platform, homedir, '.nvm', 'current', 'bin', 'node'),
      '/usr/local/bin/node',
      '/opt/homebrew/bin/node',
      '/usr/bin/node',
    )
  }
  return candidates
}

const loadDesktopEnvironment = async (): Promise<
  Record<string, string | undefined>
> => {
  const inherited = { ...process.env }
  try {
    const { shellEnvSync } = await import('shell-env')
    return { ...inherited, ...shellEnvSync() }
  } catch {
    return inherited
  }
}

const defaultFileExists = async (filePath: string): Promise<boolean> => {
  // eslint-disable-next-line import/no-nodejs-modules -- evaluated only after the shared Desktop capability gate
  const { stat } = await import('node:fs/promises')
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

export const createElectronSpawnFunction = ({
  spawn,
  nodePath,
}: {
  spawn: SpawnImplementation
  nodePath?: string
}): ((options: SpawnOptions) => SpawnedProcess) => {
  return (options) => {
    let command = options.command
    let args = [...options.args]
    if (command === 'node' || isJavaScriptEntrypoint(command)) {
      if (!nodePath) {
        throw new Error(
          'A full Node.js executable path is required to launch this Claude Code installation.',
        )
      }
    }
    if (command === 'node' && nodePath) {
      command = nodePath
    } else if (isJavaScriptEntrypoint(command) && nodePath) {
      args = [command, ...args]
      command = nodePath
    }

    const pipeStderr = Boolean(options.env?.DEBUG_CLAUDE_AGENT_SDK)
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', pipeStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
    })

    const abort = (): void => {
      child.kill('SIGTERM')
    }
    if (options.signal.aborted) {
      abort()
    } else {
      options.signal.addEventListener('abort', abort, { once: true })
    }

    if (!child.stdin || !child.stdout) {
      throw new Error('Claude CLI process did not expose stdin/stdout streams.')
    }
    return child as SpawnedProcess
  }
}

export const resolveClaudeProcessSupport = async (
  options: ResolveClaudeProcessSupportOptions = {},
): Promise<ClaudeProcessSupport> => {
  assertCliRuntimeAvailable('claude-code')

  const platform = options.platform ?? process.platform
  const homedir =
    options.homedir ??
    // eslint-disable-next-line import/no-nodejs-modules -- evaluated only after the shared Desktop capability gate
    (await import('node:os')).homedir()
  const fileExists = options.fileExists ?? defaultFileExists
  const environment = await (
    options.loadEnvironment ?? loadDesktopEnvironment
  )()
  const env = {
    ...environment,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'obsidian-yolo',
  }
  const cliPath = await findExisting(
    getClaudeCandidates({
      configuredCliPath: options.configuredCliPath,
      env,
      homedir,
      platform,
    }),
    fileExists,
    platform,
  )
  if (!cliPath) {
    throw new Error('Claude Code CLI was not found on this device.')
  }

  const nodePath = await findExisting(
    getNodeCandidates({ env, homedir, platform }),
    fileExists,
    platform,
  )

  const spawn =
    options.spawn ??
    // eslint-disable-next-line import/no-nodejs-modules -- evaluated only after the shared Desktop capability gate
    ((await import('node:child_process'))
      .spawn as unknown as SpawnImplementation)

  return {
    cliPath,
    env,
    spawnClaudeCodeProcess: createElectronSpawnFunction({
      spawn,
      nodePath: nodePath ?? undefined,
    }),
  }
}
