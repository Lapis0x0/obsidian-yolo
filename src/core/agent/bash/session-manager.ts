// Desktop-only terminal command session manager. Imported lazily by bash/index.ts.
/* eslint-disable import/no-nodejs-modules -- desktop-only module, lazy-loaded behind Platform.isDesktop */
import { spawn } from 'node:child_process'
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
/* eslint-enable import/no-nodejs-modules */

import { spawn as crossSpawn } from 'cross-spawn'
import { v4 as uuidv4 } from 'uuid'

import type { TaskSource } from '../../../types/chat'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import { liveTaskStreamBus } from '../live-stream/taskStreamBus'

import type { ShellProvider } from './shell-provider'
import { resolveShellProvider } from './shell-provider'
import type { BashTaskRecord } from './types'

const MAX_OUTPUT_BYTES = 1 * 1024 * 1024
const TRUNCATE_HEAD_BYTES = 256 * 1024
const TRUNCATE_TAIL_BYTES = 256 * 1024
const SIGKILL_DELAY_MS = 3000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 10 * 60_000
const BACKGROUND_INITIAL_WAIT_MS = 2_000
export const sessionManagerTimings = {
  idleWaitMs: 10_000,
}
const SESSION_IDLE_TTL_MS = 5 * 60_000
const DONE_SETTLE_MS = 50

export type RunBashParams = {
  command?: string
  sessionId?: number
  input?: string
  background?: boolean
  cwd?: string
  timeoutSeconds?: number
  tailLines?: number
  tailBytes?: number
  kill?: boolean
  signal?: AbortSignal
  conversationId?: string
  source?: TaskSource
}

export type RunBashResult = {
  session_id?: number
  state:
    | 'completed'
    | 'running'
    | 'waiting'
    | 'background'
    | 'timeout'
    | 'killed'
  stdout: string
  stderr: string
  exit_code?: number | null
  truncated?: {
    totalBytes: number
    omittedBytes: number
  }
}

type ActiveCommand = {
  token: string
  source?: TaskSource
  stdoutCollector: CappedOutputCollector
  stderrCollector: CappedOutputCollector
  stdoutLineBuffer: string
  lastOutputAt: number
  exitCode?: number | null
  doneAt?: number
  backgroundRecord?: BashTaskRecord
  backgroundCompletedEmitted?: boolean
  backgroundIdleTimer?: ReturnType<typeof setTimeout> | null
  backgroundCompletionTimer?: ReturnType<typeof setTimeout> | null
  lastWaitingStdoutBytes: number
  lastWaitingStderrBytes: number
}

type CommandOutputSnapshot = {
  state: RunBashResult['state']
  stdout: string
  stderr: string
  exitCode?: number | null
  truncated?: {
    totalBytes: number
    omittedBytes: number
  }
}

type BashSession = {
  id: number
  provider: ShellProvider
  child: ChildProcessWithoutNullStreams
  stdoutDecoder: StringDecoder
  stderrDecoder: StringDecoder
  activeCommand: ActiveCommand | null
  lastSnapshot: CommandOutputSnapshot | null
  lastUsedAt: number
  killProcess: () => void
  cancelPendingKill: () => void
  waiters: Set<() => void>
}

const sessions = new Map<number, BashSession>()
let sharedSessionId: number | null = null
let nextSessionId = 1

class CappedOutputCollector {
  private fullChunks: Buffer[] = []
  private headChunks: Buffer[] = []
  private tailChunks: Buffer[] = []
  private tailBytes = 0
  private capped = false
  totalBytes = 0

  pushText(text: string): void {
    if (!text) return
    this.push(Buffer.from(text, 'utf8'))
  }

  private push(chunk: Buffer): void {
    this.totalBytes += chunk.length

    if (!this.capped) {
      if (this.totalBytes <= MAX_OUTPUT_BYTES) {
        this.fullChunks.push(chunk)
        return
      }
      this.capped = true
      const allSoFar = Buffer.concat([...this.fullChunks, chunk])
      this.fullChunks = []
      this.headChunks.push(allSoFar.subarray(0, TRUNCATE_HEAD_BYTES))
      if (allSoFar.length > TRUNCATE_HEAD_BYTES) {
        const leftover = allSoFar.subarray(TRUNCATE_HEAD_BYTES)
        this.tailChunks.push(leftover)
        this.tailBytes = leftover.length
        this.trimTail()
      }
      return
    }

    this.tailChunks.push(chunk)
    this.tailBytes += chunk.length
    this.trimTail()
  }

