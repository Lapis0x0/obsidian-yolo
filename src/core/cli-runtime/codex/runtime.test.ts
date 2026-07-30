import type { CodexProcessExitListener, CodexProcessLike } from './process'
import { CodexCliRuntime } from './runtime'

class RpcFakeProcess implements CodexProcessLike {
  responses: unknown[] = []
  private lineListener: ((line: string) => void) | null = null
  private thread = {
    id: 'thread-1',
    preview: 'First prompt',
    path: '/sessions/thread-1.jsonl',
    cwd: '/vault',
    createdAt: 10,
    updatedAt: 20,
    name: null,
    turns: [],
  }

  write(line: string): void {
    const request = JSON.parse(line) as {
      id?: string | number
      method?: string
      result?: unknown
    }
    if (request.result !== undefined) {
      this.responses.push(request.result)
      return
    }
    if (request.id === undefined || !request.method) return
    const result =
      request.method === 'thread/list'
        ? { data: [this.thread], nextCursor: null }
        : request.method === 'thread/read'
          ? { thread: this.thread }
          : request.method === 'thread/start' || request.method === 'thread/resume'
            ? { thread: this.thread }
            : request.method === 'turn/start'
              ? { turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } }
              : {}
    queueMicrotask(() =>
      this.emit({ jsonrpc: '2.0', id: request.id, result }),
    )
  }
  onLine(listener: (line: string) => void): () => void {
    this.lineListener = listener
    return () => {
      this.lineListener = null
    }
  }
  onExit(_listener: CodexProcessExitListener): () => void {
    return () => undefined
  }
  getStderrSnapshot(): string {
    return ''
  }
  async shutdown(): Promise<void> {}
  emit(message: unknown): void {
    this.lineListener?.(JSON.stringify(message))
  }
}

describe('CodexCliRuntime', () => {
  it('lists vault sessions and starts a thread with assistant instructions', async () => {
    const process = new RpcFakeProcess()
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      createProcess: async () => process,
    })
    await expect(runtime.listSessions()).resolves.toMatchObject([
      {
        title: 'First prompt',
        ref: { runtimeId: 'codex', nativeSessionId: 'thread-1' },
      },
    ])

    const events: string[] = []
    runtime.subscribe((event) => events.push(event.type))
    await runtime.ensureReady({
      assistant: {
        assistantId: 'assistant-1',
        systemPrompt: 'Be precise.',
        enabledSkillNames: [],
      },
    })
    expect(events).toContain('session_bound')
  })

  it('surfaces server approvals and routes the UI decision back by tool id', async () => {
    const process = new RpcFakeProcess()
    const runtime = new CodexCliRuntime({
      cwd: '/vault',
      createProcess: async () => process,
    })
    const events: string[] = []
    runtime.subscribe((event) => {
      if (event.type === 'run_state') events.push(event.state)
    })
    await runtime.ensureReady({
      assistant: { systemPrompt: '', enabledSkillNames: [] },
    })
    process.emit({
      jsonrpc: '2.0',
      id: 91,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'command-1', command: 'pwd', cwd: '/vault' },
    })
    expect(events).toContain('waiting_for_approval')

    await runtime.respondApproval({
      requestId: 'command-1',
      decision: 'approve_for_session',
    })
    expect(process.responses).toContainEqual({ decision: 'acceptForSession' })
  })
})
