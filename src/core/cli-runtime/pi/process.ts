import { loadDesktopNodeModule } from '../../../utils/platform/desktopNodeModule'
import { assertCliRuntimeAvailable } from '../desktop'
import {
  type CliSpawnSpec,
  killCliChild,
  resolveCliSpawnSpec,
} from '../windows-spawn'

type ChildProcess = import('node:child_process').ChildProcess
type StringDecoder = import('node:string_decoder').StringDecoder

export type PiProcessExitListener = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void

/**
 * Raw byte/text transport to the `pi` subprocess. Deliberately does *not*
 * buffer into lines — pi's JSONL framing rules (split only on `\n`, strip a
 * trailing `\r`, never a generic line-terminator regex) live in
 * `transport.ts` so they can be unit-tested against raw chunks without a real
 * child process.
 */
export type PiProcessLike = {
  write(text: string): void
  onData(listener: (chunk: string) => void): () => void
  onExit(listener: PiProcessExitListener): () => void
  getStderrSnapshot(): string
  shutdown(): Promise<void>
}

export type PiProcessOptions = {
  /** Resolved `pi` executable path (or override). */
  command: string
  /** `--mode rpc` plus any `--session <target>` args; caller-assembled. */
  args: string[]
  cwd: string
  env?: Record<string, string>
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

export class PiSubprocess implements PiProcessLike {
  private readonly dataListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<PiProcessExitListener>()
  private readonly started: Promise<void>
  private stderr = ''
  private termination:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined

  private constructor(
    private readonly child: ChildProcess,
    private readonly stdoutDecoder: StringDecoder,
    private readonly spawnSpec: CliSpawnSpec,
    private readonly spawn: typeof import('node:child_process').spawn,
  ) {
    this.started = new Promise<void>((resolve, reject) => {
      let settled = false
      child.once('spawn', () => {
        settled = true
        resolve()
      })
      child.on('error', (error) => {
        const detail = `Failed to start pi (${error.message})`
        this.stderr = `${this.stderr}${detail}`.slice(-8192)
        if (!settled) {
          settled = true
          reject(new Error(detail))
        }
        this.signalExit(null, null)
      })
    })
    // `StringDecoder` (not a per-chunk `.toString('utf8')`) so a multi-byte
    // UTF-8 character split across two `data` events decodes correctly
    // instead of turning into `�` — or, worse, corrupting a JSONL frame badly
    // enough that `JSON.parse` fails and the transport silently drops it.
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk)
        ? this.stdoutDecoder.write(chunk)
        : chunk
      if (text) for (const listener of this.dataListeners) listener(text)
    })
    child.stdout?.on('end', () => {
      const trailing = this.stdoutDecoder.end()
      if (trailing)
        for (const listener of this.dataListeners) listener(trailing)
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

  static async start(options: PiProcessOptions): Promise<PiSubprocess> {
    assertCliRuntimeAvailable('pi')
    const { spawn } =
      await loadDesktopNodeModule<typeof import('node:child_process')>(
        'node:child_process',
      )
    const { StringDecoder } = await loadDesktopNodeModule<
      typeof import('node:string_decoder')
    >('node:string_decoder')
    const command = options.command.trim()
    if (!command) {
      throw new Error(
        'pi CLI was not found. Install pi, or set a custom CLI path in Settings → Agent, then retry.',
      )
    }
    const env = await getProcessEnv(options.env)
    const spec = resolveCliSpawnSpec(command, options.args)
    // No `await` between `spawn()` and constructing `PiSubprocess` — the
    // constructor is what attaches the `'spawn'`/`'error'` listeners, and a
    // fast-starting process's `'spawn'` event must not have a chance to fire
    // (and be lost) before that listener exists.
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    })
    const process = new PiSubprocess(
      child,
      new StringDecoder('utf8'),
      spec,
      spawn,
    )
    await process.started
    return process
  }

  write(text: string): void {
    if (this.termination) {
      throw new Error(this.getStderrSnapshot() || 'pi process is not running.')
    }
    if (!this.child.stdin?.writable) {
      throw new Error('pi process stdin is closed.')
    }
    this.child.stdin.write(text)
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: PiProcessExitListener): () => void {
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
    if (this.termination || this.child.exitCode !== null || this.child.killed) {
      return
    }
    killCliChild(this.child, this.spawnSpec, this.spawn)
  }

  private signalExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.termination) return
    this.termination = { code, signal }
    for (const listener of this.exitListeners) listener(code, signal)
  }
}