  private trimTail(): void {
    while (this.tailBytes > TRUNCATE_TAIL_BYTES && this.tailChunks.length > 0) {
      const front = this.tailChunks[0]
      if (this.tailBytes - front.length >= TRUNCATE_TAIL_BYTES) {
        this.tailBytes -= front.length
        this.tailChunks.shift()
      } else {
        const keep = TRUNCATE_TAIL_BYTES - (this.tailBytes - front.length)
        this.tailChunks[0] = front.subarray(front.length - keep)
        this.tailBytes = TRUNCATE_TAIL_BYTES
        break
      }
    }
  }

  finalize(extraText = ''): {
    text: string
    truncated?: { totalBytes: number; omittedBytes: number }
  } {
    if (!this.capped) {
      return {
        text: Buffer.concat(this.fullChunks).toString('utf8') + extraText,
      }
    }

    const headBuf = Buffer.concat(this.headChunks).subarray(
      0,
      TRUNCATE_HEAD_BYTES,
    )
    const tailBuf = Buffer.concat(this.tailChunks).subarray(
      -TRUNCATE_TAIL_BYTES,
    )
    const omittedBytes = Math.max(
      0,
      this.totalBytes - headBuf.length - tailBuf.length,
    )
    const marker = `\n\n... [输出过长，中间 ${omittedBytes} 字节已省略] ...\n\n`
    return {
      text:
        headBuf.toString('utf8') +
        marker +
        tailBuf.toString('utf8') +
        extraText,
      truncated: { totalBytes: this.totalBytes, omittedBytes },
    }
  }

  tail(
    extraText = '',
    options: TailOutputOptions,
    trimTrailingNewlineBeforeTail = false,
  ): {
    text: string
    truncated?: { totalBytes: number; omittedBytes: number }
  } {
    const rawBaseText = this.getAvailableTailText() + extraText
    const baseText = trimTrailingNewlineBeforeTail
      ? rawBaseText.replace(/\r?\n$/, '')
      : rawBaseText
    const text =
      options.tailLines !== undefined
        ? tailLines(baseText, options.tailLines)
        : tailBytes(baseText, options.tailBytes)
    return {
      text,
      truncated:
        this.capped || text !== baseText
          ? {
              totalBytes:
                this.totalBytes + Buffer.byteLength(extraText, 'utf8'),
              omittedBytes: Math.max(
                0,
                this.totalBytes +
                  Buffer.byteLength(extraText, 'utf8') -
                  Buffer.byteLength(text, 'utf8'),
              ),
            }
          : undefined,
    }
  }

  private getAvailableTailText(): string {
    if (!this.capped) {
      return Buffer.concat(this.fullChunks).toString('utf8')
    }
    return Buffer.concat(this.tailChunks).toString('utf8')
  }
}

type TailOutputOptions =
  | { tailLines: number; tailBytes?: undefined }
  | { tailLines?: undefined; tailBytes: number }

type OutputSnapshotOptions = {
  tail?: TailOutputOptions
}

const tailBytes = (text: string, maxBytes: number): string => {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return buffer.subarray(-maxBytes).toString('utf8')
}

const tailLines = (text: string, maxLines: number): string => {
  const hasTrailingNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (hasTrailingNewline) {
    lines.pop()
  }
  if (lines.length <= maxLines) return text
  return lines.slice(-maxLines).join('\n') + (hasTrailingNewline ? '\n' : '')
}

const trimDoneMarkerSeparator = (text: string): string => {
  return text.replace(/\r?\n$/, '')
}

const mergeTruncation = (
  stdout?: { totalBytes: number; omittedBytes: number },
  stderr?: { totalBytes: number; omittedBytes: number },
): { totalBytes: number; omittedBytes: number } | undefined => {
  if (!stdout && !stderr) return undefined
  return {
    totalBytes: (stdout?.totalBytes ?? 0) + (stderr?.totalBytes ?? 0),
    omittedBytes: (stdout?.omittedBytes ?? 0) + (stderr?.omittedBytes ?? 0),
  }
}

