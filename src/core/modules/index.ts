export { ModuleCleanupError, ModuleLifecycleScope } from './lifecycleScope'
export {
  BundledModuleRegistry,
  parseBundledModuleIndex,
  type BundledModuleDescriptor,
  type BundledModuleIndex,
  type BundledModuleRegistryOptions,
} from './bundledModuleRegistry'
export {
  ModuleContributionStager,
  type StagedModuleContributions,
} from './contributionStager'
export { ModuleLoader, type ModuleLoaderOptions } from './moduleLoader'
export {
  CoreModuleAgentCapabilityProvider,
  UNAVAILABLE_MODULE_AGENT_CAPABILITY_PROVIDER,
  type CoreModuleAgentCapabilityProviderOptions,
  type ModuleAgentCapabilityActivationV1,
  type ModuleAgentCapabilityProviderV1,
} from './moduleAgent'
export {
  ModuleArtifactInstaller,
  type ModuleArtifactDownloadRequest,
  type ModuleArtifactInstallerOptions,
} from './moduleArtifactInstaller'
export { sha256Hex, verifyModuleBytes } from './moduleIntegrity'
export {
  verifyInstalledModuleArtifact,
  type ModuleArtifactDescriptor,
  type ModuleArtifactReadStore,
  type VerifiedModuleArtifact,
} from './moduleArtifactVerifier'
export {
  ManagedModulePathsCapabilityProvider,
  UNAVAILABLE_MODULE_PATHS_CAPABILITY_PROVIDER,
  type ManagedModulePathsCapabilityProviderOptions,
  type ModulePathsCapabilityActivationV1,
  type ModulePathsCapabilityProviderV1,
} from './modulePaths'
export {
  ObsidianModuleUiCapabilityProvider,
  UNAVAILABLE_MODULE_UI_CAPABILITY_PROVIDER,
  type ModuleUiCapabilityActivationV1,
  type ModuleUiCapabilityProviderV1,
  type ModuleConfirmModal,
  type ModuleConfirmModalFactory,
  type ObsidianModuleUiCapabilityProviderOptions,
} from './moduleUi'
export {
  ObsidianModuleVaultCapabilityProvider,
  UNAVAILABLE_MODULE_VAULT_CAPABILITY_PROVIDER,
  normalizeModuleVaultPath,
  type ModuleVaultCapabilityActivationV1,
  type ModuleVaultCapabilityProviderV1,
} from './moduleVault'
export {
  CoreModuleHostCapabilityProvider,
  type ModuleHostCapabilityActivationV1,
  type ModuleHostCapabilityProviderV1,
} from './hostCapabilities'
export {
  EMPTY_INSTALLED_MODULE_STATE_SOURCE,
  EMPTY_MODULE_CATALOG_SOURCE,
  ModuleManager,
  type ModuleManagerOptions,
} from './moduleManager'
export {
  ModuleStore,
  parseModuleArtifactManifest,
  parseModuleReadyMarker,
  type ModuleArtifactFile,
  type ModuleStoreOptions,
  type ModuleArtifactManifest,
  type ModuleReadyMarker,
  resolveModulePluginDir,
} from './moduleStore'
export {
  ModuleRuntime,
  ObsidianModuleContributionRegistrar,
  type ModuleContributionRegistrar,
} from './moduleRuntime'
export {
  YOLO_MODULE_RUNTIME_SYMBOL,
  getYoloModuleRuntimeBridge,
  installYoloModuleRuntimeBridge,
  type YoloModuleSharedRuntimeV1,
} from './runtimeBridge'
export {
  BrowserBlobScriptHost,
  DomBlobModuleScriptExecutor,
  type BlobScriptHost,
  type ModuleRegistrationCapture,
  type ModuleScriptExecutor,
  type ScriptResource,
} from './scriptExecutor'
export type {
  ModuleDisposer,
  InstalledModuleState,
  InstalledModuleStateSource,
  ModuleCatalogEntry,
  ModuleCatalogSource,
  ModuleManagerSnapshot,
  ModuleManagerStatus,
  ModuleRecord,
  ModuleStatus,
  YoloModuleDefinition,
  YoloModuleEntry,
  YoloHostApiV1,
  YoloModuleBackgroundActivityStatusV1,
  YoloModuleBackgroundActivityV1,
  YoloModuleBackgroundV1,
  YoloModuleAgentCapabilityV1,
  YoloModuleAgentEventV1,
  YoloModuleAgentMessageV1,
  YoloModuleAgentRequestV1,
  YoloModuleAgentV1,
  YoloModuleCapabilitiesV1,
  YoloModuleCommandV1,
  YoloModuleLifecycle,
  YoloModuleOpenViewOptionsV1,
  YoloModulePathsSnapshotV1,
  YoloModulePathsV1,
  YoloModuleConfirmOptionsV1,
  YoloModuleHoverLinkOptionsV1,
  YoloModuleMarkdownRendererV1,
  YoloModuleUiV1,
  YoloModuleRibbonActionV1,
  YoloModuleRuntimeRegistration,
  YoloModuleViewV1,
  YoloModuleVaultEntryV1,
  YoloModuleVaultEventV1,
  YoloModuleVaultFileV1,
  YoloModuleVaultFolderV1,
  YoloModuleVaultTextSnapshotV1,
  YoloModuleVaultV1,
  YoloModuleVaultWrittenFileV1,
} from './types'
