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
})
