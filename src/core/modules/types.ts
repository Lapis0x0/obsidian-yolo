import type { ReactNode } from 'react'

import type { ModuleConfigV1 } from './moduleConfig'
import type { ModulePrivateStorageV1 } from './modulePrivateStorage'
import type { ModuleTransitionPhase } from './moduleTransitionJournal'

export type ModuleDisposer = () => void

export type YoloModuleLifecycle = {
  add(disposer: ModuleDisposer): void
}

export type YoloModuleViewV1 = Readonly<{
  type: string
  name: string
  icon: string
  render(): ReactNode
}>

export type YoloModuleRibbonActionV1 = Readonly<{
  icon: string
  title: string
  onClick(): void
}>

export type YoloModuleCommandV1 = Readonly<{
  id: string
  name: string
  callback(): void | Promise<void>
}>

export type YoloModuleOpenViewOptionsV1 = Readonly<{
  newLeaf?: boolean
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

export type YoloModulePathsSnapshotV1 = Readonly<{
  contentRoot: string
}>

export type YoloModulePathsV1 = {
  getSnapshot(): YoloModulePathsSnapshotV1
  subscribe(listener: () => void): ModuleDisposer
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
  confirm(options: YoloModuleConfirmOptionsV1): Promise<boolean>
  createMarkdownRenderer(): YoloModuleMarkdownRendererV1
  htmlToMarkdown(html: string): string
  isModEvent(event: MouseEvent): boolean
  openLink(
    linktext: string,
    sourcePath: string,
    newLeaf?: boolean,
  ): Promise<void>
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
  config: ModuleConfigV1
  paths: YoloModulePathsV1
  privateStorage: ModulePrivateStorageV1
  ui: YoloModuleUiV1
  vault: YoloModuleVaultV1
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
  | 'ready-to-apply'
  | 'activation-pending'
  | 'failed'

export type ModuleCatalogEntry = {
  id: string
  version: string
  name?: string
  description?: string
}

export type InstalledModuleState = {
  id: string
  version: string
  candidateVersion?: string
  pendingVersion?: string
  transitionPhase?: ModuleTransitionPhase
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
  desiredInstalled: boolean
  enabled: boolean
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
  candidateVersion?: string
  pendingVersion?: string
  transitionPhase?: ModuleTransitionPhase
  error?: string
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
