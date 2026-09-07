/**
 * quickAsk.trigger.ts
 *
 * The `@` trigger, as a CodeMirror extension that knows nothing about which
 * surface it is installed on.
 *
 * Detection and presentation used to be one closure inside
 * `QuickAskController`: the handler resolved the active Markdown view off the
 * controller's deps and called `this.show(editor, view)`. That made the
 * trigger unusable anywhere a `MarkdownView` does not exist — a module's
 * embedded editor, for instance. Here the handler only decides *that* Quick
 * Ask should open on this view; the caller decides *how*.
 *
 * The trigger string itself stays a single global setting
 * (`continuationOptions.quickAskTrigger`), so every surface reacts to the same
 * keystroke.
 */

import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { YoloSettings } from '../../../settings/schema/setting.types'

export type QuickAskTriggerOptions = {
  getSettings: () => YoloSettings
  /**
   * Last guard before the keystroke is consumed. Runs after the typed text
   * matches the trigger and before anything is mutated, so returning false
   * leaves the character to be inserted as normal.
   */
  canTrigger?: (view: EditorView) => boolean
  /** Open Quick Ask on `view`, whose trigger text has already been removed. */
  show: (view: EditorView) => void
}

/**
 * Handles one `beforeinput`. Exported so the decision can be exercised
 * against a stand-in view, without a live CodeMirror instance.
 *
 * Returns true when the event was consumed and Quick Ask was opened.
 */
export function handleQuickAskTriggerInput(
  event: InputEvent,
  view: EditorView,
  options: QuickAskTriggerOptions,
): boolean {
  const continuationOptions = options.getSettings().continuationOptions

  // Check if Quick Ask feature is enabled (default: true)
  if (!(continuationOptions?.enableQuickAsk ?? true)) {
    return false
  }

  if (event.defaultPrevented) {
    return false
  }

  if (event.inputType !== 'insertText') {
    return false
  }
  if (event.isComposing) {
    return false
  }

  // Determine what character the user is typing
  const typedChar = event.data ?? ''

  // Only proceed if the typed character could be part of the trigger
  if (typedChar.length !== 1) {
    return false
  }

  const selection = view.state.selection.main
  if (!selection.empty) {
    return false
  }

  // Get trigger string from settings (default: @)
  const triggerStr = continuationOptions?.quickAskTrigger ?? '@'

  // Check if cursor is at an empty line or at line start
  const line = view.state.doc.lineAt(selection.head)
  const lineTextBeforeCursor = line.text.slice(0, selection.head - line.from)

  // Build the potential trigger sequence: existing text + new character
  const potentialSequence = lineTextBeforeCursor + typedChar

  // Check if the potential sequence matches the trigger string
  // (a partial match of a multi-character trigger is simply typed through and
  // may complete the trigger on a later keystroke)
  if (potentialSequence !== triggerStr) {
    return false
  }

  if (options.canTrigger && !options.canTrigger(view)) {
    return false
  }

  // Prevent default input
  event.preventDefault()
  event.stopPropagation()

  // Clear the trigger characters from the line before showing panel
  if (lineTextBeforeCursor.length > 0) {
    // Delete the partial trigger that was already typed
    const deleteFrom = line.from
    const deleteTo = selection.head
    view.dispatch({
      changes: { from: deleteFrom, to: deleteTo },
      selection: { anchor: deleteFrom },
    })
  }

  options.show(view)
  return true
}

export function createQuickAskTriggerExtension(
  options: QuickAskTriggerOptions,
): Extension {
  return EditorView.domEventHandlers({
    beforeinput: (event, view) =>
      handleQuickAskTriggerInput(event, view, options),
  })
}
