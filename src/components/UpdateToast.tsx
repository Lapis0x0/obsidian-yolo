import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider, useLanguage } from '../contexts/language-context'
import { PluginProvider, usePlugin } from '../contexts/plugin-context'
import { parseChangelog } from '../core/update/updateChecker'
import { useModuleUpdates } from '../hooks/useModuleUpdates'
import { usePluginUpdatePrimaryCta } from '../hooks/usePluginUpdatePrimaryCta'
import { useUpdateCheck } from '../hooks/useUpdateCheck'
import type YoloPlugin from '../main'

import { FloatingToast } from './common/FloatingToast'
import { UpdateHistoryModal } from './modals/UpdateHistoryModal'
import { UpdateChangelogSections } from './update/UpdateChangelogSections'
import {
  type ReleaseLanguage,
  hasBilingualReleaseNotes,
  resolveDefaultLanguage,
} from './update/updateReleaseLanguage'

function fallbackModuleReleaseNotes(
  version: string,
  name: string,
): { en: string; zh: string } {
  return {
    en: `## ${version} ${name} update

### 🔧 Update available

- **Release notes unavailable**: You can update now or try loading the details again later.`,
    zh: `## ${version} ${name} 更新

### 🔧 有可用更新

- **更新说明暂时无法加载**：你仍然可以立即更新，或稍后重新加载详细说明。`,
  }
}

function UpdateToast() {
  const { language, t } = useLanguage()
  const plugin = usePlugin()
  const { app } = plugin
  const { result: coreResult, muteUpdateVersion } = useUpdateCheck()
  const moduleOffers = useModuleUpdates()
  const moduleOffer = coreResult?.hasUpdate ? null : (moduleOffers[0] ?? null)
  const result = coreResult?.hasUpdate
    ? coreResult
    : moduleOffer
      ? {
          hasUpdate: true,
          latestVersion: moduleOffer.latestVersion,
          releaseNotes:
            moduleOffer.releaseNotes ??
            fallbackModuleReleaseNotes(
              moduleOffer.latestVersion,
              moduleOffer.name,
            ),
          releaseUrl: '',
          assets: null,
        }
      : null
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
  const activeKey = moduleOffer?.key ?? result?.latestVersion ?? null

  // Reset transient view state whenever a different version surfaces.
  useEffect(() => {
    if (result) {
      setExiting(false)
      setHiddenForSession(false)
      setLang(resolveDefaultLanguage(result.releaseNotes, language))
    }
  }, [activeKey, language, result])

  // Closing plays the exit animation first, then hides for this session only.
  // Use "Skip this version" in the header to persist a mute across launches.
  // Timer-driven rather than onAnimationEnd so it still fires under
  // prefers-reduced-motion (where the animation is disabled). Keep in sync with
  // the 160ms exit duration in input.css.
  useEffect(() => {
    if (!exiting || !result) return
    const id = window.setTimeout(() => {
      if (moduleOffer) plugin.dismissModuleUpdateForSession(moduleOffer.key)
      else {
        plugin.dismissUpdateForSession()
        setHiddenForSession(true)
      }
      setExiting(false)
    }, 160)
    return () => window.clearTimeout(id)
  }, [exiting, moduleOffer, plugin, result])

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
  const isModule = Boolean(moduleOffer)
  const moduleBusy =
    moduleOffer?.status === 'downloading' ||
    moduleOffer?.status === 'applying' ||
    moduleOffer?.status === 'success'
  const moduleCtaLabel = moduleOffer
    ? moduleOffer.status === 'downloading'
      ? t('update.downloading', 'Downloading {{progress}}%').replace(
          '{{progress}}',
          String(Math.round(moduleOffer.progress)),
        )
      : moduleOffer.status === 'applying'
        ? t('update.applying', 'Installing…')
        : moduleOffer.status === 'error'
          ? t('common.retry', 'Retry')
          : moduleOffer.status === 'success'
            ? language === 'zh'
              ? '更新完成'
              : 'Updated'
            : t('update.goUpdate', 'Update')
    : ''

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
    <FloatingToast
      className={`yolo-update-toast${exiting ? ' yolo-update-toast--exiting' : ''}`}
      exiting={exiting}
    >
      <div className="yolo-update-toast-header">
        <div className="yolo-update-toast-heading">
          <div className="yolo-update-toast-titlerow">
            <span className="yolo-update-toast-title">
              {isModule
                ? language === 'zh'
                  ? `${moduleOffer!.name} 有新版本`
                  : `${moduleOffer!.name} update available`
                : t('update.toastTitle', 'YOLO update available')}
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
              if (moduleOffer) void plugin.muteModuleUpdate(moduleOffer.key)
              else muteUpdateVersion(result.latestVersion)
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
        {moduleOffer?.status === 'success' ? (
          <div className="yolo-update-toast-success">
            {language === 'zh'
              ? `✓ ${moduleOffer.name} 已更新到 ${moduleOffer.latestVersion}`
              : `✓ ${moduleOffer.name} updated to ${moduleOffer.latestVersion}`}
          </div>
        ) : (
          <UpdateChangelogSections sections={sections} separator={separator} />
        )}
      </div>

      {showDownloadProgress || moduleOffer?.status === 'downloading' ? (
        <div className="yolo-update-toast-progress" aria-hidden="true">
          <div
            className="yolo-update-toast-progress-fill"
            style={{
              width: `${moduleOffer?.status === 'downloading' ? moduleOffer.progress : downloadProgress}%`,
            }}
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
                moduleOffer
                  ? { kind: 'module', key: moduleOffer.key }
                  : undefined,
              ).open()
            }}
          >
            {t('update.viewHistory', 'View release history')}
          </button>
        </div>
        <div className="yolo-update-toast-footer-actions">
          {!moduleOffer && showCommunityPluginsFallback && hasSelfUpdate ? (
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
            className={`yolo-update-toast-cta${moduleOffer ? (moduleBusy ? ' is-disabled' : '') : primaryCta.disabled ? ' is-disabled' : ''}`}
            title={moduleOffer ? moduleCtaLabel : primaryCta.label}
            disabled={moduleOffer ? moduleBusy : primaryCta.disabled}
            onClick={() => {
              if (moduleOffer) void plugin.applyModuleUpdate(moduleOffer.key)
              else primaryCta.onClick()
            }}
          >
            {moduleOffer ? moduleCtaLabel : primaryCta.label}
          </button>
        </div>
      </div>
      {!moduleOffer && isSelfUpdateError && releaseUrl ? (
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
    </FloatingToast>
  )
}

/**
 * Mounts the update toast as a standalone React root anchored to the bottom-left
 * of the Obsidian window (independent of any chat view). Returns a cleanup that
 * unmounts the root and removes its host element.
 */
export function mountUpdateToast(plugin: YoloPlugin): () => void {
  const container = document.createElement('div')
  container.className =
    'yolo-floating-toast-root is-bottom-left yolo-update-toast-root'
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
