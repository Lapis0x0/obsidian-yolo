import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthClientProvider,
} from './mcpOAuthProvider'

const TOKENS: OAuthTokens = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  token_type: 'Bearer',
}

describe('McpOAuthClientProvider', () => {
  it('keeps OAuth state isolated and publishes credential changes', async () => {
    const changes: unknown[] = []
    const provider = new McpOAuthClientProvider({
      serverUrl: 'https://example.com/mcp',
      redirectUrl: 'http://127.0.0.1:1234/mcp/oauth/callback',
      onCredentialChange: (credential) => {
        changes.push(credential)
      },
    })
    const clientInformation: OAuthClientInformationMixed = {
      client_id: 'client-id',
    }

    await provider.saveClientInformation(clientInformation)
    await provider.saveTokens(TOKENS)
    provider.saveCodeVerifier('verifier')

    expect(provider.clientInformation()).toEqual(clientInformation)
    expect(provider.tokens()).toEqual(TOKENS)
    expect(provider.codeVerifier()).toBe('verifier')
    expect(provider.state()).toHaveLength(48)
    expect(changes).toHaveLength(2)
    expect(provider.getCredential()).toMatchObject({
      version: 1,
      serverUrl: 'https://example.com/mcp',
      clientInformation,
      tokens: TOKENS,
    })
  })

  it('waits for the authorization code supplied by the callback flow', async () => {
    const authorize = jest.fn().mockResolvedValue('authorization-code')
    const provider = new McpOAuthClientProvider({
      serverUrl: 'https://example.com/mcp',
      redirectUrl: 'http://127.0.0.1:1234/mcp/oauth/callback',
      authorize,
    })
    const authorizationUrl = new URL(
      'https://auth.example.com/authorize?state=state-1',
    )

    provider.redirectToAuthorization(authorizationUrl)

    await expect(provider.waitForAuthorizationCode()).resolves.toBe(
      'authorization-code',
    )
    expect(authorize).toHaveBeenCalledWith(authorizationUrl)
  })

  it('does not open a browser from a runtime provider', () => {
    const provider = new McpOAuthClientProvider({
      serverUrl: 'https://example.com/mcp',
      redirectUrl: 'http://127.0.0.1:1234/mcp/oauth/callback',
    })

    expect(() =>
      provider.redirectToAuthorization(
        new URL('https://auth.example.com/authorize'),
      ),
    ).toThrow(McpOAuthAuthorizationRequiredError)
  })
})
