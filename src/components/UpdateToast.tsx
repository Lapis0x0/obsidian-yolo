import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider, useLanguage } from '../contexts/language-context'
import { PluginProvider, usePlugin } from '../contexts/plugin-context'
import { parseChangelog } from '../core/update/updateChecker'
import { usePluginUpdatePrimaryCta } from '../hooks/usePluginUpdatePrimaryCta'
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
  const { result, muteUpdateVersion } = useUpdateCheck()
  const {
    primaryCta,
    hasSelfUpdate,
    isSelfUpdateError,
    showCommunityPluginsFallback,
    showDownloadProgress,
    downloadProgress,
    releaseUrl,
    openCommunityPlugins,
  } = usePluginUpdatePrimaryCta({
    onOpenCommunityPlugins: () => setHiddenForSession(true),
  })

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

  // Closing plays the exit animation first, then hides for this session only.
  // Use "Skip this version" in the header to persist a mute across launches.
  // Timer-driven rather than onAnimationEnd so it still fires under
  // prefers-reduced-motion (where the animation is disabled). Keep in sync with
  // the 160ms exit duration in input.css.
  useEffect(() => {
    if (!exiting || !result) return
    const id = window.setTimeout(() => setHiddenForSession(true), 160)
    return () => window.clearTimeout(id)
  }, [exiting, result])

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

  const closeLabel = t('update.dismiss', 'Dismiss')

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
        <div className="yolo-update-toast-header-actions">
          <button
            type="button"
            className="yolo-update-toast-skip-btn"
            title={t('update.skipVersion', "Don't remind me for this version")}
            onClick={() => {
              muteUpdateVersion(result.latestVersion)
            }}
          >
            {t('update.skipVersion', "Don't remind me for this version")}
          </button>
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
      </div>

      <div className="yolo-update-toast-divider" />

      <div className="yolo-update-toast-body">
        <UpdateChangelogSections sections={sections} separator={separator} />
      </div>

      {showDownloadProgress ? (
        <div className="yolo-update-toast-progress" aria-hidden="true">
          <div
            className="yolo-update-toast-progress-fill"
            style={{ width: `${downloadProgress}%` }}
          />
        </div>
      ) : null}

      <div className="yolo-update-toast-footer">
        <div className="yolo-update-toast-footer-start">
          {langToggle}
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
        </div>
        <div className="yolo-update-toast-footer-actions">
          {showCommunityPluginsFallback && hasSelfUpdate ? (
            <button
              type="button"
              className="yolo-update-toast-secondary-btn"
              title={t(
                'update.updateInCommunityPlugins',
                'Update in community plugins',
              )}
              onClick={openCommunityPlugins}
            >
              {t(
                'update.updateInCommunityPlugins',
                'Update in community plugins',
              )}
            </button>
          ) : null}
          <button
            type="button"
            className={`yolo-update-toast-cta${primaryCta.disabled ? ' is-disabled' : ''}`}
            title={primaryCta.label}
            disabled={primaryCta.disabled}
            onClick={primaryCta.onClick}
          >
            {primaryCta.label}
          </button>
        </div>
      </div>
      {isSelfUpdateError && releaseUrl ? (
        <button
          type="button"
          className="yolo-update-toast-manual-link"
          onClick={() => {
            window.open(releaseUrl)
          }}
        >
          {t(
            'update.manualInstallOnGitHub',
            "Can't update? Install manually from GitHub",
          )}
        </button>
      ) : null}
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
