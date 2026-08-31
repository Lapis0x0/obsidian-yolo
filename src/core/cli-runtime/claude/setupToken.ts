import type { App } from 'obsidian'

import { getCliPathOverride } from '../cli-path-override'
import { assertCliRuntimeAvailable } from '../desktop'

import { resolveClaudeProcessSupport } from './process'

export type ClaudeSetupTokenResult = {
  token: string
}

const POLL_INTERVAL_MS = 700
const TIMEOUT_MS = 5 * 60 * 1000
const TOKEN_PATTERN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/
/**
 * Width of the pty the TUI renders into.
 *
 * The TUI wraps at the terminal width and writes each wrapped row separately,
 * with nothing marking the rows as one value — a token cut at column 80 reads
 * as a complete, shorter token, and is only found to be wrong when the API
 * rejects it. Rather than trying to detect that after the fact, the pty is made
 * wider than anything the TUI prints; the longest of those, the authorization
 * URL, is around 330 characters.
 */
const TRANSCRIPT_COLUMNS = 1000
const KNOWN_FAILURE_SNIPPETS = [
  'Failed to exchange authorization code',
  'Login failed',
]

const createAbortError = (): DOMException =>
  new DOMException('Claude setup-token login was cancelled.', 'AbortError')

/**
 * Reconstructs plain text from a `script`-captured PTY transcript so the
 * final long-lived token can be regex-matched reliably.
 *
 * The `claude setup-token` TUI (Ink) paints each cell of its layout at an
 * absolute column, so a single value arrives as one contiguous run of
 * characters between two escape sequences. Every escape and control byte is
 * therefore a boundary between unrelated cells and becomes a newline, which is
 * what stops a match from fusing across them. Values never have to be rejoined
 * across rows because the pty is opened wide enough that nothing wraps — see
 * `TRANSCRIPT_COLUMNS`.
 */
const reconstructTranscriptText = (raw: string): string =>
  raw
    // eslint-disable-next-line no-control-regex -- matching raw ANSI OSC bytes from a `script`-captured PTY transcript
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '\n')
    // eslint-disable-next-line no-control-regex -- matching raw ANSI CSI bytes from a `script`-captured PTY transcript
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '\n')
    // eslint-disable-next-line no-control-regex -- stripping remaining raw control bytes from a `script`-captured PTY transcript
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '\n')

export const extractToken = (transcript: string): string | null => {
  const match = reconstructTranscriptText(transcript).match(TOKEN_PATTERN)
  return match ? match[0] : null
}

export const extractKnownFailure = (transcript: string): string | null => {
  const cleaned = reconstructTranscriptText(transcript)
  return (
    KNOWN_FAILURE_SNIPPETS.find((snippet) => cleaned.includes(snippet)) ?? null
  )
}