const createKillProcess = (child: ChildProcessWithoutNullStreams) => {
  let killed = false
  let killTimer: ReturnType<typeof setTimeout> | null = null

  const cancelPendingKill = () => {
    if (killTimer) {
      clearTimeout(killTimer)
      killTimer = null
    }
  }

  const killProcess = () => {
    if (killed) return
    killed = true
    if (child.pid === undefined) return

    if (process.platform === 'win32') {
      const fallbackKill = () => {
        try {
          child.kill()
        } catch {
          // process already exited
        }
      }
      try {
        const tk = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
          windowsHide: true,
          stdio: 'ignore',
        })
        tk.once('error', fallbackKill)
        tk.once('close', (code) => {
          if (code !== 0) fallbackKill()
        })
      } catch {
        fallbackKill()
      }
      return
    }

    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // process already exited
    }
    killTimer = setTimeout(() => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // process already exited
      }
    }, SIGKILL_DELAY_MS)
    killTimer.unref?.()
  }

  return { killProcess, cancelPendingKill }
}

const getOneShotSpawnArgs = (
  provider: ShellProvider,
  command: string,
): string[] => {
  if (provider.flavor === 'powershell') {
    return [
      ...provider.spawnArgs,
      '-Command',
      `${command}${provider.lineEnding}` +
        '$__yolo_exit = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }' +
        `${provider.lineEnding}exit $__yolo_exit`,
    ]
  }

  return [...provider.spawnArgs, '-c', command]
}

const notifyWaiters = (session: BashSession): void => {
  for (const waiter of session.waiters) waiter()
  session.waiters.clear()
}

const snapshotActiveCommand = (
  active: ActiveCommand,
  options: OutputSnapshotOptions = {},
): {
  stdout: string
  stderr: string
  truncated?: { totalBytes: number; omittedBytes: number }
} => {
  const commandDone = active.exitCode !== undefined
  const stdout = options.tail
    ? active.stdoutCollector.tail(
        active.stdoutLineBuffer,
        options.tail,
        commandDone,
      )
    : active.stdoutCollector.finalize(active.stdoutLineBuffer)
  const stderr = options.tail
    ? active.stderrCollector.tail('', options.tail)
    : active.stderrCollector.finalize()
  const stdoutText =
    commandDone && !options.tail
      ? trimDoneMarkerSeparator(stdout.text)
      : stdout.text
  return {
    stdout: stdoutText,
    stderr: stderr.text,
    truncated: mergeTruncation(stdout.truncated, stderr.truncated),
  }
}

const createCommandOutputSnapshot = (
  active: ActiveCommand,
  state: RunBashResult['state'],
  options: OutputSnapshotOptions = {},
): CommandOutputSnapshot => {
  const snapshot = snapshotActiveCommand(active, options)
  return {
    state,
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    ...(active.exitCode !== undefined ? { exitCode: active.exitCode } : {}),
    ...(snapshot.truncated ? { truncated: snapshot.truncated } : {}),
  }
}

const buildResultFromSnapshot = (
  session: BashSession,
  snapshot: CommandOutputSnapshot,
  options: OutputSnapshotOptions = {},
): RunBashResult => {
  const stdout = options.tail
    ? tailTextSnapshot(snapshot.stdout, options.tail)
    : {
        text: snapshot.stdout,
        truncated: snapshot.truncated,
      }
  const stderr = options.tail
    ? tailTextSnapshot(snapshot.stderr, options.tail)
    : {
        text: snapshot.stderr,
        truncated: undefined,
      }
  const truncated = options.tail
    ? (mergeTruncation(stdout.truncated, stderr.truncated) ??
      snapshot.truncated)
    : snapshot.truncated
  return {
    session_id: session.id,
    state: snapshot.state,
    stdout: stdout.text,
    stderr: stderr.text,
    ...(snapshot.exitCode !== undefined
      ? { exit_code: snapshot.exitCode }
      : {}),
    ...(truncated ? { truncated } : {}),
  }
}

const tailTextSnapshot = (
  text: string,
  options: TailOutputOptions,
): {
  text: string
  truncated?: { totalBytes: number; omittedBytes: number }
} => {
  const nextText =
    options.tailLines !== undefined
      ? tailLines(text, options.tailLines)
      : tailBytes(text, options.tailBytes)
  if (nextText === text) {
    return { text }
  }
  const totalBytes = Buffer.byteLength(text, 'utf8')
  return {
    text: nextText,
    truncated: {
      totalBytes,
      omittedBytes: Math.max(
        0,
        totalBytes - Buffer.byteLength(nextText, 'utf8'),
      ),
    },
  }
}

const clearBackgroundIdleTimer = (active: ActiveCommand | null): void => {
  if (!active?.backgroundIdleTimer) return
  clearTimeout(active.backgroundIdleTimer)
  active.backgroundIdleTimer = null
}

