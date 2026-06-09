import { SETTINGS_SCHEMA_VERSION } from '../../settings/schema/migrations'
import { buildExportData, computeChecksum } from './export-config'
import {
  clearSensitive,
  hasNonEmptyCredentials,
  redactSensitive,
} from './redact'
import { CONFIG_EXPORT_FORMAT_VERSION } from './types'

describe('redactSensitive', () => {
  it('replaces apiKey/password with equal-length random strings', () => {
    const data = {
      id: 'provider-1',
      apiKey: 'sk-1234567890abcdef',
      baseUrl: 'https://api.example.com',
      webSearch: { type: 'searxng', password: 'p@ss123' },
    }
    const result = redactSensitive(data) as Record<string, unknown>
    expect(result.id).toBe('provider-1')
    expect(result.baseUrl).toBe('https://api.example.com')
    expect(result.apiKey).not.toBe('sk-1234567890abcdef')
    expect((result.apiKey as string).length).toBe('sk-1234567890abcdef'.length)
    const ws = result.webSearch as Record<string, unknown>
    expect(ws.password).not.toBe('p@ss123')
    expect((ws.password as string).length).toBe('p@ss123'.length)
  })

  it('handles empty sensitive values', () => {
    const data = { apiKey: '', password: '' }
    const result = redactSensitive(data) as Record<string, unknown>
    expect(result.apiKey).toBe('')
    expect(result.password).toBe('')
  })

  it('recursively redacts apiKey in nested objects/arrays', () => {
    const data = {
      providers: [
        { id: 'a', apiKey: 'key-aaa' },
        { id: 'b', apiKey: 'key-bbb' },
      ],
      webSearch: {
        providers: [{ id: 'c', apiKey: 'key-ccc' }],
      },
    }
    const result = redactSensitive(data) as Record<string, unknown>
    const providers = result.providers as Array<Record<string, unknown>>
    expect(providers[0].apiKey).not.toBe('key-aaa')
    expect((providers[0].apiKey as string).length).toBe('key-aaa'.length)

    const webSearch = result.webSearch as Record<string, unknown>
    const wsProviders = webSearch.providers as Array<Record<string, unknown>>
    expect(wsProviders[0].apiKey).not.toBe('key-ccc')
  })

  it('redacts every value inside headers / env objects', () => {
    const data = {
      mcp: {
        servers: [
          {
            id: 's1',
            parameters: {
              transport: 'http',
              url: 'https://example.com',
              headers: {
                Authorization: 'Bearer real-token',
                'X-Org': 'org-id',
              },
            },
          },
          {
            id: 's2',
            parameters: {
              transport: 'stdio',
              command: 'node',
              env: { OPENAI_API_KEY: 'sk-env', NODE_ENV: 'production' },
            },
          },
        ],
      },
    }
    const result = redactSensitive(data) as Record<string, unknown>
    const mcp = result.mcp as Record<string, unknown>
    const servers = mcp.servers as Array<Record<string, unknown>>

    const headers = (servers[0].parameters as Record<string, unknown>)
      .headers as Record<string, string>
    expect(headers.Authorization).not.toBe('Bearer real-token')
    expect(headers.Authorization.length).toBe('Bearer real-token'.length)
    expect(headers['X-Org']).not.toBe('org-id')

    const env = (servers[1].parameters as Record<string, unknown>)
      .env as Record<string, string>
    expect(env.OPENAI_API_KEY).not.toBe('sk-env')
    expect(env.NODE_ENV).not.toBe('production')
  })

  it("redacts each customHeaders entry's value but preserves its key", () => {
    const data = {
      providers: [
        {
          id: 'p1',
          customHeaders: [
            { key: 'Authorization', value: 'Bearer xyz' },
            { key: 'X-Trace', value: 'trace-1' },
          ],
        },
      ],
    }
    const result = redactSensitive(data) as Record<string, unknown>
    const providers = result.providers as Array<Record<string, unknown>>
    const headers = providers[0].customHeaders as Array<Record<string, string>>
    expect(headers[0].key).toBe('Authorization')
    expect(headers[0].value).not.toBe('Bearer xyz')
    expect(headers[0].value.length).toBe('Bearer xyz'.length)
    expect(headers[1].key).toBe('X-Trace')
    expect(headers[1].value).not.toBe('trace-1')
  })

  it('does not modify non-sensitive fields', () => {
    const data = {
      name: 'test',
      key: 'not-an-api-key',
      nested: { value: 123 },
    }
    const result = redactSensitive(data)
    expect(result).toEqual(data)
  })

  it('handles null and primitive values', () => {
    expect(redactSensitive(null)).toBeNull()
    expect(redactSensitive(42)).toBe(42)
    expect(redactSensitive('hello')).toBe('hello')
    expect(redactSensitive(undefined)).toBeUndefined()
  })
})

