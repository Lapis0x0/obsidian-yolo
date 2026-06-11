import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { App } from 'obsidian'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  type ReleaseHistoryEntry,
  type ReleaseHistoryPageResult,
  fetchReleaseHistoryPage,
  locateReleaseHistoryPage,
  normalizePluginVersion,
  parseChangelog,
} from '../../core/update/updateChecker'
import YoloPlugin from '../../main'
import { ReactModal } from '../common/ReactModal'
import { UpdateChangelogSections } from '../update/UpdateChangelogSections'
import {
  type ReleaseLanguage,
  entriesHaveBilingualNotes,
  resolveDefaultLanguage,
  resolveReleaseNotesForLanguage,
} from '../update/updateReleaseLanguage'

type UpdateHistoryModalComponentProps = {
  plugin: YoloPlugin
  title: string
}

export class UpdateHistoryModal extends ReactModal<UpdateHistoryModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin, title: string) {
    super({
      app,
      Component: UpdateHistoryModalComponent,
      props: { plugin, title },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide', 'yolo-update-history-modal')
  }
}

function UpdateHistoryModalComponent({
  title,
  plugin,
  onClose,
}: UpdateHistoryModalComponentProps & { onClose: () => void }) {
  const { language, t } = useLanguage()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [entries, setEntries] = useState<ReleaseHistoryEntry[]>([])
  const [hasNext, setHasNext] = useState(false)
  const [lang, setLang] = useState<ReleaseLanguage>('en')
  const [page, setPage] = useState(0)
  const [initialized, setInitialized] = useState(false)
  const pageCacheRef = useRef<Map<number, ReleaseHistoryPageResult>>(new Map())
  const prefetchInFlightRef = useRef<Set<number>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)
  const currentVersion = useMemo(
    () => normalizePluginVersion(plugin.manifest.version),
    [plugin.manifest.version],
  )

  const prefetchPage = useCallback(async (targetPage: number) => {
    if (pageCacheRef.current.has(targetPage)) return
    if (prefetchInFlightRef.current.has(targetPage)) return

    prefetchInFlightRef.current.add(targetPage)
    try {
      const fetched = await fetchReleaseHistoryPage(targetPage + 1)
      if (fetched) {
        pageCacheRef.current.set(targetPage, fetched)
      }
    } finally {
      prefetchInFlightRef.current.delete(targetPage)
    }
  }, [])

