import type { ReactNode } from 'react'

import type { ModuleConfigV1 } from './moduleConfig'
import type { ModuleFailure } from './moduleFailure'
import type { LocalizedTextV1 } from './moduleI18n'
import type { ModulePrivateStorageV1 } from './modulePrivateStorage'
import type { YoloModuleSettingsV1 } from './moduleSettingsContributions'
import type { YoloModuleWorkersV1 } from './moduleWorkerHost'

export type ModuleDisposer = () => void
export type ModuleQuiescenceCallback = () => void | Promise<void>

export type YoloModuleLifecycle = {
  add(disposer: ModuleDisposer): void
  whenActive(callback: () => void | Promise<void>): void
  onQuiesce(callback: ModuleQuiescenceCallback): void
}

export type YoloModuleViewV1 = Readonly<{
  type: string
  name: LocalizedTextV1
  icon: string
  render(): ReactNode
  getState?(): Readonly<Record<string, unknown>>
  setState?(state: Readonly<Record<string, unknown>>): void | Promise<void>
}>

export type YoloModuleRibbonActionV1 = Readonly<{
  icon: string
  title: LocalizedTextV1
  onClick(): void
}>

export type YoloModuleCommandV1 = Readonly<{
  id: string
  name: LocalizedTextV1
  callback(): void | Promise<void>
}>

export type YoloModuleOpenViewOptionsV1 = Readonly<{
  newLeaf?: boolean
  state?: Readonly<Record<string, unknown>>
}>

export type YoloModuleWorkspaceV1 = {
  registerView(view: YoloModuleViewV1): void
  registerRibbonAction(action: YoloModuleRibbonActionV1): void
  registerCommand(command: YoloModuleCommandV1): void
  openView(options?: YoloModuleOpenViewOptionsV1): Promise<void>
}

export type YoloModuleBackgroundActivityStatusV1 =
  | 'running'
  | 'waiting'
  | 'failed'
  | 'reminder'

export type YoloModuleBackgroundActivityV1 = Readonly<{
  id: string
  title: string
  detail?: string
  summary?: string
  icon?: string
  status: YoloModuleBackgroundActivityStatusV1
  onOpen?: () => void | Promise<void>
}>

export type YoloModuleBackgroundV1 = {
  upsert(activity: YoloModuleBackgroundActivityV1): void
  remove(id: string): void
}

export type YoloModuleAgentCapabilityV1 = 'none' | 'vault-read' | 'vault-write'

export type YoloModuleAgentMessageV1 =
  | Readonly<{
      role: 'user'
      id: string
      content: string
    }>
  | Readonly<{
      role: 'assistant'
      id: string
      content: string
    }>

export type YoloModuleAgentActivityV1 = Readonly<{
  title: string
  detail?: string
}>

export type YoloModuleAgentToolResultV1 = Readonly<{
  /** Text returned to the model. */
  content: string
  /** True when the call failed (e.g. validation) — the model should self-correct. */
  isError?: boolean
}>

export type YoloModuleAgentToolV1 = Readonly<{
  /** Must match `^[a-z][a-z0-9_]*$` and be unique within the request's `tools`. */
  name: string
  description: string
  /** JSON Schema object describing the tool's input. */
  inputSchema: Record<string, unknown>
  /**
   * Invoked serially per run in arrival order: a handler starts only after
   * the previous handler (across all of the run's tools) has settled, even
   * when the model issues multiple tool calls in one turn. Handlers may
   * therefore safely read-modify-write run-scoped state.
   */
  handler: (
    input: Record<string, unknown>,
  ) => Promise<YoloModuleAgentToolResultV1> | YoloModuleAgentToolResultV1
}>

export type YoloModuleAgentRequestV1 = Readonly<{
  prompt?: string
  messages?: readonly YoloModuleAgentMessageV1[]
  modelId?: string
  systemPrompt: string
  capability: YoloModuleAgentCapabilityV1
  workspaceScope?: Readonly<{
    enabled: boolean
    include: readonly string[]
    exclude: readonly string[]
  }>
  activity?: YoloModuleAgentActivityV1
  /**
   * Custom tools scoped to this run only. Registered as an in-process MCP
   * server for the run's lifetime and torn down when it settles. Up to 16.
   */
  tools?: readonly YoloModuleAgentToolV1[]
  signal?: AbortSignal
}>

