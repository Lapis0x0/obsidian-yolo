import { snapshotLocalizedText } from './moduleI18n'
import type {
  YoloModuleCommandV1,
  YoloModuleRibbonActionV1,
  YoloModuleViewV1,
  YoloModuleWorkspaceV1,
} from './types'

type YoloModuleWorkspaceContributionsV1 = Pick<
  YoloModuleWorkspaceV1,
  'registerView' | 'registerRibbonAction' | 'registerCommand'
>

export type StagedModuleContributions = Readonly<{
  view?: YoloModuleViewV1
  ribbonAction?: YoloModuleRibbonActionV1
  commands?: readonly YoloModuleCommandV1[]
}>

function requireText(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

/** Collects the complete declaration set before Core touches Obsidian APIs. */
export class ModuleContributionStager {
  private view: YoloModuleViewV1 | undefined
  private ribbonAction: YoloModuleRibbonActionV1 | undefined
  private readonly commands = new Map<string, YoloModuleCommandV1>()
  private finished = false

  readonly workspace: YoloModuleWorkspaceContributionsV1 = {
    registerView: (view) => {
      this.assertOpen()
      if (this.view) throw new Error('A module may register only one view')
      requireText(view?.type, 'Module view type')
      const name = snapshotLocalizedText(view?.name, 'Module view name')
      requireText(view?.icon, 'Module view icon')
      if (typeof view?.render !== 'function') {
        throw new Error('Module view render must be a function')
      }
      this.view = Object.freeze({ ...view, name })
    },
    registerRibbonAction: (action) => {
      this.assertOpen()
      if (this.ribbonAction) {
        throw new Error('A module may register only one ribbon action')
      }
      requireText(action?.icon, 'Module ribbon icon')
      const title = snapshotLocalizedText(action?.title, 'Module ribbon title')
      if (typeof action?.onClick !== 'function') {
        throw new Error('Module ribbon onClick must be a function')
      }
      this.ribbonAction = Object.freeze({ ...action, title })
    },
    registerCommand: (command) => {
      this.assertOpen()
      requireText(command?.id, 'Module command id')
      const name = snapshotLocalizedText(command?.name, 'Module command name')
      if (!/^[a-z0-9][a-z0-9:_-]*$/.test(command.id)) {
        throw new Error('Module command id is invalid')
      }
      if (this.commands.has(command.id)) {
        throw new Error(
          `Module command id "${command.id}" is already registered`,
        )
      }
      if (typeof command?.callback !== 'function') {
        throw new Error('Module command callback must be a function')
      }
      this.commands.set(command.id, Object.freeze({ ...command, name }))
    },
  }

  finish(options: { allowEmpty?: boolean } = {}): StagedModuleContributions {
    this.assertOpen()
    this.finished = true
    if (
      !options.allowEmpty &&
      !this.view &&
      !this.ribbonAction &&
      this.commands.size === 0
    ) {
      throw new Error('Module activation declared no workspace contributions')
    }
    return Object.freeze({
      ...(this.view ? { view: this.view } : {}),
      ...(this.ribbonAction ? { ribbonAction: this.ribbonAction } : {}),
      ...(this.commands.size > 0
        ? { commands: Object.freeze([...this.commands.values()]) }
        : {}),
    })
  }

  close(): void {
    this.finished = true
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error('Module contributions must be declared synchronously')
    }
  }
}
