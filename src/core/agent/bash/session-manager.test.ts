jest.mock('shell-env', () => ({
  shellEnvSync: () => ({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHELL: '/bin/bash',
  }),
}))

jest.mock('./which', () => ({
  which: jest.fn().mockResolvedValue('/bin/bash'),
}))

import { backgroundTaskCompletionBus } from '../background-task/completion-bus'

import {
  killAllBashSessions,
  runBash,
  sessionManagerTimings,
} from './session-manager'

describe('terminal command session-manager', () => {
  const originalIdleWaitMs = sessionManagerTimings.idleWaitMs

  afterEach(() => {
    jest.useRealTimers()
    sessionManagerTimings.idleWaitMs = originalIdleWaitMs
    killAllBashSessions()
  })

  it('runs a foreground command and returns its exit code', async () => {
    const result = await runBash({
      command: 'printf hello',
      cwd: '/tmp',
      timeoutSeconds: 2,
    })

    expect(result.state).toBe('completed')
    expect(result.exit_code).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(result.stderr).toBe('')
  })

  it('separates stdout and stderr for foreground commands', async () => {
    const result = await runBash({
      command: `sh -c 'echo ok; echo err >&2; exit 2'`,
      cwd: '/tmp',
      timeoutSeconds: 2,
    })

    expect(result.state).toBe('completed')
    expect(result.exit_code).toBe(2)
    expect(result.stdout.trim()).toBe('ok')
    expect(result.stderr.trim()).toBe('err')
  })

  it('returns only tail lines when requested', async () => {
    const result = await runBash({
      command: `printf 'one\\ntwo\\nthree\\n'; printf 'warn-1\\nwarn-2\\n' >&2`,
      cwd: '/tmp',
      timeoutSeconds: 2,
      tailLines: 2,
    })

    expect(result.state).toBe('completed')
    expect(result.stdout).toBe('two\nthree\n')
    expect(result.stderr).toBe('warn-1\nwarn-2\n')
    expect(result.truncated).toEqual(
      expect.objectContaining({
        omittedBytes: expect.any(Number),
      }),
    )
  })

  it('returns only tail bytes when requested', async () => {
    const result = await runBash({
      command: `printf 'abcdef'; printf '123456' >&2`,
      cwd: '/tmp',
      timeoutSeconds: 2,
      tailBytes: 3,
    })

    expect(result.state).toBe('completed')
    expect(result.stdout).toBe('def')
    expect(result.stderr).toBe('456')
  })

  it('polls a running session immediately with tail lines', async () => {
    const started = await runBash({
      command: `sh -c 'i=0; while [ $i -lt 20 ]; do i=$((i+1)); echo "line-$i"; sleep 0.05; done; sleep 5'`,
      cwd: '/tmp',
      background: true,
      timeoutSeconds: 10,
    })
    expect(started.state).toBe('background')
    expect(started.session_id).toBeDefined()

    const beforePoll = Date.now()
    const polled = await runBash({
      sessionId: started.session_id,
      tailLines: 3,
      timeoutSeconds: 10,
    })

    expect(Date.now() - beforePoll).toBeLessThan(500)
    expect(polled.state).toBe('running')
    expect(polled.stdout).toBe('line-18\nline-19\nline-20\n')
  })

  it('runs consecutive one-shot commands without sharing a busy session', async () => {
    const first = await runBash({
      command: `sh -c 'printf ready; sleep 0.2'`,
      cwd: '/tmp',
      timeoutSeconds: 2,
    })
    const second = await runBash({
      command: 'printf next',
      cwd: '/tmp',
      timeoutSeconds: 2,
    })

    expect(first.state).toBe('completed')
    expect(first.stdout).toBe('ready')
    expect(second.state).toBe('completed')
    expect(second.stdout).toBe('next')
  })

  it('keeps the final session snapshot available for later tail polling in explicit session mode', async () => {
    const completed = await runBash({
      command: `printf 'one\\ntwo\\nthree\\n'`,
      cwd: '/tmp',
      background: true,
      timeoutSeconds: 2,
    })
    expect(completed.state).toBe('completed')
    expect(completed.session_id).toBeDefined()

    const polled = await runBash({
      sessionId: completed.session_id,
      tailLines: 2,
    })

    expect(polled.state).toBe('completed')
    expect(polled.stdout).toBe('two\nthree\n')
  })

  it('does not keep shell state across default one-shot commands', async () => {
    await runBash({
      command: 'cd /tmp',
      cwd: '/tmp',
      timeoutSeconds: 2,
    })
    const result = await runBash({
      command: 'pwd',
      cwd: '/',
      timeoutSeconds: 2,
    })

    expect(result.state).toBe('completed')
    expect(result.stdout.trim()).toBe('/')
  })

  it('keeps shell state when explicitly reusing a session', async () => {
    const started = await runBash({
      command: 'cd /tmp',
      cwd: '/',
      background: true,
      timeoutSeconds: 2,
    })
    expect(started.session_id).toBeDefined()

    const result = await runBash({
      command: 'pwd',
      sessionId: started.session_id,
      timeoutSeconds: 2,
    })

    expect(result.state).toBe('completed')
    expect(result.stdout.trim()).toBe('/tmp')
  })

  it('emits a background waiting event with separated output after idle', async () => {
    sessionManagerTimings.idleWaitMs = 100

    const subscriber = jest.fn()
    const unsubscribe = backgroundTaskCompletionBus.subscribe(subscriber)

    const resultPromise = runBash({
      command: `sh -c 'echo ready; echo warn >&2; sleep 30'`,
      cwd: '/tmp',
      background: true,
      timeoutSeconds: 60,
      conversationId: 'conv-1',
      source: {
        type: 'llm_tool_call',
        assistantMessageId: 'assistant-1',
        toolCallId: 'tool-1',
      },
    })

    const result = await resultPromise
    expect(result.state).toBe('background')

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal_command_waiting',
        conversationId: 'conv-1',
        record: expect.objectContaining({
          status: 'running',
          stdoutBuffer: expect.stringContaining('ready'),
          stderrBuffer: expect.stringContaining('warn'),
        }),
      }),
    )

    unsubscribe()
  })
})