const clearBackgroundCompletionTimer = (active: ActiveCommand | null): void => {
  if (!active?.backgroundCompletionTimer) return
  clearTimeout(active.backgroundCompletionTimer)
  active.backgroundCompletionTimer = null
}

const pushLiveCommandStatus = (
  active: ActiveCommand | null,
  status: 'starting' | 'running' | 'done',
): void => {
  const toolCallId = active?.source?.toolCallId
  if (!toolCallId) return
  liveTaskStreamBus.push({
    type: 'status',
    toolCallId,
    status,
  })
}

const pushLiveCommandChunk = (
  active: ActiveCommand | null,
  type: 'stdout' | 'stderr',
  chunk: string,
): void => {
  const toolCallId = active?.source?.toolCallId
  if (!toolCallId || !chunk) return
  liveTaskStreamBus.push({
    type,
    toolCallId,
    chunk,
    ts: Date.now(),
  })
}

const createBashTaskRecord = ({
  command,
  conversationId,
  source,
  signal,
}: {
  command: string
  conversationId: string
  source: TaskSource
  signal?: AbortSignal
}): BashTaskRecord => {
  const abortController = new AbortController()
  signal?.addEventListener('abort', () => abortController.abort(), {
    once: true,
  })
  return {
    taskId: `bash_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
    conversationId,
    source,
    title: command.slice(0, 80),
    status: 'running',
    createdAt: Date.now(),
    stdoutBuffer: '',
    stderrBuffer: '',
    exitCode: null,
    abortController,
  }
}

const emitBackgroundCommandCompleted = (session: BashSession): void => {
  const active = session.activeCommand
  if (
    !active?.backgroundRecord ||
    active.backgroundCompletedEmitted ||
    active.exitCode === undefined
  ) {
    return
  }

  const doneAt = active.doneAt ?? Date.now()
  const settleRemainingMs = DONE_SETTLE_MS - (Date.now() - doneAt)
  if (settleRemainingMs > 0) {
    if (!active.backgroundCompletionTimer) {
      active.backgroundCompletionTimer = setTimeout(() => {
        active.backgroundCompletionTimer = null
        emitBackgroundCommandCompleted(session)
      }, settleRemainingMs)
      active.backgroundCompletionTimer.unref?.()
    }
    return
  }

  active.backgroundCompletedEmitted = true
  clearBackgroundIdleTimer(active)
  clearBackgroundCompletionTimer(active)
  const completedAt = Date.now()
  const snapshot = snapshotActiveCommand(active)
  const status = active.backgroundRecord.abortController.signal.aborted
    ? 'cancelled'
    : active.exitCode === 0
      ? 'completed'
      : 'failed'
  const updatedRecord: BashTaskRecord = {
    ...active.backgroundRecord,
    status,
    completedAt,
    stdoutBuffer: snapshot.stdout,
    stderrBuffer: snapshot.stderr,
    exitCode: active.exitCode ?? null,
  }

  session.lastSnapshot = {
    state:
      status === 'completed' || status === 'failed' ? 'completed' : 'killed',
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    exitCode: active.exitCode ?? null,
    ...(snapshot.truncated ? { truncated: snapshot.truncated } : {}),
  }

  backgroundTaskCompletionBus.pushCompleted({
    kind: 'terminal_command',
    taskId: updatedRecord.taskId,
    conversationId: updatedRecord.conversationId,
    record: updatedRecord,
  })

  pushLiveCommandStatus(active, 'done')
  session.activeCommand = null
  session.lastUsedAt = Date.now()
}

const writeToSession = (session: BashSession, text: string): void => {
  session.child.stdin.write(text, 'utf8')
}

const emitBackgroundCommandWaiting = (session: BashSession): void => {
  const active = session.activeCommand
  const record = active?.backgroundRecord
  if (!active || !record || active.exitCode !== undefined) return

  const stdoutBytes = active.stdoutCollector.totalBytes
  const stderrBytes = active.stderrCollector.totalBytes
  if (
    stdoutBytes === active.lastWaitingStdoutBytes &&
    stderrBytes === active.lastWaitingStderrBytes
  ) {
    return
  }

  active.lastWaitingStdoutBytes = stdoutBytes
  active.lastWaitingStderrBytes = stderrBytes
  const occurredAt = Date.now()
  const snapshot = snapshotActiveCommand(active)
  backgroundTaskCompletionBus.pushTerminalWaiting({
    kind: 'terminal_command_waiting',
    taskId: record.taskId,
    conversationId: record.conversationId,
    occurredAt,
    record: {
      ...record,
      status: 'running',
      stdoutBuffer: snapshot.stdout,
      stderrBuffer: snapshot.stderr,
      exitCode: null,
    },
  })
}

const scheduleBackgroundIdleTimer = (session: BashSession): void => {
  const active = session.activeCommand
  if (!active?.backgroundRecord || active.exitCode !== undefined) return

  if (active.backgroundIdleTimer) {
    clearTimeout(active.backgroundIdleTimer)
  }

  const delay = Math.max(
    0,
    sessionManagerTimings.idleWaitMs - (Date.now() - active.lastOutputAt),
  )
  active.backgroundIdleTimer = setTimeout(() => {
    active.backgroundIdleTimer = null
    emitBackgroundCommandWaiting(session)
  }, delay)
  active.backgroundIdleTimer.unref?.()
}

const handleSessionStdout = (session: BashSession, text: string): void => {
  if (!text) return
  const active = session.activeCommand
  if (active) {
    active.lastOutputAt = Date.now()
  }

  if (!active) {
    notifyWaiters(session)
    return
  }

  active.stdoutLineBuffer += text
  while (true) {
    const newlineIndex = active.stdoutLineBuffer.search(/\r?\n/)
    if (newlineIndex === -1) break

    const lineEnd =
      active.stdoutLineBuffer[newlineIndex] === '\r' &&
      active.stdoutLineBuffer[newlineIndex + 1] === '\n'
        ? newlineIndex + 2
        : newlineIndex + 1
    const line = active.stdoutLineBuffer.slice(0, lineEnd)
    active.stdoutLineBuffer = active.stdoutLineBuffer.slice(lineEnd)

    const marker = session.provider.parseDoneMarker(line)
    if (marker && marker.token === active.token) {
      active.exitCode = marker.exitCode
      active.doneAt = Date.now()
      emitBackgroundCommandCompleted(session)
      pushLiveCommandStatus(active, 'done')
      notifyWaiters(session)
      continue
    }

    active.stdoutCollector.pushText(line)
    pushLiveCommandChunk(active, 'stdout', line)
  }

  scheduleBackgroundIdleTimer(session)
  notifyWaiters(session)
}

const handleSessionStderr = (session: BashSession, text: string): void => {
  if (!text) return
  const active = session.activeCommand
  if (active) {
    active.lastOutputAt = Date.now()
    active.stderrCollector.pushText(text)
    pushLiveCommandChunk(active, 'stderr', text)
    scheduleBackgroundIdleTimer(session)
  }
  notifyWaiters(session)
}

const makeToken = (): string => {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

const assertDirectory = async (cwd: string): Promise<void> => {
  if (!isAbsolute(cwd)) {
    throw new Error(`cwd must be an absolute path: ${cwd}`)
  }
  const stats = await stat(cwd)
  if (!stats.isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwd}`)
  }
}

