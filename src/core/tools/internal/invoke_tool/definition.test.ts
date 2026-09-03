import {
  getInvokeTool,
  suggestToolNames,
  unwrapInvokeToolArguments,
} from './definition'

const KNOWN = ['notion__notion-search', 'notion__notion-fetch', 'cf__search']

const unwrap = (args: Record<string, unknown>, apiType?: 'gemini') =>
  unwrapInvokeToolArguments({ args, apiType, knownToolNames: KNOWN })

describe('getInvokeTool', () => {
  it('uses a native object for arguments on providers that allow it', () => {
    const schema = getInvokeTool('openai').inputSchema.properties?.arguments
    expect(schema).toMatchObject({ type: 'object', additionalProperties: true })
  })

  it('falls back to a JSON string only on Gemini, whose schema subset drops additionalProperties', () => {
    const schema = getInvokeTool('gemini').inputSchema.properties?.arguments
    expect(schema).toMatchObject({ type: 'string' })
  })
})

describe('unwrapInvokeToolArguments', () => {
  it('unwraps a well-formed call', () => {
    expect(
      unwrap({ tool_name: 'cf__search', arguments: { q: 'workers' } }),
    ).toEqual({ ok: true, toolName: 'cf__search', args: { q: 'workers' } })
  })

  it('treats an omitted arguments object as no arguments', () => {
    expect(unwrap({ tool_name: 'cf__search' })).toEqual({
      ok: true,
      toolName: 'cf__search',
      args: {},
    })
  })

  it('rejects a missing tool_name', () => {
    const result = unwrap({ arguments: {} })
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown tool name and reports near matches without applying one', () => {
    const result = unwrap({ tool_name: 'notion__notion_search', arguments: {} })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('notion__notion-search')
    expect(result.error).toContain('Did you mean')
  })

  it('parses the JSON string form on Gemini', () => {
    expect(
      unwrap({ tool_name: 'cf__search', arguments: '{"q":"x"}' }, 'gemini'),
    ).toEqual({ ok: true, toolName: 'cf__search', args: { q: 'x' } })
  })

  it('rejects malformed JSON on Gemini', () => {
    const result = unwrap({ tool_name: 'cf__search', arguments: '{' }, 'gemini')
    expect(result.ok).toBe(false)
  })

  it('rejects an array where an object is required', () => {
    expect(unwrap({ tool_name: 'cf__search', arguments: [] }).ok).toBe(false)
  })
})

describe('suggestToolNames', () => {
  it('returns nothing when nothing is close', () => {
    expect(suggestToolNames('zzzzzzzz', KNOWN)).toEqual([])
  })
})
