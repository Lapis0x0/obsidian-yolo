import type { RequestUrlParam, RequestUrlResponse } from 'obsidian'

import { ModuleLifecycleScope } from './lifecycleScope'
import { ModuleNetworkCapabilityProvider } from './moduleNetwork'

const response = (
  status: number,
  headers: Record<string, string> = {},
): RequestUrlResponse =>
  ({
    status,
    headers,
    arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
  }) as RequestUrlResponse

describe('ModuleNetworkCapabilityProvider', () => {
  test("fetches a web resource's bytes through Obsidian", async () => {
    const asked: RequestUrlParam[] = []
    const provider = new ModuleNetworkCapabilityProvider(async (param) => {
      asked.push(param)
      return response(200, { 'Content-Type': 'image/png' })
    })
    const { api } = provider.create('m', new ModuleLifecycleScope())
    const got = await api.requestBinary('https://a.b/i?x=1')
    expect(asked).toEqual([
      { url: 'https://a.b/i?x=1', method: 'GET', throw: false },
    ])
    expect(got.contentType).toBe('image/png')
    expect([...new Uint8Array(got.body)]).toEqual([1, 2, 3])
  })

  test('rejects another kind of address, and a failed status', async () => {
    const provider = new ModuleNetworkCapabilityProvider(async () =>
      response(404),
    )
    const { api } = provider.create('m', new ModuleLifecycleScope())
    await expect(api.requestBinary('file:///etc/hosts')).rejects.toThrow()
    await expect(api.requestBinary('app://x')).rejects.toThrow()
    await expect(api.requestBinary('https://a.b/missing')).rejects.toThrow(
      '404',
    )
  })

  test('asks nothing once the module is gone', async () => {
    const request = jest.fn(async () => response(200))
    const provider = new ModuleNetworkCapabilityProvider(request)
    const lifecycle = new ModuleLifecycleScope()
    const { api } = provider.create('m', lifecycle)
    lifecycle.dispose()
    await expect(api.requestBinary('https://a.b/i')).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})
