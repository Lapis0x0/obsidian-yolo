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
  ModuleInstallationCoordinator,
  type ConfirmedModuleCandidate,
  type ModuleInstallationCoordinatorOptions,
  type ModuleInstallationResult,
} from './moduleInstallationCoordinator'
export {
  ModuleDataRemovalCoordinator,
  type LearningCanonicalContentDataDescriptor,
  type LearningImportJournalDataDescriptor,
  type LearningSrsDataDescriptor,
  type ModuleConfigDocumentDataDescriptor,
  type ModuleDataOwnershipPort,
  type ModuleDataRemovalAuthorizationPort,
  type ModuleDataRemovalAuthorizationRequest,
  type ModuleDataRemovalCoordinatorOptions,
  type ModuleDataRemovalJournal,
  type ModuleDataRemovalJournalPort,
  type ModuleDataRemovalResult,
  type ModuleOwnedDataDescriptor,
  type ModuleOwnedDataRemovalPort,
  type ModulePrivateNamespaceDataDescriptor,
} from './moduleDataRemovalCoordinator'
export {
  createLearningOwnedDataDescriptors,
  createLearningOwnedDataRemovalPort,
  createModuleDataRemovalJournalPort,
  isLearningOwnedDataDescriptor,
} from './learningModuleDataRemoval'
export {
  ModuleIntentStore,
  ModuleIntentWriteUncertainError,
  type ModuleIntent,
  type ModuleIntentBackend,
} from './moduleIntentStore'
export {
  createObsidianModuleIntentBackend,
  ModuleIntentSubscriptionRegistrationError,
  type ObsidianModuleIntentBackendOptions,
  type ObsidianModuleIntentSettings,
} from './obsidianModuleIntentBackend'
export {
  DEFAULT_MODULE_ACTIVATION_TIMEOUT_MS,
  ModuleActivationCoordinator,
  type ModuleActivationCoordinatorOptions,
  type ModuleActivationResult,
  type ModuleActivationStartupDisposition,
} from './moduleActivationCoordinator'
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
export { VerifiedModuleArtifactRegistry } from './verifiedModuleArtifactRegistry'
export {
  managedModuleDataNamespace,
  runExclusive,
} from './managedModuleDataLock'
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
  ModuleSettingsCapabilityProvider,
  ModuleSettingsContributionRegistry,
  UNAVAILABLE_MODULE_SETTINGS_CAPABILITY_PROVIDER,
  type ModuleSettingsCapabilityProviderOptions,
  type ModuleSettingsCapabilityProviderV1,
  type ModuleSettingsConfigAdapterV1,
  type ModuleSettingsContributionSinkV1,
  type ModuleSettingsFieldAdapterV1,
  type ModuleSettingsFieldSnapshotV1,
  type RegisteredModuleSettingsContributionV1,
  type YoloModuleModelOptionV1,
  type YoloModuleModelSnapshotV1,
  type YoloModuleSettingFieldV1,
  type YoloModuleSettingsContributionV1,
  type YoloModuleSettingsV1,
} from './moduleSettingsContributions'
export {
  ModuleWorkerHostCapabilityProvider,
  UNAVAILABLE_MODULE_WORKER_CAPABILITY_PROVIDER,
  type ModuleWorkerFactory,
  type YoloModuleWorkerCallOptionsV1,
  type YoloModuleWorkerV1,
  type YoloModuleWorkersV1,
} from './moduleWorkerHost'
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
  getOfficialModuleCompatibilityIssues,
  parseOfficialModuleCatalog,
  selectInitialCompatibleVersion,
  type OfficialModuleCatalogModule,
  type OfficialModuleCatalogParserOptions,
  type OfficialModuleCatalogV1,
  type OfficialModuleCatalogVersion,
  type OfficialModuleCompatibility,
  type OfficialModuleCompatibilityIssue,
  type OfficialModuleDataSchema,
  type OfficialModulePlatform,
} from './officialModuleCatalog'
export {
  OFFICIAL_MODULE_CATALOG_URL,
  OFFICIAL_MODULE_RELEASE_REPOSITORIES,
  OfficialModuleCatalogClient,
  OfficialModuleCatalogUnavailableError,
  isOfficialModuleReleaseUrl,
  type OfficialModuleCatalogCacheAdapter,
  type OfficialModuleCatalogClientOptions,
  type OfficialModuleCatalogRequest,
} from './officialModuleCatalogClient'
export {
  authorizeOfficialModuleArtifactRemoval,
  type OfficialModuleArtifactRemovalCatalogLoader,
} from './officialModuleArtifactRemovalPolicy'
export {
  ModuleDeviceStateCorruptionError,
  ModuleDeviceStateStore,
  type ModuleDeviceState,
  type ModuleDeviceStateStoreBackend,
  type ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
export {
  MAX_MODULE_TRANSITION_SETTINGS_SNAPSHOT_BYTES,
  advanceModuleTransitionPhase,
  hashModuleTransitionSettingsSnapshot,
  parseModuleTransitionJournal,
  parseModuleTransitionSettingsLocation,
  verifyModuleTransitionJournalSnapshot,
  type ModuleTransitionJournal,
  type ModuleTransitionJournalBinding,
  type ModuleTransitionPhase,
  type ModuleTransitionSettingsLocation,
  type ModuleTransitionSettingsSnapshot,
  type SnapshotVerifiedModuleTransitionJournal,
} from './moduleTransitionJournal'
export { ModuleDeviceStateInstalledStateSource } from './moduleDeviceStateInstalledStateSource'
export {
  OfficialModuleCatalogSource,
  type OfficialModuleCatalogSourceOptions,
  type OfficialModuleCompatibilityProvider,
} from './officialModuleCatalogSource'
export {
  OFFICIAL_MODULE_SETTINGS_DATA_NAMESPACE,
  YOLO_HOST_API_VERSION,
  createOfficialModuleCompatibilityProvider,
  type OfficialModuleCompatibilityDeviceState,
  type OfficialModuleCompatibilityProviderOptions,
} from './officialModuleCompatibilityProvider'
export {
  OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS,
  OFFICIAL_MODULE_CATALOG_CACHE_PATH,
  OFFICIAL_MODULE_CATALOG_CACHE_TTL_MS,
  OFFICIAL_MODULE_CATALOG_TIMEOUT_MS,
  createProductionModuleServices,
  type ProductionModuleServices,
  type ProductionModuleServicesOptions,
} from './productionModuleServices'
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
  ModuleRuntimeReservation,
  type ModuleRuntimeQuiescence,
  type ModuleRuntimeReservationOptions,
  type ModuleRuntimeReservationTarget,
} from './moduleRuntimeReservation'
export {
  ModuleStartupReconciler,
  type ModuleStartupReconcileSource,
  type ModuleStartupReconcilerOptions,
} from './moduleStartupReconciler'
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
  createObsidianModuleConfigCreateIfAbsent,
  createObsidianModuleTransitionSettingsBackend,
  type CapturedModuleSettingsLocation,
  type CapturedModuleTransitionSettings,
  type ObsidianModuleConfigBackendFactoryOptions,
  type ObsidianModuleConfigBackendFactory,
  type ObsidianModuleConfigCreateIfAbsent,
  type ObsidianModuleConfigSettings,
  type ObsidianModuleTransitionSettingsBackend,
} from './obsidianModuleConfigBackend'
export {
  handoffLearningLegacySettings,
  type ModuleConfigCreateIfAbsent,
} from './learningModuleSettingsHandoff'