export type YoloModuleAgentEventV1 =
  | Readonly<{ type: 'text'; text: string; delta: string }>
  | Readonly<{
      type: 'tool'
      name: string
      status:
        | 'pending'
        | 'running'
        | 'completed'
        | 'error'
        | 'awaiting_approval'
      arguments?: Readonly<Record<string, unknown>>
    }>
  | Readonly<{ type: 'completed'; text: string }>
  | Readonly<{ type: 'aborted' }>
  | Readonly<{ type: 'error'; message: string }>

export type YoloModuleAgentV1 = {
  stream(
    request: YoloModuleAgentRequestV1,
  ): AsyncIterable<YoloModuleAgentEventV1>
}

export type YoloModuleChatModeToolV1 = YoloModuleAgentToolV1 &
  Readonly<{
    /**
     * true = every call requires user approval (allow/deny), fixed at tool
     * call creation time as part of the call's persisted metadata — YOLO,
     * "always allow for this conversation", and session-resume replay can
     * never bypass it. Used for hard-confirmation tools (e.g. an outline
     * confirmation gate). Default false (auto-approved, subject to the
     * mode's ordinary approval policy).
     */
    requiresApproval?: boolean
  }>

export type YoloModuleChatModeV1 = Readonly<{
  /** Mode-local id, `^[a-z][a-z0-9-]*$`; the host assembles the full runtime
   * id as `module:<moduleId>:<id>`. */
  id: string
  label: LocalizedTextV1
  description?: LocalizedTextV1
  /** lucide icon name (Obsidian `setIcon` vocabulary); falls back to a
   * generic icon when absent or unrecognized. */
  icon?: string
  /** Mode persona, injected into the system prompt in place of assistant
   * instructions. */
  personaPrompt: string
  /** Built-in host tool tier, shared with the module agent capability;
   * `vault-read` carries a structural read-only constraint. */
  capability: YoloModuleAgentCapabilityV1
  /** Mode-specific tools, registered as a persistent in-process tool server
   * for the lifetime of the mode's contribution. */
  tools?: readonly YoloModuleChatModeToolV1[]
  /**
   * Skill packages that apply within this mode. Each entry is the
   * artifact-relative path of a package's `SKILL.md` (e.g.
   * `skills/coach/SKILL.md`); every `role: 'data'` file the verified manifest
   * declares inside that directory is part of the package. On activation the
   * host copies the package out of the (unindexed) plugin directory into
   * `<yolo base>/modules/<moduleId>/skills/<package>/`, so the skill and all
   * its resources behave exactly like an imported or hand-written Vault skill
   * package and are reachable by ordinary agent read tools. Effective only
   * while this mode is active: skills declared here are not visible in
   * ordinary (non-module) chat modes, and a same-named user/vault skill
   * always wins.
   */
  skills?: readonly string[]
}>

export type YoloModuleChatV1 = Readonly<{
  registerMode(mode: YoloModuleChatModeV1): void
}>

export type YoloModulePathsSnapshotV1 = Readonly<{
  contentRoot: string
}>

export type YoloModuleLocaleSnapshotV1 = Readonly<{ locale: string }>

export type YoloModuleI18nV1 = Readonly<{
  getSnapshot(): YoloModuleLocaleSnapshotV1
  subscribe(listener: () => void): ModuleDisposer
}>

export type YoloModulePathsV1 = {
  getSnapshot(): YoloModulePathsSnapshotV1
  subscribe(listener: () => void): ModuleDisposer
  /**
   * Serializes module-managed data access for this module and namespace.
   * The callback starts after lock acquisition and must not reacquire the same
   * namespace before it settles.
   */
  runExclusive<T>(
    namespace: string,
    operation: () => T | PromiseLike<T>,
  ): Promise<T>
}

