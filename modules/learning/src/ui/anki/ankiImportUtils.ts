import type { AnkiImportPlan } from '../../anki/import'

export const MAX_ANKI_PACKAGE_BYTES = 200 * 1024 * 1024

export type AnkiImportFileError =
  | 'multiple'
  | 'extension'
  | 'empty'
  | 'tooLarge'

export function validateAnkiImportFiles(
  files: readonly File[],
): AnkiImportFileError | null {
  if (files.length !== 1) return 'multiple'
  const [file] = files
  if (!file.name.toLowerCase().endsWith('.apkg')) return 'extension'
  if (file.size === 0) return 'empty'
  if (file.size > MAX_ANKI_PACKAGE_BYTES) return 'tooLarge'
  return null
}

export function summarizeAnkiImport(plan: AnkiImportPlan) {
  return {
    chapterCount: plan.chapters.length,
    cardCount: plan.cardCount,
    historyCount: Object.keys(plan.srsState.cards).length,
    suspendedCount: plan.srsState.suspended.length,
    mediaCount: plan.assets.length,
    mediaBytes: plan.assets.reduce(
      (total, asset) => total + asset.bytes.byteLength,
      0,
    ),
    warningCount: plan.warnings.length,
    chapterPaths: plan.chapters.map(
      (chapter) => `${plan.projectSlug}/${chapter.slug}`,
    ),
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
