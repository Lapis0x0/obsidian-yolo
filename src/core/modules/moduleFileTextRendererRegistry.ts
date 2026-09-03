// Host-wide directory of module-owned "what does this file look like to a
// model" renderers.
//
// The host's read paths already dispatch on extension — `fs_read` runs a PDF
// through `extractPdfText` and an Office document through its own extractor
// rather than handing over raw bytes, and the @mention `full` path does the
// same. That table is hard-coded, which is fine while every structured format
// the host understands is one the host implements. A module-owned format
// (`.yoloboard`) breaks that assumption: the host must not know how to read
// it, and handing the model the raw file is worse than useless — a board is
// hundreds of KB of coordinates.
//
// So the table gets one more source: a module registers "I own this
// extension, here is its text form". Registration is the whole contract; the
// host owns reading the bytes, the size limits, and where the result is used.
//
// See docs/plans/09-03-whiteboard-agent-tools/master.md D3.

import type { ModuleDisposer, YoloModuleFileTextRendererV1 } from './types'

export type RegisteredModuleFileTextRendererV1 = Readonly<{
  moduleId: string
  extension: string
  renderer: YoloModuleFileTextRendererV1
}>

export type ModuleFileTextRendererContributionSinkV1 = Readonly<{
  add(moduleId: string, renderer: YoloModuleFileTextRendererV1): void
  remove(moduleId: string, renderer: YoloModuleFileTextRendererV1): void
}>

/**
 * Keyed by lower-cased extension: an extension has exactly one text form, and
 * two modules claiming the same one is a conflict to surface rather than an
 * ambiguity to resolve at read time.
 */
export class ModuleFileTextRendererRegistry
  implements ModuleFileTextRendererContributionSinkV1
{
  private readonly entries = new Map<
    string,
    RegisteredModuleFileTextRendererV1
  >()
  private readonly listeners = new Set<() => void>()

  add(moduleId: string, renderer: YoloModuleFileTextRendererV1): void {
    const extensions = normalizeExtensions(renderer.extensions)
    for (const extension of extensions) {
      const existing = this.entries.get(extension)
      if (existing && existing.moduleId !== moduleId) {
        throw new Error(
          `File text renderer for ".${extension}" is already registered by module "${existing.moduleId}"`,
        )
      }
    }
    for (const extension of extensions) {
      this.entries.set(
        extension,
        Object.freeze({ moduleId, extension, renderer }),
      )
    }
    this.emit()
  }

  remove(moduleId: string, renderer: YoloModuleFileTextRendererV1): void {
    let changed = false
    for (const extension of normalizeExtensions(renderer.extensions)) {
      const existing = this.entries.get(extension)
      // Owner- and identity-guarded: a module unregistering one of its
      // renderers must not take down another module's, nor a later renderer
      // of its own that has since claimed the same extension.
      if (!existing || existing.moduleId !== moduleId) continue
      if (existing.renderer !== renderer) continue
      this.entries.delete(extension)
      changed = true
    }
    if (changed) this.emit()
  }

  /** Null when nothing owns this extension — the caller then reads the file
   * the way it always did. */
  resolve(extension: string): YoloModuleFileTextRendererV1 | null {
    return this.entries.get(extension.toLowerCase())?.renderer ?? null
  }

  /** Every extension currently owned, lower-cased. Consumers that need to
   * *include* these files (the @mention search index) read this. */
  listExtensions(): string[] {
    return [...this.entries.keys()].sort()
  }

  subscribe = (listener: () => void): ModuleDisposer => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  clear(): void {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export function snapshotModuleFileTextRenderer(
  renderer: YoloModuleFileTextRendererV1,
): YoloModuleFileTextRendererV1 {
  if (!renderer || typeof renderer !== 'object') {
    throw new TypeError('Module file text renderer must be an object')
  }
  const extensions = normalizeExtensions(renderer.extensions)
  if (extensions.length === 0) {
    throw new Error(
      'Module file text renderer must declare at least one extension',
    )
  }
  if (typeof renderer.render !== 'function') {
    throw new TypeError('Module file text renderer render must be a function')
  }
  return Object.freeze({
    extensions: Object.freeze(extensions),
    render: renderer.render,
  })
}

function normalizeExtensions(extensions: readonly string[]): string[] {
  if (!Array.isArray(extensions)) {
    throw new TypeError('Module file text renderer extensions must be an array')
  }
  const seen = new Set<string>()
  for (const extension of extensions) {
    if (typeof extension !== 'string') {
      throw new TypeError(
        'Module file text renderer extension must be a string',
      )
    }
    // Without a leading dot, matching `TFile.extension` — the shape
    // `registerFileView` already uses, so a module spells an extension the
    // same way wherever it declares one.
    const normalized = extension.trim().toLowerCase()
    if (!/^[a-z0-9]+$/.test(normalized)) {
      throw new Error(
        `Module file text renderer extension "${extension}" must be alphanumeric and carry no leading dot`,
      )
    }
    seen.add(normalized)
  }
  return [...seen]
}
