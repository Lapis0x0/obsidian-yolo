import type { AuthMethod, AuthMethodId } from '@agentclientprotocol/sdk'

const LOGIN_REQUIRED_MESSAGE =
  'Grok subscription authentication is not available. Run `grok login` (or `grok login --device-auth`) in a terminal, then retry.'

/**
 * Selects only Grok's device-local cached subscription credential.
 *
 * Interactive `grok.com` authentication requires extra ACP extension calls
 * and UI lifecycle that this first integration deliberately does not claim
 * to support. `xai.api_key` is also excluded so choosing the subscription
 * runtime cannot silently consume separately billed API credits.
 */
export const selectGrokSubscriptionAuthMethod = (
  methods: readonly AuthMethod[],
): AuthMethodId => {
  if (methods.some((method) => method.id === 'cached_token')) {
    return 'cached_token'
  }
  throw new Error(LOGIN_REQUIRED_MESSAGE)
}
