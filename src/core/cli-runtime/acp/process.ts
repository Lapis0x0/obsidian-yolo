import { loadDesktopNodeModule } from '../../../utils/platform/desktopNodeModule'
import { assertCliRuntimeAvailable } from '../desktop'
import type { CliRuntimeId } from '../types'
import {
  type CliSpawnSpec,
  killCliChild,
  resolveCliSpawnSpec,
} from '../windows-spawn'

type ChildProcess = import('node:child_process').ChildProcess
type NodeReadable = import('node:stream').Readable
type NodeWritable = import('node:stream').Writable

export type AcpProcessExitListener = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void

/**
 * Raw stdio handle for a spawned ACP agent process. Unlike Codex's
 * line-buffered `CodexProcessLike`, this exposes the underlying Node streams
 * directly — `transport.ts` bridges them into the ACP SDK's `Stream` (which
 * does its own NDJSON framing), so no line buffering happens here.
 */
export type AcpProcessLike = {
  readonly stdin: NodeWritable
  readonly stdout: NodeReadable
  onExit(listener: AcpProcessExitListener): () => void
  getStderrSnapshot(): string
  shutdown(): Promise<void>
}

export type AcpProcessOptions = {
  runtimeId: CliRuntimeId
  command: string
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

/** Spawns and owns one ACP agent subprocess. Mirrors `codex/process.ts`'s spawn/env/cleanup pattern. */
export class AcpChildProcess implements AcpProcessLike {
  private readonly exitListeners = new Set<AcpProcessExitListener>()
  private readonly started: Promise<void>
  private stderr = ''
  private termination:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined

  private constructor(
    private readonly runtimeId: CliRuntimeId,
    private readonly child: ChildProcess,
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
        const detail = `Failed to start ${this.runtimeId} ACP process: ${error.message}`
        this.stderr = `${this.stderr}${detail}`.slice(-8192)
        if (!settled) {
          settled = true
          reject(new Error(detail))
        }
        this.signalExit(null, null)
      })
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

  static async start(options: AcpProcessOptions): Promise<AcpChildProcess> {
    assertCliRuntimeAvailable(options.runtimeId)
    const { spawn } =
      await loadDesktopNodeModule<typeof import('node:child_process')>(
        'node:child_process',
      )
    const spec = resolveCliSpawnSpec(options.command, options.args)
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: await getProcessEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    })
    const process = new AcpChildProcess(options.runtimeId, child, spec, spawn)
    await process.started
    return process
  }

  get stdin(): NodeWritable {
    if (!this.child.stdin) {
      throw new Error(`${this.runtimeId} ACP process stdin is not available.`)
    }
    return this.child.stdin
  }

  get stdout(): NodeReadable {
    if (!this.child.stdout) {
      throw new Error(`${this.runtimeId} ACP process stdout is not available.`)
    }
    return this.child.stdout
  }

  onExit(listener: AcpProcessExitListener): () => void {
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