const cleanupIdleSessions = (): void => {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (id === sharedSessionId) continue
    if (session.activeCommand) continue
    if (now - session.lastUsedAt < SESSION_IDLE_TTL_MS) continue
    session.killProcess()
    sessions.delete(id)
  }
}

const createSession = async (cwd?: string): Promise<BashSession> => {
  const provider = await resolveShellProvider()
  const spawnOptions: SpawnOptions =
    process.platform === 'win32'
      ? {
          cwd,
          env: provider.env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      : {
          cwd,
          env: provider.env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }

  const spawnFn = process.platform === 'win32' ? crossSpawn : spawn
  const child = spawnFn(
    provider.binary,
    provider.spawnArgs,
    spawnOptions,
  ) as ChildProcessWithoutNullStreams
  const { killProcess, cancelPendingKill } = createKillProcess(child)

  const session: BashSession = {
    id: nextSessionId++,
    provider,
    child,
    stdoutDecoder: new StringDecoder('utf8'),
    stderrDecoder: new StringDecoder('utf8'),
    activeCommand: null,
    lastSnapshot: null,
    lastUsedAt: Date.now(),
    killProcess,
    cancelPendingKill,
    waiters: new Set(),
  }

  child.stdout.on('data', (chunk: Buffer) => {
    handleSessionStdout(session, session.stdoutDecoder.write(chunk))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    handleSessionStderr(session, session.stderrDecoder.write(chunk))
  })
  child.stdin.on('error', () => {
    // close/error events surface the failure; stdin errors can happen after kill.
  })
  child.once('error', (error) => {
    const active = session.activeCommand
    if (active && active.exitCode === undefined) {
      active.stderrCollector.pushText(`\nShell process error: ${error.message}`)
      pushLiveCommandChunk(
        active,
        'stderr',
        `\nShell process error: ${error.message}`,
      )
      active.exitCode = null
      active.doneAt = Date.now()
      pushLiveCommandStatus(active, 'done')
    }
    notifyWaiters(session)
  })
  child.once('close', (code) => {
    handleSessionStdout(session, session.stdoutDecoder.end())
    handleSessionStderr(session, session.stderrDecoder.end())
    session.cancelPendingKill()
    sessions.delete(session.id)
    if (sharedSessionId === session.id) sharedSessionId = null
    const active = session.activeCommand
    if (active && active.exitCode === undefined) {
      active.exitCode = code
      active.doneAt = Date.now()
    }
    emitBackgroundCommandCompleted(session)
    pushLiveCommandStatus(active, 'done')
    notifyWaiters(session)
  })

  sessions.set(session.id, session)
  if (provider.sessionInitScript.trim()) {
    writeToSession(session, provider.sessionInitScript + provider.lineEnding)
  }
  return session
}

const getSharedSession = async (cwd?: string): Promise<BashSession> => {
  if (sharedSessionId) {
    const existing = sessions.get(sharedSessionId)
    if (existing) return existing
  }
  const session = await createSession(cwd)
  sharedSessionId = session.id
  return session
}

const waitForChange = (
  session: BashSession,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const done = () => {
      if (timeout) clearTimeout(timeout)
      session.waiters.delete(done)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    session.waiters.add(done)
    signal?.addEventListener('abort', done, { once: true })
    timeout = setTimeout(done, 50)
  })
}

