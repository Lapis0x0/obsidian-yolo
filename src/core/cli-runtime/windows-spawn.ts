/**
 * Windows CLI spawn helpers shared by Codex, pi, and ACP (Hermes).
 *
 * Recent Node/Electron refuse to `spawn()` a `.cmd`/`.bat` file directly
 * (`EINVAL`) — CreateProcess will not run batch scripts without going
 * through `cmd.exe`. Wrapping is the same pattern Codex already used;
 * killing must then target the whole process tree, because `SIGTERM` on
 * `cmd.exe` leaves the inner node/python process running.
 */

export type CliSpawnSpec = {
  command: string
  args: string[]
  killProcessTree: boolean
  windowsVerbatimArguments: boolean
}

type CliSpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore'; windowsHide: boolean },
) => { on: (event: 'error', listener: (error: Error) => void) => unknown }

const WINDOWS_BATCH_EXT = /\.(?:cmd|bat)$/i
const WINDOWS_SPAWNABLE_EXT = /\.(?:exe|cmd|bat|com)$/i
const WINDOWS_SHELL_META_CHARS = /([()%!^"`<>&|;, *?])/g

export const quoteWindowsShellArgument = (value: string): string => {
  const escaped = value
    // Windows argv parsing treats backslashes before a quote specially: the
    // slashes must be doubled before escaping the quote itself.
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    // The closing quote would consume trailing backslashes unless they are
    // doubled as well.
    .replace(/(?=(\\+?)?)\1$/g, '$1$1')
  return `"${escaped}"`.replace(WINDOWS_SHELL_META_CHARS, '^$1')
}

const quoteWindowsShellCommand = (value: string): string =>
  value.replace(WINDOWS_SHELL_META_CHARS, '^$1')

export const resolveCliSpawnSpec = (
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec || process.env.comspec || 'cmd.exe',
): CliSpawnSpec => {
  if (platform !== 'win32' || !WINDOWS_BATCH_EXT.test(command)) {
    return {
      command,
      args,
      killProcessTree: false,
      windowsVerbatimArguments: false,
    }
  }

  const shellCommand = [
    quoteWindowsShellCommand(command),
    ...args.map(quoteWindowsShellArgument),
  ].join(' ')
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    killProcessTree: true,
    windowsVerbatimArguments: true,
  }
}

export const killCliChild = (
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  spec: Pick<CliSpawnSpec, 'killProcessTree'>,
  spawn: CliSpawnFn,
  platform: NodeJS.Platform = process.platform,
): void => {
  if (
    platform === 'win32' &&
    spec.killProcessTree &&
    typeof child.pid === 'number'
  ) {
    spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => undefined)
    return
  }
  child.kill('SIGTERM')
}

/**
 * Git Bash `which pi` (and the first line of `where pi`) points at npm's
 * extensionless POSIX shim, which CreateProcess cannot run (`ENOENT`).
 * Prefer the sibling `.cmd`/`.bat`/`.exe` that npm also installs.
 */
export const resolveWindowsSpawnablePath = async (
  candidate: string,
  exists: (path: string) => Promise<boolean>,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  if (platform !== 'win32' || WINDOWS_SPAWNABLE_EXT.test(candidate)) {
    return (await exists(candidate)) ? candidate : null
  }
  for (const ext of ['.cmd', '.bat', '.exe']) {
    const sibling = `${candidate}${ext}`
    if (await exists(sibling)) return sibling
  }
  return (await exists(candidate)) ? candidate : null
}
