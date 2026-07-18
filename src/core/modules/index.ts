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
  ModuleAssetsCapabilityProvider,
  ModuleAssetsCleanupError,
  UNAVAILABLE_MODULE_ASSETS_CAPABILITY_PROVIDER,
  type ModuleAssetRole,
  type ModuleAssetsCapabilityActivationV1,
  type ModuleAssetsCapabilityProviderOptions,
  type ModuleAssetsCapabilityProviderV1,
} from './moduleAssets'
export {
  ModuleConfigCapabilityProvider,
  type ModuleConfigBackend,
  type ModuleConfigCapabilityActivationV1,
  type ModuleConfigCapabilityProviderOptions,
  type ModuleConfigSnapshot,
  type ModuleConfigV1,
} from './moduleConfig'
export {
  ModuleArtifactInstaller,
  type ModuleArtifactDownloadRequest,
  type ModuleArtifactInstallerOptions,
} from './moduleArtifactInstaller'
export {
  createOfficialModuleArtifactDownloader,
  type OfficialModuleArtifactDownloaderOptions,
  type OfficialModuleArtifactRequest,
} from './officialModuleArtifactDownloader'
export { sha256Hex, verifyModuleBytes } from './moduleIntegrity'
export {
  verifyInstalledModuleArtifact,
  collectInstallableModuleFiles,
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
  ModulePrivateStorageCapabilityProvider,
  ModulePrivateStorageVerificationError,
  type ModulePrivateStorageBackend,
  type ModulePrivateStorageCapabilityActivationV1,
  type ModulePrivateStorageCapabilityProviderOptions,
  type ModulePrivateStorageCapabilityProviderV1,
  type ModulePrivateStorageScopeV1,
  type ModulePrivateStorageV1,
} from './modulePrivateStorage'
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
  UNAVAILABLE_MODULE_CONFIG_CAPABILITY_PROVIDER,
  UNAVAILABLE_MODULE_PRIVATE_STORAGE_CAPABILITY_PROVIDER,
  type ModuleConfigCapabilityProviderV1,
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
  findCompatibleUpdate,
  parseOfficialModuleCatalog,
  selectInitialCompatibleVersion,
  type OfficialModuleCatalogModule,
  type OfficialModuleCatalogParserOptions,
  type OfficialModuleCatalogV1,
  type OfficialModuleCatalogVersion,
  type OfficialModuleCompatibility,
  type OfficialModuleDataSchema,
  type OfficialModulePlatform,
} from './officialModuleCatalog'
export {
  OFFICIAL_MODULE_CATALOG_URL,
  OFFICIAL_MODULE_RELEASE_REPOSITORIES,
  OfficialModuleCatalogClient,
  OfficialModuleCatalogUnavailableError,
  isOfficialModuleReleaseUrl,
  type OfficialModuleCatalogClientOptions,
  type OfficialModuleCatalogRequest,
} from './officialModuleCatalogClient'
export {
  ModuleDeviceStateCorruptionError,
  ModuleDeviceStateStore,
  type ModuleDeviceState,
  type ModuleDeviceStateStoreBackend,
} from './moduleDeviceStateStore'
export { ModuleDeviceStateInstalledStateSource } from './moduleDeviceStateInstalledStateSource'
export {
  OfficialModuleCatalogSource,
  type OfficialModuleCatalogSourceOptions,
  type OfficialModuleCompatibilityProvider,
} from './officialModuleCatalogSource'
export {
  ModuleStore,
  collectModuleManifestFiles,
  isModuleHostApiRange,
  moduleArtifactReleaseParent,
  moduleReadyMarkerFileName,
  parseModuleArtifactManifest,
  parseModuleReadyMarker,
  selectModuleManifestVariant,
  type ModuleArtifactDataSchema,
  type ModuleArtifactDataSchemas,
  type ModuleArtifactFile,
  type ModuleArtifactPlatform,
  type ModuleArtifactVariant,
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
  YoloModuleAssetsV1,
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
export {
  IndexedDbDataAdapter,
  MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY,
  type IndexedDbDataAdapterOptions,
} from './indexedDbDataAdapter'
export {
  createObsidianModuleConfigBackendFactory,
  type ObsidianModuleConfigBackendFactoryOptions,
  type ObsidianModuleConfigSettings,
} from './obsidianModuleConfigBackend'