const buildResult = (
  session: BashSession,
  state: RunBashResult['state'],
  options: OutputSnapshotOptions = {},
): RunBashResult => {
  const active = session.activeCommand
  if (!active) {
    if (session.lastSnapshot) {
      return buildResultFromSnapshot(session, session.lastSnapshot, options)
    }
    return {
      session_id: session.id,
      state,
      stdout: '',
      stderr: '',
    }
  }

  const snapshot = createCommandOutputSnapshot(active, state, options)
  return buildResultFromSnapshot(session, snapshot)
}

const waitForCommandState = async ({
  session,
  background,
  timeoutMs,
  signal,
  backgroundRecordFactory,
  outputSnapshotOptions,
}: {
  session: BashSession
  background: boolean
  timeoutMs: number
  signal?: AbortSignal
  backgroundRecordFactory?: () => BashTaskRecord
  outputSnapshotOptions?: OutputSnapshotOptions
}): Promise<RunBashResult> => {
  const startedAt = Date.now()
  while (true) {
    const active = session.activeCommand
    if (!active) {
      return buildResult(session, 'completed')
    }

    if (signal?.aborted) {
      clearBackgroundIdleTimer(active)
      clearBackgroundCompletionTimer(active)
      session.killProcess()
      pushLiveCommandStatus(active, 'done')
      return buildResult(session, 'killed', outputSnapshotOptions)
    }

    if (active.exitCode !== undefined) {
      if (
        active.doneAt !== undefined &&
        Date.now() - active.doneAt < DONE_SETTLE_MS
      ) {
        await waitForChange(session, signal)
        continue
      }
      session.lastSnapshot = createCommandOutputSnapshot(active, 'completed')
      const result = buildResult(session, 'completed', outputSnapshotOptions)
      clearBackgroundIdleTimer(active)
      clearBackgroundCompletionTimer(active)
      session.activeCommand = null
      session.lastUsedAt = Date.now()
      pushLiveCommandStatus(active, 'done')
      return result
    }

    const now = Date.now()
    if (background && now - startedAt >= BACKGROUND_INITIAL_WAIT_MS) {
      if (backgroundRecordFactory && !active.backgroundRecord) {
        active.backgroundRecord = backgroundRecordFactory()
        scheduleBackgroundIdleTimer(session)
      }
      return buildResult(session, 'background', outputSnapshotOptions)
    }
    if (
      !background &&
      now - active.lastOutputAt >= sessionManagerTimings.idleWaitMs
    ) {
      return buildResult(session, 'waiting', outputSnapshotOptions)
    }
    if (!background && now - startedAt >= timeoutMs) {
      return buildResult(session, 'timeout', outputSnapshotOptions)
    }

    await waitForChange(session, signal)
  }
}

