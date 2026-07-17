import type {
  YoloModuleRibbonActionV1,
  YoloModuleViewV1,
  YoloModuleWorkspaceV1,
} from './types'

export type StagedModuleContributions = Readonly<{
  view?: YoloModuleViewV1
  ribbonAction?: YoloModuleRibbonActionV1
}>

function requireText(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

/** Collects the complete declaration set before Core touches Obsidian APIs. */
export class ModuleContributionStager {
  private view: YoloModuleViewV1 | undefined
  private ribbonAction: YoloModuleRibbonActionV1 | undefined
  private finished = false

  readonly workspace: YoloModuleWorkspaceV1 = {
    registerView: (view) => {
      this.assertOpen()
      if (this.view) throw new Error('A module may register only one view')
      requireText(view?.type, 'Module view type')
      requireText(view?.name, 'Module view name')
      requireText(view?.icon, 'Module view icon')
      if (typeof view?.render !== 'function') {
        throw new Error('Module view render must be a function')
      }
      this.view = Object.freeze({ ...view })
    },
    registerRibbonAction: (action) => {
      this.assertOpen()
      if (this.ribbonAction) {
        throw new Error('A module may register only one ribbon action')
      }
      requireText(action?.icon, 'Module ribbon icon')
      requireText(action?.title, 'Module ribbon title')
      if (typeof action?.onClick !== 'function') {
        throw new Error('Module ribbon onClick must be a function')
      }
      this.ribbonAction = Object.freeze({ ...action })
    },
  }

  finish(): StagedModuleContributions {
    this.assertOpen()
    this.finished = true
    if (!this.view && !this.ribbonAction) {
      throw new Error('Module activation declared no workspace contributions')
    }
    return Object.freeze({
      ...(this.view ? { view: this.view } : {}),
      ...(this.ribbonAction ? { ribbonAction: this.ribbonAction } : {}),
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
