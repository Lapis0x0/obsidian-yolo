import { acquireRuntimeComponent } from '../../runtime-components/runtimeComponentAccess'
import { assertCliRuntimeAvailable } from '../desktop'

import type { ClaudeSdkLoader } from './types'

/**
 * The Claude Agent SDK ships as the desktop-only `claude-agent-sdk` runtime
 * component, so this downloads it on first use when background prefetch has
 * not already done so.
 *
 * The lease is released as soon as the API is in hand. A lease only keeps a
 * component instance from being disposed while in use, and this one has
 * nothing to dispose: the SDK functions are stateless, and each query's child
 * process belongs to the query object its caller closes. Holding a lease for
 * as long as the functions are referenced would instead leave disabling the
 * component waiting forever in "quiescing". Nothing is memoized here: the
 * runtime already keeps the activated instance, so a repeat call is cheap,
 * and a component that was turned off or failed is reported on the next call
 * instead of being hidden behind a cached API.
 */
export const loadClaudeAgentSdk: ClaudeSdkLoader = async () => {
  assertCliRuntimeAvailable('claude-code')
  const lease = await acquireRuntimeComponent('claude-agent-sdk')
  lease.release()
  return lease.api
}
