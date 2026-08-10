import { assertCliRuntimeAvailable } from '../desktop'

import type { ClaudeSdkLoader, ClaudeSdkModule } from './types'

let sdkModulePromise: Promise<ClaudeSdkModule> | undefined

export const loadClaudeAgentSdk: ClaudeSdkLoader = () => {
  assertCliRuntimeAvailable('claude-code')
  sdkModulePromise ??= import('./sdk-module')
  return sdkModulePromise
}
