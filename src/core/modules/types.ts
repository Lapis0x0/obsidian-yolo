import type { ReactNode } from 'react'

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

export type YoloModuleOpenViewOptionsV1 = Readonly<{
  newLeaf?: boolean
}>

export type YoloModuleWorkspaceV1 = {
  registerView(view: YoloModuleViewV1): void
  registerRibbonAction(action: YoloModuleRibbonActionV1): void
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

export type YoloModuleVaultV1 = {
  getEntry(path: string): YoloModuleVaultEntryV1 | null
  listChildren(folderPath: string): readonly YoloModuleVaultEntryV1[]
  listMarkdownFiles(): readonly YoloModuleVaultFileV1[]
  exists(path: string): Promise<boolean>
  readText(filePath: string): Promise<string>
  readBinary(filePath: string): Promise<ArrayBuffer>
  subscribe(
    scopePath: string,
    listener: (event: YoloModuleVaultEventV1) => void | Promise<void>,
  ): ModuleDisposer
}

export type YoloModuleCapabilitiesV1 = Readonly<{
  background: YoloModuleBackgroundV1
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

export type ModuleRecord = Readonly<{
  id: string
  name: string
  description: string
  version: string
  availableVersion?: string
  error?: string
  status: ModuleStatus
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
  }>
  error?: string
}>
