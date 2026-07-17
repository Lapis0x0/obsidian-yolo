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

export type YoloModuleWorkspaceV1 = {
  registerView(view: YoloModuleViewV1): void
  registerRibbonAction(action: YoloModuleRibbonActionV1): void
}

export type YoloHostApiV1 = Readonly<{
  version: 1
  lifecycle: YoloModuleLifecycle
  workspace: YoloModuleWorkspaceV1
}>

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
