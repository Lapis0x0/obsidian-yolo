import { ChevronDown, RefreshCw } from 'lucide-react'
import { Notice } from 'obsidian'
import React, { useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { SimpleSelect } from '../../common/SimpleSelect'
import { useActiveFile } from '../hooks/useActiveFile'

import SimilarNoteCard from './SimilarNoteCard'
import { useIndexedNoteCount } from './useIndexedNoteCount'
import { useSimilarNotes } from './useSimilarNotes'

const ALL_KNOWLEDGE_BASES = '__all__'

const SimilarNotesSection: React.FC<{
  visible: boolean
  onOpenKnowledgeBaseSettings: () => void
}> = ({ visible, onOpenKnowledgeBaseSettings }) => {
  const { t } = useLanguage()
  const plugin = usePlugin()
  const { settings, updateSettings } = useSettings()
  const file = useActiveFile()
  const [collapsed, setCollapsed] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [indexing, setIndexing] = useState(false)

  const scopeKbId = settings.continuationOptions.similarNotesKnowledgeBaseId
  const state = useSimilarNotes({ file, visible, refreshToken })
  const indexedCount = useIndexedNoteCount({ scopeKbId, visible, refreshToken })

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), [])

  const scopeOptions = useMemo(
    () => [
      {
        value: ALL_KNOWLEDGE_BASES,
        label: t(
          'sparkle.similarNotes.allKnowledgeBases',
          'All knowledge bases',
        ),
      },
      ...settings.knowledgeBases.map((kb) => ({
        value: kb.id,
        label: kb.name,
      })),
    ],
    [settings.knowledgeBases, t],
  )

  const handleScopeChange = (value: string) => {
    void updateSettings((current) => ({
      ...current,
      continuationOptions: {
        ...current.continuationOptions,
        similarNotesKnowledgeBaseId:
          value === ALL_KNOWLEDGE_BASES ? undefined : value,
      },
    }))
  }

  const handleIndexCurrentNote = async (kbIds: string[]) => {
    if (!file || indexing) return
    setIndexing(true)
    try {
      for (const kbId of kbIds) {
        await plugin.runRagIndex(kbId, {
          mode: 'sync',
          scope: { kind: 'paths', paths: [file.path] },
          trigger: 'manual',
          retryPolicy: 'none',
        })
      }
      refresh()
    } catch (error) {
      console.error('[YOLO] Failed to index the current note.', error)
      new Notice(
        t('sparkle.similarNotes.indexFailed', 'Failed to index this note'),
      )
    } finally {
      setIndexing(false)
    }
  }

  const notes = state.status === 'ready' ? state.notes : []
  const bestSimilarity = notes[0]?.similarity ?? 0

  const body = (() => {
    switch (state.status) {
      case 'no-file':
        return (
          <div className="yolo-sparkle-empty">
            <div className="yolo-sparkle-empty-title">
              {t('sparkle.similarNotes.noActiveNote', 'No note is open')}
            </div>
            <div className="yolo-sparkle-empty-body">
              {t(
                'sparkle.similarNotes.noActiveNoteHint',
                'Open a note to see what it relates to.',
              )}
            </div>
          </div>
        )
      case 'no-embedding-model':
        return (
          <div className="yolo-sparkle-empty">
            <div className="yolo-sparkle-empty-title">
              {t(
                'sparkle.similarNotes.noEmbeddingModel',
                'No embedding model configured',
              )}
            </div>
            <div className="yolo-sparkle-empty-body">
              {t(
                'sparkle.similarNotes.noEmbeddingModelHint',
                'Similar notes need an embedding model to compare notes with.',
              )}
            </div>
            <button type="button" onClick={onOpenKnowledgeBaseSettings}>
              {t('sparkle.similarNotes.configure', 'Configure')}
            </button>
          </div>
        )
      case 'loading':
        return (
          <div className="yolo-sparkle-skeleton" aria-busy="true">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="yolo-sparkle-skeleton-card" />
            ))}
          </div>
        )
      case 'source-not-indexed':
        return (
          <div className="yolo-sparkle-empty">
            <div className="yolo-sparkle-empty-title">
              {state.indexableKbIds.length > 0
                ? t(
                    'sparkle.similarNotes.notIndexed',
                    'This note has not been indexed yet',
                  )
                : t(
                    'sparkle.similarNotes.outOfScope',
                    'This note is outside every knowledge base',
                  )}
            </div>
            <div className="yolo-sparkle-empty-body">
              {state.indexableKbIds.length > 0
                ? t(
                    'sparkle.similarNotes.notIndexedHint',
                    'Similar notes come from the vector index. Index this note to see what it relates to.',
                  )
                : t(
                    'sparkle.similarNotes.outOfScopeHint',
                    'Add its folder to a knowledge base to include it in similar notes.',
                  )}
            </div>
            {state.indexableKbIds.length > 0 ? (
              <button
                type="button"
                disabled={indexing}
                onClick={() =>
                  void handleIndexCurrentNote(state.indexableKbIds)
                }
              >
                {indexing
                  ? t('sparkle.similarNotes.indexing', 'Indexing…')
                  : t('sparkle.similarNotes.indexThisNote', 'Index this note')}
              </button>
            ) : null}
            <button
              type="button"
              className="yolo-sparkle-empty-secondary"
              onClick={onOpenKnowledgeBaseSettings}
            >
              {t(
                'sparkle.similarNotes.openKnowledgeBaseSettings',
                'Open knowledge base settings',
              )}
            </button>
          </div>
        )
      case 'error':
        return (
          <div className="yolo-sparkle-empty">
            <div className="yolo-sparkle-empty-title">
              {t('sparkle.similarNotes.error', 'Could not load similar notes')}
            </div>
            <div className="yolo-sparkle-empty-body">{state.message}</div>
            <button type="button" onClick={refresh}>
              {t('sparkle.similarNotes.retry', 'Retry')}
            </button>
          </div>
        )
      case 'ready':
        if (notes.length === 0) {
          return (
            <div className="yolo-sparkle-empty">
              <div className="yolo-sparkle-empty-title">
                {t(
                  'sparkle.similarNotes.empty',
                  'No similar notes in this scope',
                )}
              </div>
              <div className="yolo-sparkle-empty-body">
                {t(
                  'sparkle.similarNotes.emptyHint',
                  'Widen the scope to search more knowledge bases.',
                )}
              </div>
            </div>
          )
        }
        return (
          <div className="yolo-similar-note-list">
            {notes.map((note) => (
              <SimilarNoteCard
                key={note.path}
                note={note}
                bestSimilarity={bestSimilarity}
                sourcePath={file?.path ?? ''}
              />
            ))}
          </div>
        )
    }
  })()

  return (
    <section className="yolo-sparkle-section" data-collapsed={collapsed}>
      <div className="yolo-sparkle-section-header">
        <button
          type="button"
          className="yolo-sparkle-section-toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          <ChevronDown size={14} className="yolo-sparkle-section-chevron" />
          <span className="yolo-sparkle-section-title">
            {t('sparkle.similarNotes.title', 'Similar notes')}
          </span>
          {state.status === 'ready' && notes.length > 0 ? (
            <span className="yolo-sparkle-section-count">{notes.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          className="clickable-icon yolo-sparkle-section-action"
          aria-label={t('sparkle.similarNotes.refresh', 'Refresh')}
          onClick={refresh}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {collapsed ? null : (
        <>
          <div className="yolo-sparkle-scope-row">
            <span className="yolo-sparkle-scope-label">
              {t('sparkle.similarNotes.scope', 'Scope')}
            </span>
            <SimpleSelect
              value={scopeKbId ?? ALL_KNOWLEDGE_BASES}
              options={scopeOptions}
              onChange={handleScopeChange}
              align="start"
            />
            {indexedCount === null ? null : (
              <>
                <span className="yolo-sparkle-scope-separator">·</span>
                <span className="yolo-sparkle-scope-meta">
                  {t(
                    'sparkle.similarNotes.indexedCount',
                    '{count} notes indexed',
                  ).replace('{count}', String(indexedCount))}
                </span>
              </>
            )}
            <span className="yolo-sparkle-scope-separator">·</span>
            <button
              type="button"
              className="yolo-sparkle-scope-link"
              onClick={onOpenKnowledgeBaseSettings}
            >
              {t('sparkle.similarNotes.change', 'Change')}
            </button>
          </div>
          {file && state.status === 'ready' ? (
            <div className="yolo-sparkle-source-row">
              {t('sparkle.similarNotes.basedOn', 'Based on')}{' '}
              <span className="yolo-sparkle-source-name">{file.basename}</span>
            </div>
          ) : null}
          {body}
        </>
      )}
    </section>
  )
}

export default SimilarNotesSection
