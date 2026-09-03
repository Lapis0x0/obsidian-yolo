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
 *
 * An empty list is ACP's way of saying the agent needs no authentication at
 * all, which `AcpHost` honours by skipping the `authenticate` call — so it
 * returns undefined rather than sending an already signed-in user off to run
 * `grok login` again. Only a non-empty list without `cached_token` means a
 * login is genuinely missing.
 */
export const selectGrokSubscriptionAuthMethod = (
  methods: readonly AuthMethod[],
): AuthMethodId | undefined => {
  if (methods.length === 0) return undefined
  if (methods.some((method) => method.id === 'cached_token')) {
    return 'cached_token'
  }
  throw new Error(LOGIN_REQUIRED_MESSAGE)
}
