import { ChevronDown, Link2 } from 'lucide-react'
import { Keymap, MarkdownView, Notice } from 'obsidian'
import React, { useState } from 'react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import type { SimilarNote } from '../../../core/rag/similarNotes'
import { getNodeWindow } from '../../../utils/dom/window-context'

/** How many strength ticks a snippet shows, matching the design's three-tick scale. */
const SNIPPET_TICKS = 3

function basename(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.[^.]+$/, '')
}

function folderTrail(path: string): string {
  const segments = path.split('/')
  segments.pop()
  return segments.join(' / ')
}

/**
 * Chunks keep the note's own blank lines, and a chunk can be ~1000
 * characters — pasted verbatim that turns one passage into a wall with gaps.
 * Runs of blank lines collapse to one; the line clamp in CSS caps the height.
 */
function condenseSnippet(content: string): string {
  return content.trim().replace(/\n\s*\n\s*/g, '\n')
}

/** At least one tick always fills — a shown passage is never "zero strength". */
function filledTicks(strength: number): number {
  return Math.max(1, Math.round(strength * SNIPPET_TICKS))
}

const SimilarNoteCard: React.FC<{
  note: SimilarNote
  sourcePath: string
}> = ({ note, sourcePath }) => {
  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const [expanded, setExpanded] = useState(false)

  /**
   * Always opens in a new tab. The panel's results are keyed to the active
   * file, so reusing the current leaf would replace the note the list was
   * computed from — you lose both the source and the way back. A modifier
   * still picks its own pane type (split / window).
   */
  const handleOpen = (event: React.MouseEvent) => {
    void app.workspace.openLinkText(
      note.path,
      sourcePath,
      Keymap.isModEvent(event.nativeEvent) || 'tab',
    )
  }

  const handleHover = (event: React.MouseEvent) => {
    app.workspace.trigger('hover-link', {
      event: event.nativeEvent,
      source: 'yolo-similar-notes',
      hoverParent: { hoverPopover: null },
      targetEl: event.currentTarget,
      linktext: note.path,
      sourcePath,
    })
  }

  const handleInsertLink = () => {
    const markdownView: MarkdownView | null =
      plugin.getMarkdownInsertionTarget()
    const file = app.vault.getFileByPath(note.path)
    if (!markdownView || !file) {
      new Notice(
        t(
          'sparkle.similarNotes.insertUnavailable',
          'No active markdown editor',
        ),
      )
      return
    }
    const editor = markdownView.editor
    const link = app.fileManager.generateMarkdownLink(
      file,
      markdownView.file?.path ?? sourcePath,
    )
    editor.replaceSelection(link)
    editor.focus()
  }

  /**
   * The whole card toggles, so the small chevron isn't the only target. Two
   * things must still get through: the buttons keep their own actions (the
   * title opens the note), and a drag that selected text must not collapse
   * the card out from under the selection — snippets are there to be read
   * and copied.
   */
  const handleCardClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    const selection = getNodeWindow(event.currentTarget).getSelection()
    if (selection && !selection.isCollapsed) return
    setExpanded((value) => !value)
  }

  return (
    <div
      className="yolo-similar-note-card"
      data-expanded={expanded}
      onClick={handleCardClick}
    >
      <div
        className="yolo-similar-note-card-strength"
        /* Absolute, not list-relative: a weak set draws every bar faint
           instead of pinning whichever card happens to be first to full. */
        style={{ opacity: note.strength }}
        aria-hidden="true"
      />
      <div className="yolo-similar-note-card-body">
        <div className="yolo-similar-note-card-head">
          <button
            type="button"
            className="yolo-similar-note-card-title"
            onClick={handleOpen}
            onMouseOver={handleHover}
          >
            {basename(note.path)}
          </button>
          <div className="yolo-similar-note-card-actions">
            <button
              type="button"
              className="clickable-icon yolo-similar-note-card-action"
              aria-label={t(
                'sparkle.similarNotes.insertLink',
                'Insert link at cursor',
              )}
              onClick={handleInsertLink}
            >
              <Link2 size={14} />
            </button>
            <button
              type="button"
              className="clickable-icon yolo-similar-note-card-action"
              aria-label={
                expanded
                  ? t(
                      'sparkle.similarNotes.collapseSnippets',
                      'Hide matching passages',
                    )
                  : t(
                      'sparkle.similarNotes.expandSnippets',
                      'Show matching passages',
                    )
              }
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <ChevronDown
                size={14}
                className="yolo-similar-note-card-chevron"
              />
            </button>
          </div>
        </div>
        {folderTrail(note.path) ? (
          <div className="yolo-similar-note-card-path">
            {folderTrail(note.path)}
          </div>
        ) : null}
        {expanded ? (
          <div className="yolo-similar-note-card-snippets">
            {note.snippets.map((snippet) => (
              <div
                key={`${snippet.startLine}-${snippet.endLine}`}
                className="yolo-similar-note-snippet"
              >
                <div
                  className="yolo-similar-note-snippet-ticks"
                  aria-hidden="true"
                >
                  {Array.from({ length: SNIPPET_TICKS }, (_, tick) => (
                    <span
                      key={tick}
                      className="yolo-similar-note-snippet-tick"
                      data-filled={tick < filledTicks(snippet.strength)}
                    />
                  ))}
                </div>
                <div className="yolo-similar-note-snippet-text">
                  {condenseSnippet(snippet.content)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="yolo-similar-note-card-preview">
            {condenseSnippet(note.snippets[0]?.content ?? '')}
          </div>
        )}
      </div>
    </div>
  )
}

export default SimilarNoteCard
