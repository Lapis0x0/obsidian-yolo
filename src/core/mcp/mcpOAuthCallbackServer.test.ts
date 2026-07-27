import { McpOAuthCallbackServer } from './mcpOAuthCallbackServer'

jest.mock('../../utils/platform/desktopNodeModule', () => ({
  loadDesktopNodeModule: jest.fn(async () => jest.requireActual('node:http')),
}))

describe('McpOAuthCallbackServer', () => {
  let server: McpOAuthCallbackServer

  afterEach(() => {
    server?.close()
  })

  it('routes a matching state to the pending authorization', async () => {
    let openedUrl = ''
    server = new McpOAuthCallbackServer((url) => {
      openedUrl = url
    })
    const redirectUrl = await server.getRedirectUrl()
    const authorizationUrl = new URL('https://auth.example.com/authorize')
    authorizationUrl.searchParams.set('state', 'state-1')

    const codePromise = server.authorize('draft-1', authorizationUrl)
    const response = await globalThis.fetch(
      `${redirectUrl}?state=state-1&code=authorization-code`,
    )

    expect(openedUrl).toBe(authorizationUrl.toString())
    expect(response.status).toBe(200)
    await expect(codePromise).resolves.toBe('authorization-code')
  })

  it('rejects pending authorization when its owner is cancelled', async () => {
    server = new McpOAuthCallbackServer(() => undefined)
    await server.getRedirectUrl()
    const authorizationUrl = new URL('https://auth.example.com/authorize')
    authorizationUrl.searchParams.set('state', 'state-2')

    const codePromise = server.authorize('draft-2', authorizationUrl)
    server.cancelOwner('draft-2')

    await expect(codePromise).rejects.toThrow('cancelled')
  })
})
