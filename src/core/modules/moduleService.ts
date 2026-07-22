import type { VerifiedModuleArtifact } from './moduleArtifactVerifier'
import type { ConfirmedModuleCandidate } from './moduleInstallationCoordinator'
import type { ModuleManagerSnapshot } from './types'

export type ModuleOperationResult = Readonly<{
  version?: string
}>

/** The single application-facing entry point for module lifecycle operations. */
export type ModuleService = Readonly<{
  getSnapshot(): ModuleManagerSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  checkForUpdates(): Promise<void>
  getInstallCandidate(moduleId: string): ConfirmedModuleCandidate | undefined
  install(candidate: ConfirmedModuleCandidate): Promise<ModuleOperationResult>
  setEnabled(moduleId: string, enabled: boolean): Promise<ModuleOperationResult>
  uninstall(moduleId: string): Promise<ModuleOperationResult>
  start(): Promise<void>
  getVerifiedArtifact(moduleId: string): VerifiedModuleArtifact | undefined
  dispose(): void
}>
