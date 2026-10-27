// The Whiteboard module's settings contribution, following the Learning
// module's pattern (modules/learning/src/host/settings/contribution.ts).
//
// One setting today: the vault folder where the "New whiteboard" command and
// the ribbon icon create boards; left empty, boards follow Obsidian's own
// "Default location for new notes", as its New canvas command does. The
// folder context-menu entry is not affected — it already acts on the folder
// the user right-clicked, which is the more specific choice.

import { WHITEBOARD_LOCALES, getWhiteboardText } from '../i18n'

const localizations = Object.freeze(
  Object.fromEntries(
    WHITEBOARD_LOCALES.map((locale) => [
      locale,
      Object.freeze({
        title: getWhiteboardText(locale, 'settings.title'),
        fields: Object.freeze({
          newBoardFolder: Object.freeze({
            name: getWhiteboardText(locale, 'settings.newBoardFolder'),
            description: getWhiteboardText(
              locale,
              'settings.newBoardFolderDescription',
            ),
          }),
        }),
      }),
    ]),
  ),
)

export const WHITEBOARD_SETTINGS_CONTRIBUTION = Object.freeze({
  id: 'whiteboard',
  icon: 'waypoints',
  title: getWhiteboardText('en', 'settings.title'),
  fields: Object.freeze([
    Object.freeze({
      key: 'newBoardFolder',
      type: 'text' as const,
      name: getWhiteboardText('en', 'settings.newBoardFolder'),
      description: getWhiteboardText(
        'en',
        'settings.newBoardFolderDescription',
      ),
    }),
  ]),
  localizations,
}) satisfies YoloModuleHostSettingsContributionV1

export function contributeWhiteboardSettings(
  settings: YoloModuleHostApiV1['settings'],
): void {
  settings.contribute(WHITEBOARD_SETTINGS_CONTRIBUTION)
}

/** The folder a new board goes in: the configured new-board folder,
 * normalized to a vault-relative path, or — when unset — the folder Obsidian's
 * "Default location for new notes" picks. Read fresh on every creation entry
 * so a settings change takes effect without reactivating the module. */
export function resolveNewBoardFolder(host: YoloModuleHostApiV1): string {
  return readConfiguredFolder(host) || host.vault.getNewFileParent()
}

function readConfiguredFolder(host: YoloModuleHostApiV1): string {
  let data: unknown
  try {
    data = host.config.getSnapshot().data
  } catch {
    // Config is unavailable (module deactivating); Obsidian's default stands in.
    return ''
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const value = (data as Record<string, unknown>).newBoardFolder
  if (typeof value !== 'string') return ''
  // A vault folder is relative: tolerate the leading/trailing slashes users
  // type ("Whiteboards/", "/Whiteboards") rather than failing to find it.
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '')
}