export type YoloModuleAssetsV1 = Readonly<{
  readText(path: string): Promise<string>
  readArrayBuffer(path: string): Promise<ArrayBuffer>
  createBlobUrl(path: string): Promise<string>
}>

export type YoloModuleConfirmOptionsV1 = Readonly<{
  title: string
  message: string
  ctaText?: string
  cancelText?: string
}>

export type YoloModuleActionToastV1 = Readonly<{
  id: string
  tone: 'success' | 'warning' | 'error'
  title: string
  message: string
  actionLabel: string
  dismissLabel: string
  onAction(): void | Promise<void>
}>

export type YoloModuleOpenFileLocationV1 = Readonly<{
  path: string
  line?: number
  column?: number
  newLeaf?: boolean
}>

export type YoloModuleMarkdownRendererV1 = {
  render(
    markdown: string,
    container: HTMLElement,
    sourcePath: string,
  ): Promise<void>
  unload(): void
}

export type YoloModuleHoverLinkOptionsV1 = Readonly<{
  event: MouseEvent
  targetEl: HTMLElement
  linktext: string
  sourcePath: string
}>

export type YoloModuleUiV1 = {
  notice(message: string): void
  showActionToast(toast: YoloModuleActionToastV1): void
  confirm(options: YoloModuleConfirmOptionsV1): Promise<boolean>
  createMarkdownRenderer(): YoloModuleMarkdownRendererV1
  htmlToMarkdown(html: string): string
  isModEvent(event: MouseEvent): boolean
  openLink(
    linktext: string,
    sourcePath: string,
    newLeaf?: boolean,
  ): Promise<void>
  openFileAt(location: YoloModuleOpenFileLocationV1): Promise<boolean>
  hoverLink(options: YoloModuleHoverLinkOptionsV1): void
}

export type YoloModuleVaultFileV1 = Readonly<{
  kind: 'file'
  path: string
  name: string
  ctime: number
  mtime: number
}>

export type YoloModuleVaultFolderV1 = Readonly<{
  kind: 'folder'
  path: string
  name: string
}>

export type YoloModuleVaultEntryV1 =
  | YoloModuleVaultFileV1
  | YoloModuleVaultFolderV1

export type YoloModuleVaultEventV1 =
  | Readonly<{
      type: 'create' | 'modify' | 'delete'
      entry: YoloModuleVaultEntryV1
    }>
  | Readonly<{
      type: 'rename'
      entry: YoloModuleVaultEntryV1
      oldPath: string
    }>

export type YoloModuleVaultWrittenFileV1 = Readonly<{
  path: string
  mtime: number
}>

export type YoloModuleVaultTextSnapshotV1 = Readonly<{
  path: string
  content: string
}>

export type YoloModuleVaultV1 = {
  getEntry(path: string): YoloModuleVaultEntryV1 | null
  listChildren(folderPath: string): readonly YoloModuleVaultEntryV1[]
  listMarkdownFiles(): readonly YoloModuleVaultFileV1[]
  stat(path: string): Promise<YoloModuleVaultEntryV1 | null>
  list(folderPath: string): Promise<readonly YoloModuleVaultEntryV1[]>
  exists(path: string): Promise<boolean>
  readText(filePath: string): Promise<string>
  readBinary(filePath: string): Promise<ArrayBuffer>
  ensureFolder(folderPath: string): Promise<void>
  createFolder(folderPath: string): Promise<void>
  createText(
    filePath: string,
    content: string,
  ): Promise<YoloModuleVaultWrittenFileV1>
  createBinary(filePath: string, content: ArrayBuffer): Promise<void>
  writeText(
    filePath: string,
    content: string,
  ): Promise<YoloModuleVaultWrittenFileV1>
  renamePath(oldPath: string, newPath: string): Promise<void>
  trashPath(path: string): Promise<boolean>
  removeFileExact(path: string): Promise<boolean>
  removeEmptyFolderExact(path: string): Promise<boolean>
  readTextSnapshot(
    filePath: string,
  ): Promise<YoloModuleVaultTextSnapshotV1 | null>
  createTextIfAbsent(
    filePath: string,
    content: string,
  ): Promise<YoloModuleVaultTextSnapshotV1 | null>
  replaceTextIfUnchanged(
    expected: YoloModuleVaultTextSnapshotV1,
    content: string,
  ): Promise<YoloModuleVaultTextSnapshotV1 | null>
  revertOwnedCreatedTextIfUnchanged(
    created: YoloModuleVaultTextSnapshotV1,
    expected: YoloModuleVaultTextSnapshotV1,
    fallbackContent: string,
  ): Promise<YoloModuleVaultTextSnapshotV1 | null>
  subscribe(
    scopePath: string,
    listener: (event: YoloModuleVaultEventV1) => void | Promise<void>,
  ): ModuleDisposer
}

