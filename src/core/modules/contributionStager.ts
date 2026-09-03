import { snapshotLocalizedText } from './moduleI18n'
import type {
  YoloModuleCommandV1,
  YoloModuleFileMenuActionV1,
  YoloModuleFileViewV1,
  YoloModuleRibbonActionV1,
  YoloModuleViewV1,
  YoloModuleWorkspaceV1,
} from './types'

type YoloModuleWorkspaceContributionsV1 = Pick<
  YoloModuleWorkspaceV1,
  | 'registerView'
  | 'registerRibbonAction'
  | 'registerCommand'
  | 'registerFileView'
  | 'registerFileMenuAction'
>

export type StagedModuleContributions = Readonly<{
  view?: YoloModuleViewV1
  ribbonAction?: YoloModuleRibbonActionV1
  commands?: readonly YoloModuleCommandV1[]
  fileViews?: readonly YoloModuleFileViewV1[]
  fileMenuActions?: readonly YoloModuleFileMenuActionV1[]
}>

const EXTENSION_PATTERN = /^[a-z0-9]+$/

function requireText(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function requireExtension(
  value: unknown,
  label: string,
): asserts value is string {
  requireText(value, label)
  if (!EXTENSION_PATTERN.test(value as string)) {
    throw new Error(`${label} must match ${EXTENSION_PATTERN}`)
  }
}

function normalizeExtensionList(
  rawExtensions: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(rawExtensions) || rawExtensions.length === 0) {
    throw new Error(`${label} must be a non-empty array`)
  }
  const seen = new Set<string>()
  const extensions: string[] = []
  for (const extension of rawExtensions) {
    requireExtension(extension, `${label} entry`)
    if (seen.has(extension)) {
      throw new Error(`${label} entry "${extension}" is duplicated`)
    }
    seen.add(extension)
    extensions.push(extension)
  }
  return Object.freeze(extensions)
}

/** Collects the complete declaration set before Core touches Obsidian APIs. */
export class ModuleContributionStager {
  private view: YoloModuleViewV1 | undefined
  private ribbonAction: YoloModuleRibbonActionV1 | undefined
  private readonly commands = new Map<string, YoloModuleCommandV1>()
  private readonly fileViews = new Map<string, YoloModuleFileViewV1>()
  private readonly fileViewExtensionOwners = new Map<string, string>()
  private readonly fileMenuActions = new Map<
    string,
    YoloModuleFileMenuActionV1
  >()
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
    registerFileView: (view) => {
      this.assertOpen()
      requireText(view?.viewType, 'Module file view type')
      const name = snapshotLocalizedText(view?.name, 'Module file view name')
      requireText(view?.icon, 'Module file view icon')
      if (typeof view?.factory !== 'function') {
        throw new Error('Module file view factory must be a function')
      }
      const extensions = normalizeExtensionList(
        view?.extensions,
        'Module file view extensions',
      )
      if (this.fileViews.has(view.viewType)) {
        throw new Error(
          `Module file view type "${view.viewType}" is already registered`,
        )
      }
      for (const extension of extensions) {
        const owner = this.fileViewExtensionOwners.get(extension)
        if (owner) {
          throw new Error(
            `Module file view extension "${extension}" is already registered to view type "${owner}"`,
          )
        }
      }
      for (const extension of extensions) {
        this.fileViewExtensionOwners.set(extension, view.viewType)
      }
      this.fileViews.set(
        view.viewType,
        Object.freeze({ ...view, name, extensions }),
      )
    },
    registerFileMenuAction: (action) => {
      this.assertOpen()
      requireText(action?.id, 'Module file menu action id')
      const title = snapshotLocalizedText(
        action?.title,
        'Module file menu action title',
      )
      requireText(action?.icon, 'Module file menu action icon')
      if (action?.appliesTo !== 'file' && action?.appliesTo !== 'folder') {
        throw new Error(
          'Module file menu action appliesTo must be "file" or "folder"',
        )
      }
      if (typeof action?.onSelect !== 'function') {
        throw new Error('Module file menu action onSelect must be a function')
      }
      if (this.fileMenuActions.has(action.id)) {
        throw new Error(
          `Module file menu action id "${action.id}" is already registered`,
        )
      }
      // extensions only mean something for 'file' targets; a folder action's
      // extensions (if any were passed) are simply not part of the contract.
      const extensions =
        action.appliesTo === 'file' && action.extensions !== undefined
          ? normalizeExtensionList(
              action.extensions,
              'Module file menu action extensions',
            )
          : undefined
      this.fileMenuActions.set(
        action.id,
        Object.freeze({
          id: action.id,
          title,
          icon: action.icon,
          appliesTo: action.appliesTo,
          onSelect: action.onSelect,
          ...(extensions ? { extensions } : {}),
        }),
      )
    },
  }

  finish(options: { allowEmpty?: boolean } = {}): StagedModuleContributions {
    this.assertOpen()
    this.finished = true
    if (
      !options.allowEmpty &&
      !this.view &&
      !this.ribbonAction &&
      this.commands.size === 0 &&
      this.fileViews.size === 0 &&
      this.fileMenuActions.size === 0
    ) {
      throw new Error('Module activation declared no workspace contributions')
    }
    return Object.freeze({
      ...(this.view ? { view: this.view } : {}),
      ...(this.ribbonAction ? { ribbonAction: this.ribbonAction } : {}),
      ...(this.commands.size > 0
        ? { commands: Object.freeze([...this.commands.values()]) }
        : {}),
      ...(this.fileViews.size > 0
        ? { fileViews: Object.freeze([...this.fileViews.values()]) }
        : {}),
      ...(this.fileMenuActions.size > 0
        ? {
            fileMenuActions: Object.freeze([...this.fileMenuActions.values()]),
          }
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