describe('clearSensitive', () => {
  it('clears every sensitive field covered by redactSensitive', () => {
    const data = {
      providers: [
        {
          apiKey: 'sk-real',
          customHeaders: [{ key: 'Authorization', value: 'Bearer real' }],
        },
      ],
      webSearch: { password: 'pw' },
      mcp: {
        servers: [
          {
            parameters: {
              headers: { Authorization: 'Bearer' },
              env: { TOKEN: 'tok' },
            },
          },
        ],
      },
    }
    const result = clearSensitive(data) as Record<string, unknown>
    const providers = result.providers as Array<Record<string, unknown>>
    expect(providers[0].apiKey).toBe('')
    const ch = providers[0].customHeaders as Array<Record<string, string>>
    expect(ch[0].value).toBe('')
    expect(ch[0].key).toBe('Authorization')
    expect((result.webSearch as Record<string, unknown>).password).toBe('')
    const mcpServers = (result.mcp as Record<string, unknown>).servers as Array<
      Record<string, unknown>
    >
    const params = mcpServers[0].parameters as Record<string, unknown>
    expect((params.headers as Record<string, string>).Authorization).toBe('')
    expect((params.env as Record<string, string>).TOKEN).toBe('')
  })
})

describe('hasNonEmptyCredentials', () => {
  it('returns false for empty / missing data', () => {
    expect(hasNonEmptyCredentials(undefined)).toBe(false)
    expect(hasNonEmptyCredentials(null)).toBe(false)
    expect(hasNonEmptyCredentials({})).toBe(false)
    expect(hasNonEmptyCredentials([])).toBe(false)
  })

  it('returns false when sensitive fields exist but are empty strings', () => {
    expect(
      hasNonEmptyCredentials({
        providers: [{ id: 'a', apiKey: '' }],
      }),
    ).toBe(false)
    expect(
      hasNonEmptyCredentials({
        mcp: {
          servers: [
            { parameters: { headers: { Authorization: '' }, env: {} } },
          ],
        },
      }),
    ).toBe(false)
  })

  it('returns true when apiKey contains a value', () => {
    expect(
      hasNonEmptyCredentials({
        providers: [{ id: 'a', apiKey: 'sk-real' }],
      }),
    ).toBe(true)
  })

  it('returns true when password contains a value', () => {
    expect(
      hasNonEmptyCredentials({
        providers: [{ type: 'searxng', password: 'pw' }],
      }),
    ).toBe(true)
  })

  it('returns true when any header value is non-empty', () => {
    expect(
      hasNonEmptyCredentials({
        mcp: {
          servers: [
            {
              parameters: {
                headers: { Authorization: 'Bearer x' },
              },
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('returns true when any env value is non-empty', () => {
    expect(
      hasNonEmptyCredentials({
        mcp: {
          servers: [{ parameters: { env: { OPENAI_API_KEY: 'sk-env' } } }],
        },
      }),
    ).toBe(true)
  })

  it('returns true when customHeaders has a non-empty value', () => {
    expect(
      hasNonEmptyCredentials({
        providers: [
          {
            customHeaders: [{ key: 'Authorization', value: 'Bearer xyz' }],
          },
        ],
      }),
    ).toBe(true)
  })

  it('returns false for typical category without configured credentials (Ollama-only providers)', () => {
    // 真实场景：用户只用本地 Ollama，没填 apiKey
    expect(
      hasNonEmptyCredentials({
        providers: [
          {
            id: 'ollama',
            presetType: 'ollama',
            baseUrl: 'http://localhost:11434',
            apiKey: '',
          },
        ],
      }),
    ).toBe(false)
  })

  it('returns false for stdio MCP server without env', () => {
    expect(
      hasNonEmptyCredentials({
        servers: [
          {
            parameters: {
              transport: 'stdio',
              command: 'npx',
              args: ['some-mcp'],
            },
          },
        ],
      }),
    ).toBe(false)
  })

  it('returns true if any element in an array has credentials', () => {
    expect(
      hasNonEmptyCredentials({
        providers: [
          { id: 'a', apiKey: '' },
          { id: 'b', apiKey: 'sk-only-on-b' },
        ],
      }),
    ).toBe(true)
  })

  it('ignores unrelated string fields with credential-like names', () => {
    // 字段名不在白名单（如 key/secret/token）一律不算
    expect(
      hasNonEmptyCredentials({
        providers: [{ id: 'a', key: 'not-an-apikey', token: 'still-no' }],
      }),
    ).toBe(false)
  })
})

describe('computeChecksum', () => {
  it('should produce a hex string of 64 characters (SHA-256)', async () => {
    const hash = await computeChecksum('hello world')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('should produce different hashes for different inputs', async () => {
    const hash1 = await computeChecksum('hello')
    const hash2 = await computeChecksum('world')
    expect(hash1).not.toBe(hash2)
  })

  it('should produce the same hash for the same input', async () => {
    const hash1 = await computeChecksum('test content')
    const hash2 = await computeChecksum('test content')
    expect(hash1).toBe(hash2)
  })
})

describe('buildExportData', () => {
  const mockSettings: Record<string, unknown> = {
    version: 51,
    __meta: { deviceId: 'test-device', updatedAt: 123456 },
    providers: [
      { id: 'ds', apiKey: 'sk-secret', baseUrl: 'https://api.deepseek.com' },
    ],
    chatModels: [{ id: 'ds/model', model: 'model', providerId: 'ds' }],
    chatModelId: 'ds/model',
    ragOptions: { enabled: true, chunkSize: 1000 },
    systemPrompt: 'hello',
  }

  it('should export only selected keys', async () => {
    const result = await buildExportData({
      keys: ['providers', 'chatModelId'],
      settingsData: mockSettings,
      pluginVersion: '1.5.7.5',
    })

    expect(result.$schema).toBe('yolo-config-export')
    expect(result.formatVersion).toBe(CONFIG_EXPORT_FORMAT_VERSION)
    expect(result.settingsVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(result.pluginVersion).toBe('1.5.7.5')
    expect(result.redacted).toBe(false)
    expect(result.keys).toEqual(['providers', 'chatModelId'])
    expect(result.data).toHaveProperty('providers')
    expect(result.data).toHaveProperty('chatModelId')
    expect(result.data).not.toHaveProperty('ragOptions')
    expect(result.data).not.toHaveProperty('chatModels')
  })

  it('should exclude internal keys (version, __meta) even if selected', async () => {
    const result = await buildExportData({
      keys: ['version', '__meta', 'providers'],
      settingsData: mockSettings,
      pluginVersion: '1.5.7.5',
    })

    expect(result.data).not.toHaveProperty('version')
    expect(result.data).not.toHaveProperty('__meta')
    expect(result.data).toHaveProperty('providers')
  })

  it('should redact API keys when redacted option is true', async () => {
    const result = await buildExportData({
      keys: ['providers'],
      settingsData: mockSettings,
      pluginVersion: '1.5.7.5',
      redacted: true,
    })

    expect(result.redacted).toBe(true)
    const providers = result.data.providers as Array<Record<string, unknown>>
    expect(providers[0].apiKey).not.toBe('sk-secret')
    expect((providers[0].apiKey as string).length).toBe('sk-secret'.length)
    expect(providers[0].baseUrl).toBe('https://api.deepseek.com')
  })

  it('should not redact API keys when redacted option is false', async () => {
    const result = await buildExportData({
      keys: ['providers'],
      settingsData: mockSettings,
      pluginVersion: '1.5.7.5',
      redacted: false,
    })

    expect(result.redacted).toBe(false)
    const providers = result.data.providers as Array<Record<string, unknown>>
    expect(providers[0].apiKey).toBe('sk-secret')
  })

  it('should include a valid checksum', async () => {
    const result = await buildExportData({
      keys: ['chatModelId'],
      settingsData: mockSettings,
      pluginVersion: '1.5.7.5',
    })

    expect(result.checksum).toHaveLength(64)
    expect(result.checksum).toMatch(/^[0-9a-f]+$/)

    // Verify checksum matches payload without checksum field
    const { checksum, ...payload } = result
    const expectedChecksum = await computeChecksum(JSON.stringify(payload))
    expect(checksum).toBe(expectedChecksum)
  })

  it('should handle keys that do not exist in settings', async () => {
    const result = await buildExportData({
      keys: ['nonExistentKey', 'chatModelId'],
      settingsData: mockSettings,
      pluginVersion: '1.5.7.5',
    })

    expect(result.data).not.toHaveProperty('nonExistentKey')
    expect(result.data).toHaveProperty('chatModelId')
  })

  it('should produce empty data when all selected keys are missing from settings', async () => {
    const result = await buildExportData({
      keys: ['nonExistent1', 'nonExistent2'],
      settingsData: mockSettings,
      pluginVersion: '1.5.7.5',
    })

    expect(result.keys).toEqual(['nonExistent1', 'nonExistent2'])
    expect(Object.keys(result.data)).toHaveLength(0)
  })

  it('should handle empty keys array', async () => {
    const result = await buildExportData({
      keys: [],
      settingsData: mockSettings,
      pluginVersion: '1.5.7.5',
    })

    expect(result.keys).toEqual([])
    expect(Object.keys(result.data)).toHaveLength(0)
  })
})