const resolveTimeoutMs = (timeoutSeconds?: number): number => {
  if (timeoutSeconds === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('timeout must be a positive number of seconds.')
  }
  return Math.min(Math.floor(timeoutSeconds * 1000), MAX_TIMEOUT_MS)
}

const resolveOutputSnapshotOptions = (
  params: RunBashParams,
): OutputSnapshotOptions => {
  if (params.tailLines !== undefined && params.tailBytes !== undefined) {
    throw new Error('tail_lines and tail_bytes cannot be used together.')
  }
  if (params.tailLines !== undefined) {
    if (!Number.isFinite(params.tailLines) || params.tailLines <= 0) {
      throw new Error('tail_lines must be a positive integer.')
    }
    return { tail: { tailLines: Math.floor(params.tailLines) } }
  }
  if (params.tailBytes !== undefined) {
    if (!Number.isFinite(params.tailBytes) || params.tailBytes <= 0) {
      throw new Error('tail_bytes must be a positive integer.')
    }
    return { tail: { tailBytes: Math.floor(params.tailBytes) } }
  }
  return {}
}

const buildOneShotResult = (
  active: ActiveCommand,
  state: RunBashResult['state'],
  options: OutputSnapshotOptions,
): RunBashResult => {
  const stdout = options.tail
    ? active.stdoutCollector.tail('', options.tail)
    : active.stdoutCollector.finalize()
  const stderr = options.tail
    ? active.stderrCollector.tail('', options.tail)
    : active.stderrCollector.finalize()
  const truncated = mergeTruncation(stdout.truncated, stderr.truncated)

  return {
    state,
    stdout: stdout.text,
    stderr: stderr.text,
    ...(active.exitCode !== undefined ? { exit_code: active.exitCode } : {}),
    ...(truncated ? { truncated } : {}),
  }
}

const runOneShotCommand = async ({
  command,
  cwd,
  timeoutMs,
  signal,
  source,
  outputSnapshotOptions,
}: {
  command: string
  cwd?: string
  timeoutMs: number
  signal?: AbortSignal
  source?: TaskSource
  outputSnapshotOptions: OutputSnapshotOptions
}): Promise<RunBashResult> => {
  const provider = await resolveShellProvider()
  const spawnOptions: SpawnOptions =
    process.platform === 'win32'
      ? {
          cwd,
          env: provider.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      : {
          cwd,
          env: provider.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
  const spawnFn = process.platform === 'win32' ? crossSpawn : spawn
  const child = spawnFn(
    provider.binary,
    getOneShotSpawnArgs(provider, command),
    spawnOptions,
  ) as ChildProcessWithoutNullStreams
  const { killProcess, cancelPendingKill } = createKillProcess(child)
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  const active: ActiveCommand = {
    token: '',
    source,
    stdoutCollector: new CappedOutputCollector(),
    stderrCollector: new CappedOutputCollector(),
    stdoutLineBuffer: '',
    lastOutputAt: Date.now(),
    backgroundIdleTimer: null,
    backgroundCompletionTimer: null,
    lastWaitingStdoutBytes: 0,
    lastWaitingStderrBytes: 0,
  }

  pushLiveCommandStatus(active, 'running')

  return new Promise((resolve) => {
    let resolved = false
    let forcedState: RunBashResult['state'] | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      signal?.removeEventListener('abort', handleAbort)
      cancelPendingKill()
    }

    const finish = (state: RunBashResult['state'], exitCode: number | null) => {
      if (resolved) return
      resolved = true
      active.stdoutCollector.pushText(stdoutDecoder.end())
      active.stderrCollector.pushText(stderrDecoder.end())
      active.exitCode = exitCode
      active.doneAt = Date.now()
      cleanup()
      pushLiveCommandStatus(active, 'done')
      resolve(buildOneShotResult(active, state, outputSnapshotOptions))
    }

    const handleAbort = () => {
      forcedState = 'killed'
      killProcess()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk)
      if (!text) return
      active.lastOutputAt = Date.now()
      active.stdoutCollector.pushText(text)
      pushLiveCommandChunk(active, 'stdout', text)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk)
      if (!text) return
      active.lastOutputAt = Date.now()
      active.stderrCollector.pushText(text)
      pushLiveCommandChunk(active, 'stderr', text)
    })
    child.once('error', (error) => {
      active.stderrCollector.pushText(`\nShell process error: ${error.message}`)
      finish(forcedState ?? 'completed', null)
    })
    child.once('close', (code) => {
      finish(forcedState ?? 'completed', code)
    })

    signal?.addEventListener('abort', handleAbort, { once: true })
    timeout = setTimeout(() => {
      forcedState = 'timeout'
      killProcess()
    }, timeoutMs)
    timeout.unref?.()

    if (signal?.aborted) {
      handleAbort()
    }
  })
}