export type YoloModuleCapabilitiesV1 = Readonly<{
  agent: YoloModuleAgentV1
  assets: YoloModuleAssetsV1
  background: YoloModuleBackgroundV1
  chat: YoloModuleChatV1
  config: ModuleConfigV1
  i18n: YoloModuleI18nV1
  paths: YoloModulePathsV1
  privateStorage: ModulePrivateStorageV1
  settings: YoloModuleSettingsV1
  ui: YoloModuleUiV1
  vault: YoloModuleVaultV1
  workers: YoloModuleWorkersV1
}>

export type YoloHostApiV1 = Readonly<{
  version: 1
  lifecycle: YoloModuleLifecycle
  workspace: YoloModuleWorkspaceV1
}> &
  YoloModuleCapabilitiesV1

export type YoloModuleDefinition = {
  id: string
  activate(host: YoloHostApiV1): void | Promise<void>
}

/** The only runtime object made available to a module entry script. */
export type YoloModuleRuntimeRegistration = {
  registerModule(definition: YoloModuleDefinition): void
}

export type YoloModuleEntry = {
  id: string
  byteSize: number
  sha256: string
}

export type ModuleStatus =
  | 'available'
  | 'installed'
  | 'active'
  | 'disabled'
  | 'update-available'
  | 'activation-pending'
  | 'failed'

export type ModuleCompatibilityIssue = Readonly<{
  kind: 'platform' | 'host-api' | 'data-schema'
}>

export type ModuleCatalogEntry = {
  id: string
  version: string
  icon?: string
  name?: string
  description?: string
  releaseNotes?: Readonly<{
    url: string
    byteSize: number
    sha256: string
  }>
  compatibilityIssues?: readonly ModuleCompatibilityIssue[]
}

export type InstalledModuleState = {
  id: string
  version: string
  pendingVersion?: string
  active?: boolean
  disabled?: boolean
  error?: string
}

export type ModuleCatalogSource = {
  load(): Promise<ReadonlyArray<ModuleCatalogEntry>>
}

export type InstalledModuleStateSource = {
  load(): Promise<ReadonlyArray<InstalledModuleState>>
}

export type ModuleIntentState = Readonly<{
  id: string
  state: 'uninstalled' | 'disabled' | 'enabled'
}>

export type ModuleIntentStateSource = {
  load(
    moduleIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<ModuleIntentState>>
}

export type ModuleRecord = Readonly<{
  id: string
  name: string
  description: string
  version: string
  availableVersion?: string
  pendingVersion?: string
  error?: string
  failure?: ModuleFailure
  compatibilityIssues?: readonly ModuleCompatibilityIssue[]
  status: ModuleStatus
  desiredInstalled?: boolean
  enabled?: boolean
  catalog?: Readonly<ModuleCatalogEntry>
  installed?: Readonly<InstalledModuleState>
}>

export type ModuleManagerStatus = 'loading' | 'ready' | 'error'

export type ModuleManagerSnapshot = Readonly<{
  status: ModuleManagerStatus
  modules: ReadonlyArray<ModuleRecord>
  errors: Readonly<{
    catalog?: string
    installed?: string
    intent?: string
  }>
  error?: string
}>