  const loadPage = useCallback(
    async (targetPage: number) => {
      const cached = pageCacheRef.current.get(targetPage)
      if (cached) {
        setError(false)
        setEntries(cached.entries)
        setHasNext(cached.hasNext)
        setLoading(false)
        if (cached.hasNext) {
          void prefetchPage(targetPage + 1)
        }
        return
      }

      setLoading(true)
      setError(false)
      const fetched = await fetchReleaseHistoryPage(targetPage + 1)
      if (!fetched) {
        setError(true)
        setEntries([])
        setHasNext(false)
        setLoading(false)
        return
      }

      pageCacheRef.current.set(targetPage, fetched)
      setEntries(fetched.entries)
      setHasNext(fetched.hasNext)
      setLoading(false)

      if (fetched.hasNext) {
        void prefetchPage(targetPage + 1)
      }
    },
    [prefetchPage],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(false)
      const located = await locateReleaseHistoryPage(currentVersion)
      if (cancelled) return

      if (located) {
        for (const [pageIndex, result] of located.pageCache) {
          pageCacheRef.current.set(pageIndex, result)
        }
        setPage(located.pageIndex)
      }

      setInitialized(true)
    })()

    return () => {
      cancelled = true
    }
  }, [currentVersion])

  useEffect(() => {
    if (!initialized) return
    void loadPage(page)
  }, [initialized, loadPage, page])

  useEffect(() => {
    if (loading || entries.length === 0) return
    listRef.current?.scrollTo({ top: 0 })
  }, [page, loading, entries])

  useEffect(() => {
    if (entries.length === 0) return
    setLang(resolveDefaultLanguage(entries[0].releaseNotes, language))
  }, [entries, language])

  const hasBilingual = useMemo(
    () => entriesHaveBilingualNotes(entries),
    [entries],
  )
  const separator = lang === 'zh' ? '：' : ': '
  const showPagination = page > 0 || hasNext
  const pageLabel = t('update.historyPage', 'Page {{current}}').replace(
    '{{current}}',
    String(page + 1),
  )

  const openCommunityPluginUpdate = () => {
    const { app } = plugin
    // @ts-expect-error: setting property exists in Obsidian's App but is not typed
    app.setting.open()
    // @ts-expect-error: setting property exists in Obsidian's App but is not typed
    app.setting.openTabById('community-plugins')
    onClose()
  }

  const langToggle = hasBilingual ? (
    <div
      className="yolo-update-toast-lang"
      role="group"
      aria-label="Release notes language"
    >
      <button
        type="button"
        className={`yolo-update-toast-lang-option${lang === 'zh' ? ' is-active' : ''}`}
        onClick={() => setLang('zh')}
      >
        {t('update.languageChinese', '中文')}
      </button>
      <button
        type="button"
        className={`yolo-update-toast-lang-option${lang === 'en' ? ' is-active' : ''}`}
        onClick={() => setLang('en')}
      >
        {t('update.languageEnglish', 'EN')}
      </button>
    </div>
  ) : null

  return (
    <div className="yolo-update-history">
      <div className="yolo-update-history-header">
        <h2 className="yolo-update-history-title">{title}</h2>
        {langToggle}
        <button
          type="button"
          className="yolo-update-toast-icon-button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          title={t('common.close', 'Close')}
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>
      {loading ? (
        <div className="yolo-update-history-status">
          {t('update.historyLoading', 'Loading release history...')}
        </div>
      ) : error ? (
        <div className="yolo-update-history-status">
          {t('update.historyError', 'Failed to load release history.')}
        </div>
      ) : entries.length === 0 ? (
        <div className="yolo-update-history-status">
          {t('update.historyEmpty', 'No release history found.')}
        </div>
      ) : (
        <>
          <div className="yolo-update-history-list" ref={listRef}>
            {entries.map((entry) => {
              const notes = resolveReleaseNotesForLanguage(
                entry.releaseNotes,
                lang,
              )
              const parsed = parseChangelog(notes)
              const isCurrent = entry.version === currentVersion
              return (
                <section
                  className={`yolo-update-history-entry${
                    isCurrent ? ' is-current' : ''
                  }`}
                  key={entry.version}
                >
                  <div className="yolo-update-history-entry-head">
                    <span className="yolo-update-history-entry-version">
                      {entry.version}
                    </span>
                    <div className="yolo-update-history-entry-head-main">
                      {parsed.subtitle ? (
                        <span
                          className="yolo-update-history-entry-subtitle"
                          title={parsed.subtitle}
                        >
                          {parsed.subtitle}
                        </span>
                      ) : null}
                      {isCurrent ? (
                        <span className="yolo-update-history-entry-current-badge">
                          {t('update.currentVersion', 'Current')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {parsed.sections.length > 0 ? (
                    <UpdateChangelogSections
                      sections={parsed.sections}
                      separator={separator}
                    />
                  ) : null}
                </section>
              )
            })}
          </div>
          <div className="yolo-update-history-footer">
            {showPagination ? (
              <div className="yolo-update-history-pagination">
                <button
                  type="button"
                  className="yolo-update-history-page-btn"
                  disabled={page <= 0 || loading}
                  aria-label={t('update.historyPrev', 'Previous page')}
                  title={t('update.historyPrev', 'Previous page')}
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                >
                  <ChevronLeft size={14} strokeWidth={2} />
                  <span>{t('update.historyPrev', 'Previous page')}</span>
                </button>
                <span className="yolo-update-history-page-label">
                  {pageLabel}
                </span>
                <button
                  type="button"
                  className="yolo-update-history-page-btn"
                  disabled={!hasNext || loading}
                  aria-label={t('update.historyNext', 'Next page')}
                  title={t('update.historyNext', 'Next page')}
                  onClick={() => setPage((current) => current + 1)}
                >
                  <span>{t('update.historyNext', 'Next page')}</span>
                  <ChevronRight size={14} strokeWidth={2} />
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="yolo-update-toast-cta yolo-update-history-update-btn"
              title={t('update.viewDetails', 'Check for updates')}
              onClick={openCommunityPluginUpdate}
            >
              {t('update.goUpdate', 'Update')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