export async function runBash(params: RunBashParams): Promise<RunBashResult> {
  cleanupIdleSessions()

  if (params.signal?.aborted) {
    return {
      state: 'killed',
      stdout: '',
      stderr: '',
    }
  }

  if (params.cwd) {
    await assertDirectory(params.cwd)
  }

  const timeoutMs = resolveTimeoutMs(params.timeoutSeconds)
  const outputSnapshotOptions = resolveOutputSnapshotOptions(params)
  const command = params.command?.trim()
  const shouldRunOneShot =
    !!command &&
    params.sessionId === undefined &&
    params.input === undefined &&
    params.kill !== true &&
    params.background !== true

  if (shouldRunOneShot) {
    return runOneShotCommand({
      command,
      cwd: params.cwd,
      timeoutMs,
      signal: params.signal,
      source: params.source,
      outputSnapshotOptions,
    })
  }

  const session =
    params.sessionId !== undefined
      ? sessions.get(params.sessionId)
      : params.background
        ? await createSession(params.cwd)
        : await getSharedSession(params.cwd)

  if (!session) {
    throw new Error(`Unknown terminal command session_id: ${params.sessionId}`)
  }

  session.lastUsedAt = Date.now()

  if (params.kill) {
    session.activeCommand?.backgroundRecord?.abortController.abort()
    clearBackgroundIdleTimer(session.activeCommand)
    clearBackgroundCompletionTimer(session.activeCommand)
    pushLiveCommandStatus(session.activeCommand, 'done')
    session.killProcess()
    sessions.delete(session.id)
    if (sharedSessionId === session.id) sharedSessionId = null
    return buildResult(session, 'killed')
  }

  if (params.input) {
    writeToSession(session, params.input)
  }

  const isPollOnly = params.sessionId !== undefined && !command && !params.input
  if (command) {
    if (session.activeCommand && session.activeCommand.exitCode === undefined) {
      throw new Error(
        `Session ${session.id} is already running a command. Poll it, send input, or kill it before starting another command.`,
      )
    }
    const token = makeToken()
    session.lastSnapshot = null
    session.activeCommand = {
      token,
      source: params.source,
      stdoutCollector: new CappedOutputCollector(),
      stderrCollector: new CappedOutputCollector(),
      stdoutLineBuffer: '',
      lastOutputAt: Date.now(),
      backgroundIdleTimer: null,
      backgroundCompletionTimer: null,
      lastWaitingStdoutBytes: 0,
      lastWaitingStderrBytes: 0,
    }
    pushLiveCommandStatus(session.activeCommand, 'running')
    writeToSession(
      session,
      session.provider.wrapCommand({
        command,
        token,
        cwd: params.cwd,
      }) + session.provider.lineEnding,
    )
  }

  if (isPollOnly) {
    const active = session.activeCommand
    return buildResult(
      session,
      active?.exitCode !== undefined ? 'completed' : 'running',
      outputSnapshotOptions,
    )
  }

  if (!session.activeCommand) {
    return buildResult(session, 'running', outputSnapshotOptions)
  }

  const backgroundCommand =
    params.background === true && command ? command : undefined

  return waitForCommandState({
    session,
    background: params.background === true,
    timeoutMs,
    signal: params.signal,
    outputSnapshotOptions,
    backgroundRecordFactory:
      backgroundCommand && params.conversationId && params.source
        ? () =>
            createBashTaskRecord({
              command: backgroundCommand,
              conversationId: params.conversationId!,
              source: params.source!,
              signal: params.signal,
            })
        : undefined,
  })
}

export function killAllBashSessions(): void {
  for (const session of sessions.values()) {
    try {
      clearBackgroundIdleTimer(session.activeCommand)
      clearBackgroundCompletionTimer(session.activeCommand)
      session.killProcess()
    } catch {
      // best-effort cleanup
    }
  }
  sessions.clear()
  sharedSessionId = null
}
