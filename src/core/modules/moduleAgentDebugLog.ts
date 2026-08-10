import type { YoloModuleAgentEventV1, YoloModuleAgentRequestV1 } from './types'

type ModuleAgentToolDebugRecord = Readonly<{
  name: string
  status: string
  arguments?: Readonly<Record<string, unknown>>
}>

/** Collects content only after the host's raw-request debug opt-in is enabled. */
export class ModuleAgentDebugCollector {
  private readonly startedAt = Date.now()
  private output = ''
  private status: 'completed' | 'error' | null = null
  private errorMessage: string | undefined
  private readonly toolCalls: ModuleAgentToolDebugRecord[] = []

  constructor(
    private readonly moduleId: string,
    private readonly request: YoloModuleAgentRequestV1,
  ) {}

  record(event: YoloModuleAgentEventV1): void {
    if (event.type === 'text') {
      this.output = event.text || this.output + event.delta
      return
    }
    if (event.type === 'tool') {
      if (event.status !== 'completed' && event.status !== 'error') return
      this.toolCalls.push({
        name: event.name,
        status: event.status,
        ...(event.arguments ? { arguments: event.arguments } : {}),
      })
      return
    }
    if (event.type === 'completed') {
      this.output = event.text || this.output
      this.status = 'completed'
      return
    }
    if (event.type === 'error') {
      this.status = 'error'
      this.errorMessage = event.message
    }
  }

  emit(): void {
    if (!this.status) return
    const duration = ((Date.now() - this.startedAt) / 1000).toFixed(1)
    const activity = this.request.activity
      ? ` · ${this.request.activity.title}${this.request.activity.detail ? ` — ${this.request.activity.detail}` : ''}`
      : ''
    const model = this.request.modelId
      ? ` · model: ${this.request.modelId}`
      : ''
    // eslint-disable-next-line no-console -- Raw module generation diagnostics require the host debug opt-in.
    console.groupCollapsed(
      `[yolo-module-agent] ${this.moduleId} ${this.status}${activity}${model} · ${duration}s`,
    )
    if (this.errorMessage) console.debug(`error: ${this.errorMessage}`)
    if (this.toolCalls.length > 0) {
      console.debug(`tool-calls (${this.toolCalls.length}):`, this.toolCalls)
    }
    console.debug(`output length: ${this.output.length}`)
    console.debug('output:')
    console.debug(this.output)
    // eslint-disable-next-line no-console -- Close the opted-in module generation diagnostics group.
    console.groupEnd()
  }
}
