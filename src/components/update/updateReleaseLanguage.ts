import type { ReleaseNotesByLanguage } from '../../core/update/updateChecker'

export type ReleaseLanguage = 'en' | 'zh'

export function resolveDefaultLanguage(
  notes: ReleaseNotesByLanguage,
  uiLanguage: string,
): ReleaseLanguage {
  const preferred: ReleaseLanguage = uiLanguage === 'zh' ? 'zh' : 'en'
  if (notes[preferred]) return preferred
  return notes.en ? 'en' : 'zh'
}

export function resolveReleaseNotesForLanguage(
  notes: ReleaseNotesByLanguage,
  lang: ReleaseLanguage,
): string {
  return notes[lang] ?? notes.en ?? notes.zh ?? ''
}

export function hasBilingualReleaseNotes(
  notes: ReleaseNotesByLanguage,
): boolean {
  return Boolean(notes.en && notes.zh)
}

export function entriesHaveBilingualNotes(
  entries: { releaseNotes: ReleaseNotesByLanguage }[],
): boolean {
  return entries.some((entry) => hasBilingualReleaseNotes(entry.releaseNotes))
}
