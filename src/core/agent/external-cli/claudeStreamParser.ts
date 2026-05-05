// 解析 claude -p --output-format stream-json 的 NDJSON 输出
// 实测 schema（2026-05）：
//   stream_event: event.type === "content_block_delta" && event.delta.type === "text_delta" → 增量文本
//   assistant: message.content[] 含 text / tool_use / thinking
//   user: message.content[] 含 tool_result（content 是 string 或 {type:'text',text}[]）
//   result: 顶层 result 字段（非 message.result）
//   system: subtype 字段

export class ClaudeStreamParser {
  private lineBuffer = ''
  private gotAnyDelta = false

  constructor(
    private readonly opts: {
      onProgress: (line: string) => void
      onText: (chunk: string) => void
    },
  ) {}

  feed(chunk: string): void {
    this.lineBuffer += chunk
    const lines = this.lineBuffer.split('\n')
    // 最后一段可能是未完成的行，留在 buffer
    this.lineBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) this.processLine(line)
    }
  }

  finish(): void {
    if (this.lineBuffer.trim()) {
      this.processLine(this.lineBuffer)
      this.lineBuffer = ''
    }
  }

  private processLine(raw: string): void {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(raw) as Record<string, unknown>
    } catch {
      this.opts.onProgress(`[parse error] ${raw.slice(0, 80)}`)
      return
    }

    const type = event.type as string | undefined

    if (type === 'stream_event') {
      const ev = event.event as Record<string, unknown> | undefined
      const delta = ev?.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta') {
        const text = delta.text as string | undefined
        if (text) {
          this.opts.onText(text)
          this.gotAnyDelta = true
        }
        // text_delta 不发 onProgress，避免每个 token 都发
        return
      }
      // 其他 stream_event 子类型静默忽略（message_start/content_block_start/stop 等噪音太多）
      return
    }

    if (type === 'system') {
      const subtype = event.subtype as string | undefined
      if (subtype === 'init') {
        const sessionId = event.session_id as string | undefined
        this.opts.onProgress(
          `[system] init session_id=${sessionId ?? '(unknown)'}`,
        )
      }
      // 其他 system 子类型（status、post_turn_summary）静默忽略
      return
    }

    if (type === 'assistant') {
      const message = event.message as Record<string, unknown> | undefined
      const content = message?.content as unknown[] | undefined
      if (Array.isArray(content)) {
        for (const item of content) {
          const block = item as Record<string, unknown>
          if (block.type === 'tool_use') {
            const name = block.name as string | undefined
            const input = block.input
            // input 缺失时 JSON.stringify(undefined) 返回 undefined，slice 会抛
            const inputStr = JSON.stringify(input ?? null).slice(0, 100)
            this.opts.onProgress(`[tool] ${name ?? '?'}(${inputStr})`)
          } else if (block.type === 'thinking') {
            const text = (block.thinking as string | undefined) ?? ''
            this.opts.onProgress(`[thinking] ${text.slice(0, 200)}`)
          }
          // text block 忽略（delta 已累加，重复累加会导致输出翻倍）
        }
      }
      return
    }

    if (type === 'user') {
      const message = event.message as Record<string, unknown> | undefined
      const content = message?.content as unknown[] | undefined
      if (Array.isArray(content)) {
        for (const item of content) {
          const block = item as Record<string, unknown>
          if (block.type === 'tool_result') {
            const blockContent = block.content
            let text = ''
            if (typeof blockContent === 'string') {
              text = blockContent
            } else if (Array.isArray(blockContent)) {
              text = (blockContent as Record<string, unknown>[])
                .filter((c) => c.type === 'text')
                .map((c) => c.text as string)
                .join('')
            }
            this.opts.onProgress(`[tool result] ${text.slice(0, 200)}`)
          }
        }
      }
      return
    }

    if (type === 'result') {
      const durationMs = event.duration_ms as number | undefined
      const costUsd = event.total_cost_usd as number | undefined
      const numTurns = event.num_turns as number | undefined
      this.opts.onProgress(
        `[done] duration=${durationMs ?? '?'}ms cost=$${costUsd?.toFixed(4) ?? '?'} turns=${numTurns ?? '?'}`,
      )
      // fallback：没有收到任何 delta 时用 result 字段
      if (!this.gotAnyDelta) {
        const resultText = event.result as string | undefined
        if (resultText) {
          this.opts.onText(resultText)
        }
      }
      return
    }

    if (type === 'rate_limit_event') {
      // 静默忽略
      return
    }

    // 未知类型
    this.opts.onProgress(`[event] ${type ?? '(unknown)'}`)
  }
}
