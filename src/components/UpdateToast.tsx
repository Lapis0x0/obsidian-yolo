import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider, useLanguage } from '../contexts/language-context'
import { PluginProvider, usePlugin } from '../contexts/plugin-context'
import { parseChangelog } from '../core/update/updateChecker'
import { useUpdateCheck } from '../hooks/useUpdateCheck'
import type YoloPlugin from '../main'

import { UpdateHistoryModal } from './modals/UpdateHistoryModal'
import { UpdateChangelogSections } from './update/UpdateChangelogSections'
import {
  type ReleaseLanguage,
  hasBilingualReleaseNotes,
  resolveDefaultLanguage,
} from './update/updateReleaseLanguage'

function UpdateToast() {
  const { language, t } = useLanguage()
  const plugin = usePlugin()
  const { app } = plugin
  const { result, dismissVersion } = useUpdateCheck()

  const [exiting, setExiting] = useState(false)
  const [hiddenForSession, setHiddenForSession] = useState(false)
  const [lang, setLang] = useState<ReleaseLanguage>('en')

  // Reset transient view state whenever a different version surfaces.
  const latestVersion = result?.latestVersion ?? null
  useEffect(() => {
    if (result) {
      setExiting(false)
      setHiddenForSession(false)
      setLang(resolveDefaultLanguage(result.releaseNotes, language))
    }
  }, [latestVersion, language, result])

  // Closing plays the exit animation first, then persists the dismissal state
  // (which unmounts the card). Timer-driven rather than onAnimationEnd so it still fires under
  // prefers-reduced-motion (where the animation is disabled). Keep in sync with
  // the 160ms exit duration in input.css.
  useEffect(() => {
    if (!exiting || !result) return
    const id = window.setTimeout(
      () => dismissVersion(result.latestVersion),
      160,
    )
    return () => window.clearTimeout(id)
  }, [dismissVersion, exiting, result])

  const releaseNotes = result?.releaseNotes
  // The header (title + subtitle) tracks the UI's default language; only the
  // body changelog follows the 中文/EN toggle.
  const headerLang = releaseNotes
    ? resolveDefaultLanguage(releaseNotes, language)
    : 'en'
  const headerNotes = releaseNotes ? (releaseNotes[headerLang] ?? '') : ''
  const bodyLang = releaseNotes
    ? resolveDefaultLanguage(releaseNotes, lang)
    : 'en'
  const bodyNotes = releaseNotes ? (releaseNotes[bodyLang] ?? '') : ''
  const subtitle = useMemo(
    () => parseChangelog(headerNotes).subtitle,
    [headerNotes],
  )
  const sections = useMemo(
    () => parseChangelog(bodyNotes).sections,
    [bodyNotes],
  )

  if (!result?.hasUpdate || !releaseNotes || hiddenForSession) {
    return null
  }

  const hasBilingual = hasBilingualReleaseNotes(releaseNotes)
  const separator = lang === 'zh' ? '：' : ': '

  const closeLabel = plugin.isUpdateVersionSoftDismissed(result.latestVersion)
    ? t('update.muteThisVersion', "Don't notify for this version")
    : t('update.dismiss', 'Dismiss')

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
    <div
      className={`yolo-update-toast${exiting ? ' yolo-update-toast--exiting' : ''}`}
    >
      <div className="yolo-update-toast-header">
        <div className="yolo-update-toast-heading">
          <div className="yolo-update-toast-titlerow">
            <span className="yolo-update-toast-title">
              {t('update.toastTitle', 'YOLO update available')}
            </span>
            <span className="yolo-update-toast-version">
              {result.latestVersion}
            </span>
          </div>
          {subtitle ? (
            <div className="yolo-update-toast-subtitle">{subtitle}</div>
          ) : null}
        </div>
        {langToggle}
        <button
          type="button"
          className="yolo-update-toast-icon-button"
          onClick={() => setExiting(true)}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div className="yolo-update-toast-divider" />

      <div className="yolo-update-toast-body">
        <UpdateChangelogSections sections={sections} separator={separator} />
      </div>

      <div className="yolo-update-toast-footer">
        <button
          type="button"
          className="yolo-update-toast-history-btn"
          title={t('update.viewHistory', 'View release history')}
          onClick={() => {
            setHiddenForSession(true)
            new UpdateHistoryModal(
              app,
              plugin,
              t('update.historyTitle', 'Release history'),
            ).open()
          }}
        >
          {t('update.viewHistory', 'View release history')}
        </button>
        <button
          type="button"
          className="yolo-update-toast-cta"
          title={t('update.viewDetails', 'Check for updates')}
          onClick={() => {
            // @ts-expect-error: setting property exists in Obsidian's App but is not typed
            app.setting.open()
            // @ts-expect-error: setting property exists in Obsidian's App but is not typed
            app.setting.openTabById('community-plugins')
            // Opening Obsidian's update flow is only an attempt to update; it
            // may fail or require another try, so do not mute this version.
            setHiddenForSession(true)
          }}
        >
          {t('update.goUpdate', 'Update')}
        </button>
      </div>
    </div>
  )
}

/**
 * Mounts the update toast as a standalone React root anchored to the bottom-left
 * of the Obsidian window (independent of any chat view). Returns a cleanup that
 * unmounts the root and removes its host element.
 */
export function mountUpdateToast(plugin: YoloPlugin): () => void {
  const container = document.createElement('div')
  container.className = 'yolo-update-toast-root'
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  root.render(
    <PluginProvider plugin={plugin}>
      <LanguageProvider>
        <UpdateToast />
      </LanguageProvider>
    </PluginProvider>,
  )

  return () => {
    root.unmount()
    container.remove()
  }
}
