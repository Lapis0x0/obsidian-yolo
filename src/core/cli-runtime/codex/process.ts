import { loadDesktopNodeModule } from '../../../utils/platform/desktopNodeModule'
import { assertCliRuntimeAvailable } from '../desktop'

type ChildProcess = import('node:child_process').ChildProcess

export type CodexProcessExitListener = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void

export type CodexProcessLike = {
  write(line: string): void
  onLine(listener: (line: string) => void): () => void
  onExit(listener: CodexProcessExitListener): () => void
  getStderrSnapshot(): string
  shutdown(): Promise<void>
}

export type CodexProcessOptions = {
  command?: string
  cwd: string
  spawnCwd?: string
  launchArgs?: string[]
  env?: Record<string, string>
}

type SpawnSpec = {
  command: string
  args: string[]
  killProcessTree: boolean
  windowsVerbatimArguments: boolean
}

const quoteWindowsShellArgument = (value: string): string => {
  if (!value.length) return '""'
  if (!/[\s"&<>|{}^=;!'+,`~()%@[\]]/u.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

const resolveSpawnSpec = (
  command: string,
  launchArgs: string[] = [],
): SpawnSpec => {
  const args = [...launchArgs, 'app-server', '--listen', 'stdio://']
  if (process.platform !== 'win32' || !command.toLowerCase().endsWith('.cmd')) {
    return {
      command,
      args,
      killProcessTree: false,
      windowsVerbatimArguments: false,
    }
  }

  const shellCommand = [command, ...args]
    .map(quoteWindowsShellArgument)
    .join(' ')
  return {
    command: process.env.ComSpec || process.env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    killProcessTree: true,
    windowsVerbatimArguments: true,
  }
}

const getProcessEnv = async (
  customEnv?: Record<string, string>,
): Promise<Record<string, string>> => {
  const { shellEnvSync } = await import('shell-env')
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...shellEnvSync(),
    ...customEnv,
  }
}

export class CodexAppServerProcess implements CodexProcessLike {
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly exitListeners = new Set<CodexProcessExitListener>()
  private readonly started: Promise<void>
  private stderr = ''
  private stdoutBuffer = ''
  private termination:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined

  private constructor(
    private readonly child: ChildProcess,
    private readonly spawnSpec: SpawnSpec,
    private readonly spawn: typeof import('node:child_process').spawn,
  ) {
    this.started = new Promise<void>((resolve, reject) => {
      let settled = false
      child.once('spawn', () => {
        settled = true
        resolve()
      })
      child.on('error', (error) => {
        const detail = `Failed to start Codex app-server (${spawnSpec.command}): ${error.message}`
        this.stderr = `${this.stderr}${detail}`.slice(-8192)
        if (!settled) {
          settled = true
          reject(new Error(detail))
        }
        this.signalExit(null, null)
      })
    })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.stdoutBuffer += Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk)
      this.flushLines()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk)
      this.stderr = `${this.stderr}${text}`.slice(-8192)
    })
    child.on('close', (code, signal) => {
      this.signalExit(code, signal)
    })
  }

  static async start(
    options: CodexProcessOptions,
  ): Promise<CodexAppServerProcess> {
    assertCliRuntimeAvailable('codex')
    const { spawn } =
      await loadDesktopNodeModule<typeof import('node:child_process')>(
        'node:child_process',
      )
    const command = options.command?.trim()
    if (!command) {
      throw new Error(
        'Codex CLI was not found. Install Codex, or set a custom CLI path in Settings → Agent, then retry.',
      )
    }
    const spec = resolveSpawnSpec(command, options.launchArgs)
    const child = spawn(spec.command, spec.args, {
      cwd: options.spawnCwd ?? options.cwd,
      env: await getProcessEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    })
    const process = new CodexAppServerProcess(child, spec, spawn)
    await process.started
    return process
  }

  write(line: string): void {
    if (this.termination) {
      throw new Error(
        this.getStderrSnapshot() || 'Codex app-server is not running.',
      )
    }
    if (!this.child.stdin?.writable)
      throw new Error('Codex app-server stdin is closed.')
    this.child.stdin.write(line)
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener)
    return () => this.lineListeners.delete(listener)
  }

  onExit(listener: CodexProcessExitListener): () => void {
    if (this.termination) {
      const { code, signal } = this.termination
      queueMicrotask(() => listener(code, signal))
      return () => undefined
    }
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  getStderrSnapshot(): string {
    return this.stderr.trim()
  }

  async shutdown(): Promise<void> {
    if (this.termination || this.child.exitCode !== null || this.child.killed)
      return
    if (
      process.platform === 'win32' &&
      this.spawnSpec.killProcessTree &&
      typeof this.child.pid === 'number'
    ) {
      this.spawn('taskkill.exe', ['/pid', String(this.child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => undefined)
      return
    }
    this.child.kill('SIGTERM')
  }

  private signalExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.termination) return
    this.termination = { code, signal }
    for (const listener of this.exitListeners) listener(code, signal)
  }

  private flushLines(): void {
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      for (const listener of this.lineListeners) listener(line)
    }
  }
}
