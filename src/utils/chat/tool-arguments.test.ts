import {
  extractTopLevelJsonObjects,
  mergeStreamingToolArguments,
  parseJsonObjectText,
} from './tool-arguments'

describe('tool-arguments utilities', () => {
  it('parses valid object JSON text', () => {
    expect(parseJsonObjectText('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObjectText('[]')).toBeNull()
    expect(parseJsonObjectText('oops')).toBeNull()
  })

  it('extracts multiple top-level objects from concatenated payloads', () => {
    const extracted = extractTopLevelJsonObjects(
      '{"action":"create_file","items":[{"path":"a.md","content":"x"}]}' +
        '{"action":"create_file","items":[{"path":"b.md","content":"y"}]}',
    )

    expect(extracted).toHaveLength(2)
    expect(extracted[0]).toEqual({
      action: 'create_file',
      items: [{ path: 'a.md', content: 'x' }],
    })
    expect(extracted[1]).toEqual({
      action: 'create_file',
      items: [{ path: 'b.md', content: 'y' }],
    })
  })

  it('recovers latest complete object when stream chunks are mixed', () => {
    const merged = mergeStreamingToolArguments({
      existingArgs:
        '{"action":"create_file","items":[{"path":"a.md","content":"x"}]}',
      newArgs:
        '{"action":"move","items":[{"oldPath":"a.md","newPath":"b.md"}]}',
    })

    expect(merged).toBe(
      '{"action":"move","items":[{"oldPath":"a.md","newPath":"b.md"}]}',
    )
  })

  it('keeps committed object when a later chunk adds noisy tail', () => {
    const merged = mergeStreamingToolArguments({
      existingArgs: '{"path":"a.md","operations":[{"type":"append"}]}',
      newArgs:
        '{"path":"a.md","operations":[{"type":"append"}]}\nTool arguments must be valid JSON',
    })

    expect(merged).toBe('{"path":"a.md","operations":[{"type":"append"}]}')
  })

  it('extracts latest object from noisy mixed stream payload', () => {
    const merged = mergeStreamingToolArguments({
      existingArgs: 'Let me reformat the tool arguments:',
      newArgs:
        'Args: {"path":"a.md","operations":[{"type":"append","content":"ok"}]} Error: ...',
    })

    expect(merged).toBe(
      '{"path":"a.md","operations":[{"type":"append","content":"ok"}]}',
    )
  })
})