const shellEscapeUnix = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`

const isJavaScriptEntrypoint = (command: string): boolean =>
  /\.(?:c|m)?js$/i.test(command)

type SpawnResult = {
  wait: Promise<void>
  kill: () => void
}

const spawnPtyRecordedSetupToken = async ({
  cliPath,
  nodePath,
  env,
  logPath,
  platform,
}: {
  cliPath: string
  nodePath: string | null
  env: Record<string, string | undefined>
  logPath: string
  platform: NodeJS.Platform
}): Promise<SpawnResult> => {
  // eslint-disable-next-line import/no-nodejs-modules -- evaluated only after the shared Desktop capability gate in runClaudeSetupToken
  const { spawn } = await import('node:child_process')

  const useNode = isJavaScriptEntrypoint(cliPath) && nodePath
  const targetCommand = useNode ? nodePath : cliPath
  const targetArgs = useNode ? [cliPath, 'setup-token'] : ['setup-token']
  const setupToken = [targetCommand, ...targetArgs]
    .map(shellEscapeUnix)
    .join(' ')
  // Widen the pty before the CLI starts, so no value it prints ever wraps.
  const command = `stty cols ${TRANSCRIPT_COLUMNS}; exec ${setupToken}`

  const child =
    platform === 'linux'
      ? spawn('script', ['-q', '-c', command, logPath], {
          env,
          stdio: 'ignore',
        })
      : spawn('script', ['-q', logPath, '/bin/sh', '-c', command], {
          env,
          stdio: 'ignore',
        })

  const wait = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => resolve())
  })

  return {
    wait,
    kill: () => {
      child.kill('SIGTERM')
    },
  }
}

/**
 * Drives `claude setup-token` end to end without any manual terminal step:
 * the CLI opens the user's browser for login on its own regardless of TTY
 * status, but only *prints* the authorization URL and the final token when
 * it believes it's attached to a real terminal. `script` gives it a pty
 * invisibly (no window) and mirrors the raw bytes to a temp file that we
 * poll and parse. macOS/Linux only — see `openClaudeSetupTokenTerminal` for
 * the Windows fallback, where no dependency-free pty capture exists.
 */
export const runClaudeSetupToken = async (
  app: App,
  signal?: AbortSignal,
): Promise<ClaudeSetupTokenResult> => {
  assertCliRuntimeAvailable('claude-code')

  if (process.platform === 'win32') {
    throw new Error(
      'Automated login is not supported on Windows yet. Use the terminal button instead.',
    )
  }

  if (signal?.aborted) {
    throw createAbortError()
  }

  const { cliPath, nodePath, env } = await resolveClaudeProcessSupport({
    configuredCliPath: getCliPathOverride(app, 'claude-code'),
  })

  // eslint-disable-next-line import/no-nodejs-modules -- evaluated only after the shared Desktop capability gate above
  const fs = await import('node:fs/promises')
  // eslint-disable-next-line import/no-nodejs-modules -- evaluated only after the shared Desktop capability gate above
  const os = await import('node:os')
  // eslint-disable-next-line import/no-nodejs-modules -- evaluated only after the shared Desktop capability gate above
  const path = await import('node:path')

  const logPath = path.join(
    os.tmpdir(),
    `yolo-claude-setup-token-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
  )

  const { wait: childExited, kill } = await spawnPtyRecordedSetupToken({
    cliPath,
    nodePath,
    env,
    logPath,
    platform: process.platform,
  })
  // A crashed/rejected spawn shouldn't surface as an unhandled rejection —
  // the polling loop below is the source of truth for success/failure.
  childExited.catch(() => undefined)

  let settled = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  const cleanup = async (): Promise<void> => {
    if (pollTimer) clearInterval(pollTimer)
    if (timeoutTimer) clearTimeout(timeoutTimer)
    kill()
    await fs.rm(logPath, { force: true })
  }

  return new Promise<ClaudeSetupTokenResult>((resolve, reject) => {
    const finish = (run: () => void | Promise<void>): void => {
      if (settled) return
      settled = true
      void cleanup()
        .catch(() => undefined)
        .finally(run)
    }

    const onAbort = () => {
      finish(() => reject(createAbortError()))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    timeoutTimer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            'Claude login timed out after 5 minutes. Please try again.',
          ),
        ),
      )
    }, TIMEOUT_MS)

    pollTimer = setInterval(() => {
      void (async () => {
        if (settled) return
        let transcript: string
        try {
          transcript = await fs.readFile(logPath, 'utf8')
        } catch {
          return
        }

        const token = extractToken(transcript)
        if (token) {
          finish(() => resolve({ token }))
          return
        }

        const failure = extractKnownFailure(transcript)
        if (failure) {
          finish(() => reject(new Error(`Claude login failed: ${failure}`)))
        }
      })()
    }, POLL_INTERVAL_MS)
  })
}

/**
 * Windows fallback: opens a visible console window running
 * `claude setup-token` directly (a real console, so the CLI renders fine and
 * still opens the browser automatically) but does not capture its output —
 * there is no dependency-free way to mirror a Windows console's bytes to a
 * file without giving up the console handle. The user copies the final
 * printed token into the existing manual-paste field.
 */
export const openClaudeSetupTokenTerminal = async (app: App): Promise<void> => {
  assertCliRuntimeAvailable('claude-code')

  const { cliPath } = await resolveClaudeProcessSupport({
    configuredCliPath: getCliPathOverride(app, 'claude-code'),
  })

  // eslint-disable-next-line import/no-nodejs-modules -- evaluated only after the shared Desktop capability gate above
  const { spawn } = await import('node:child_process')

  spawn(
    'cmd.exe',
    ['/c', 'start', '"Claude Login"', 'cmd.exe', '/k', cliPath, 'setup-token'],
    { detached: true, stdio: 'ignore', windowsHide: false },
  ).unref()
}
