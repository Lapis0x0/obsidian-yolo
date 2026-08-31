import { migrateFrom81To82 } from './81_to_82'

describe('migrateFrom81To82', () => {
  it('stamps the version', () => {
    const result = migrateFrom81To82({ version: 81 })
    expect(result.version).toBe(82)
  })

  it('drops includePatterns/excludePatterns/excludeYoloBaseDir from ragOptions, keeping the rest', () => {
    const result = migrateFrom81To82({
      version: 81,
      ragOptions: {
        enabled: true,
        chunkSize: 1234,
        includePatterns: ['a/**'],
        excludePatterns: ['b/**'],
        excludeYoloBaseDir: true,
        indexPdf: false,
      },
    })

    expect(result.ragOptions).toEqual({
      enabled: true,
      chunkSize: 1234,
      indexPdf: false,
    })
  })

  it('drops continuationOptions.knowledgeBaseFolders, keeping the rest', () => {
    const result = migrateFrom81To82({
      version: 81,
      continuationOptions: {
        continuationModelId: 'model-1',
        knowledgeBaseFolders: ['folder/a'],
        stream: true,
      },
    })

    expect(result.continuationOptions).toEqual({
      continuationModelId: 'model-1',
      stream: true,
    })
  })

  it('does not synthesize a knowledgeBases entry', () => {
    const result = migrateFrom81To82({ version: 81 })
    expect(result.knowledgeBases).toBeUndefined()
  })

  it('is a no-op safe default for empty/malformed data — never throws', () => {
    expect(() => migrateFrom81To82({ version: 81 })).not.toThrow()
    expect(() =>
      migrateFrom81To82({
        version: 81,
        ragOptions: null,
        continuationOptions: 'not-an-object',
      }),
    ).not.toThrow()

    const result = migrateFrom81To82({
      version: 81,
      ragOptions: null,
      continuationOptions: 'not-an-object',
    })
    expect(result.version).toBe(82)
    expect(result.ragOptions).toBeNull()
    expect(result.continuationOptions).toBe('not-an-object')
  })

  it('leaves unrelated top-level fields untouched', () => {
    const result = migrateFrom81To82({
      version: 81,
      chatModelId: 'gpt-5',
      assistants: [{ id: 'a1' }],
    })
    expect(result.chatModelId).toBe('gpt-5')
    expect(result.assistants).toEqual([{ id: 'a1' }])
  })
})
