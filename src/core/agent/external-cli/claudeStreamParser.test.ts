import { ClaudeStreamParser } from './claudeStreamParser'

function makeParser() {
  const progress: string[] = []
  const textChunks: string[] = []
  const parser = new ClaudeStreamParser({
    onProgress: (line) => progress.push(line),
    onText: (chunk) => textChunks.push(chunk),
  })
  return { parser, progress, textChunks, text: () => textChunks.join('') }
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

// ────── 辅助事件构造 ──────

function systemInit(sessionId = 'sess-1') {
  return line({ type: 'system', subtype: 'init', session_id: sessionId })
}

function textDelta(text: string) {
  return line({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  })
}

function assistantMessage(content: { type: string; [k: string]: unknown }[]) {
  return line({ type: 'assistant', message: { content } })
}

function userMessage(content: { type: string; [k: string]: unknown }[]) {
  return line({ type: 'user', message: { content } })
}

function resultEvent(
  resultText: string,
  opts: { durationMs?: number; costUsd?: number; numTurns?: number } = {},
) {
  return line({
    type: 'result',
    result: resultText,
    duration_ms: opts.durationMs ?? 1000,
    total_cost_usd: opts.costUsd ?? 0.01,
    num_turns: opts.numTurns ?? 1,
  })
}

// ────── Tests ──────

describe('ClaudeStreamParser', () => {
  test('system/init 事件发 progress，含 session_id', () => {
    const { parser, progress } = makeParser()
    parser.feed(systemInit('abc-123'))
    expect(progress).toEqual(['[system] init session_id=abc-123'])
  })

  test('单个 text_delta：onText 累加，不发 progress', () => {
    const { parser, progress, textChunks } = makeParser()
    parser.feed(textDelta('hello'))
    expect(textChunks).toEqual(['hello'])
    expect(progress).toHaveLength(0)
  })

  test('多个 text_delta：拼成完整文本', () => {
    const { parser, text } = makeParser()
    parser.feed(textDelta('hello'))
    parser.feed(textDelta(' '))
    parser.feed(textDelta('world'))
    expect(text()).toBe('hello world')
  })

  test('assistant message 含 tool_use：发 progress 不发 onText', () => {
    const { parser, progress, textChunks } = makeParser()
    parser.feed(
      assistantMessage([
        { type: 'tool_use', name: 'Read', input: { path: '/foo' } },
      ]),
    )
    expect(textChunks).toHaveLength(0)
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatch(/^\[tool\] Read\(/)
  })

  test('assistant message 含 thinking：发 progress 不发 onText', () => {
    const { parser, progress, textChunks } = makeParser()
    parser.feed(
      assistantMessage([{ type: 'thinking', thinking: 'let me think...' }]),
    )
    expect(textChunks).toHaveLength(0)
    expect(progress[0]).toBe('[thinking] let me think...')
  })

  test('assistant message 含 text 且已有 delta：onText 不重复累加', () => {
    const { parser, text } = makeParser()
    parser.feed(textDelta('hi'))
    parser.feed(assistantMessage([{ type: 'text', text: 'hi' }]))
    // 只有 delta 那一次，assistant text block 不再加
    expect(text()).toBe('hi')
  })

  test('user message 含 tool_result（string content）：发 progress', () => {
    const { parser, progress } = makeParser()
    parser.feed(
      userMessage([
        { type: 'tool_result', tool_use_id: 'x', content: 'file content here' },
      ]),
    )
    expect(progress[0]).toBe('[tool result] file content here')
  })

  test('user message 含 tool_result（array content）：发 progress', () => {
    const { parser, progress } = makeParser()
    parser.feed(
      userMessage([
        {
          type: 'tool_result',
          tool_use_id: 'x',
          content: [
            { type: 'text', text: 'part1' },
            { type: 'text', text: 'part2' },
          ],
        },
      ]),
    )
    expect(progress[0]).toBe('[tool result] part1part2')
  })

  test('result 事件且已有 delta：不再调用 onText', () => {
    const { parser, textChunks, progress } = makeParser()
    parser.feed(textDelta('answer'))
    parser.feed(
      resultEvent('answer', { durationMs: 500, costUsd: 0.005, numTurns: 1 }),
    )
    // 只有 delta 那一次，result 不再 onText
    expect(textChunks).toEqual(['answer'])
    // 但会发一条 [done] progress
    expect(progress.some((p) => p.startsWith('[done]'))).toBe(true)
  })

  test('result 事件且无 delta：调用 onText(result.result) 作为 fallback', () => {
    const { parser, text, progress } = makeParser()
    parser.feed(resultEvent('fallback answer'))
    expect(text()).toBe('fallback answer')
    expect(progress.some((p) => p.startsWith('[done]'))).toBe(true)
  })

  test('chunk 跨行：半行在 chunk1，后半行在 chunk2', () => {
    const { parser, textChunks } = makeParser()
    const full = textDelta('split')
    const mid = Math.floor(full.length / 2)
    parser.feed(full.slice(0, mid))
    expect(textChunks).toHaveLength(0) // 还没收到 \n
    parser.feed(full.slice(mid))
    expect(textChunks).toEqual(['split'])
  })

  test('一个 chunk 含多行 JSON', () => {
    const { parser, text } = makeParser()
    parser.feed(textDelta('foo') + textDelta('bar'))
    expect(text()).toBe('foobar')
  })

  test('末尾无换行 + finish() flush', () => {
    const { parser, textChunks } = makeParser()
    // 末尾不带 \n
    const raw = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'end' },
      },
    })
    parser.feed(raw)
    expect(textChunks).toHaveLength(0)
    parser.finish()
    expect(textChunks).toEqual(['end'])
  })

  test('坏 JSON 行不抛、不影响后续行', () => {
    const { parser, progress, textChunks } = makeParser()
    parser.feed('not valid json\n')
    parser.feed(textDelta('ok'))
    expect(progress[0]).toMatch(/^\[parse error\]/)
    expect(textChunks).toEqual(['ok'])
  })

  test('tool_use 缺 input 字段不抛', () => {
    const { parser, progress } = makeParser()
    parser.feed(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read' }],
        },
      }),
    )
    expect(progress).toEqual(['[tool] Read(null)'])
  })

  // runner 用 StringDecoder 流式解码 Buffer，但 parser 自身只接 string；
  // 这里模拟"chunk 边界切在多字节字符中间"经过 StringDecoder 修复后的输入序列，
  // 验证 parser 能正常拼接 lineBuffer 跨 chunk 不丢字
  test('多字节字符跨 chunk（StringDecoder 兜底后）能正确累加', () => {
    const { parser, text } = makeParser()
    const full = textDelta('你好世界')
    // 在 JSON 内容中间任意位置切（不可能切坏 ASCII 边界，因为 StringDecoder 保证字符完整）
    const cut = Math.floor(full.length / 2)
    parser.feed(full.slice(0, cut))
    parser.feed(full.slice(cut))
    expect(text()).toBe('你好世界')
  })
})
