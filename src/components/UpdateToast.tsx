import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider, useLanguage } from '../contexts/language-context'
import { PluginProvider, usePlugin } from '../contexts/plugin-context'
import type { ModuleUpdateOffer } from '../core/update/moduleUpdateController'
import {
  type ReleaseNotesByLanguage,
  parseChangelog,
} from '../core/update/updateChecker'
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

type UpdateItem = Readonly<{
  key: string
  name: string
  version: string
  releaseNotes: ReleaseNotesByLanguage
  /** Absent for the core update. */
  moduleOffer: ModuleUpdateOffer | null
}>

const CORE_ITEM_KEY = 'core'

/**
 * Every pending update in one card, one tab each, behind one button.
 *
 * With a core update in the card the button updates the core and restarts;
 * the modules beside it — those that run on this core and those that need
 * the new one alike — are installed by `followCoreUpdate` on the next start,
 * so one click covers a coordinated release. Without one, the button
 * installs the module updates one after another. A module that needs the
 * new core is only listed while that core update is here to bring it.
 */
function UpdateToast() {
  const { language, t } = useLanguage()
  const plugin = usePlugin()
  const { app } = plugin
  const { result: coreResult, muteUpdateVersion } = useUpdateCheck()
  const moduleOffers = useModuleUpdates()
  const coreUpdate = coreResult?.hasUpdate ? coreResult : null
  const items = useMemo((): readonly UpdateItem[] => {
    const modules = moduleOffers
      .filter((offer) => coreUpdate !== null || !offer.awaitingCoreUpdate)
      .map(
        (offer): UpdateItem => ({
          key: offer.key,
          name: offer.name,
          version: offer.latestVersion,
          releaseNotes:
            offer.releaseNotes ??
            fallbackModuleReleaseNotes(offer.latestVersion, offer.name),
          moduleOffer: offer,
        }),
      )
    if (!coreUpdate) return modules
    return [
      {
        key: CORE_ITEM_KEY,
        name: 'YOLO',
        version: coreUpdate.latestVersion,
        releaseNotes: coreUpdate.releaseNotes,
        moduleOffer: null,
      },
      ...modules,
    ]
  }, [coreUpdate, moduleOffers])
  const moduleItems = items.filter((item) => item.moduleOffer !== null)

  const {
    primaryCta,
    hasSelfUpdate,
    isSelfUpdateError,
    showCommunityPluginsFallback,
    releaseUrl,
    openCommunityPlugins,
  } = usePluginUpdatePrimaryCta({
    onOpenCommunityPlugins: () => setHiddenForSession(true),
  })

  const [exiting, setExiting] = useState(false)
  const [hiddenForSession, setHiddenForSession] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [lang, setLang] = useState<ReleaseLanguage>('en')
  const selected =
    items.find((item) => item.key === selectedKey) ?? items[0] ?? null
  const itemsKey = items.map((item) => item.key).join('|')

  // Reset transient view state whenever a different set of updates surfaces.
  useEffect(() => {
    if (!itemsKey) return
    setExiting(false)
    setHiddenForSession(false)
  }, [itemsKey])

  const selectedNotes = selected?.releaseNotes ?? null
  useEffect(() => {
    if (!selectedNotes) return
    setLang(resolveDefaultLanguage(selectedNotes, language))
  }, [selected?.key, language, selectedNotes])

  // Closing plays the exit animation first, then hides every update for this
  // session only. "Skip this version" in the header is what persists, for the
  // selected update alone. Timer-driven rather than onAnimationEnd so it still
  // fires under prefers-reduced-motion (where the animation is disabled). Keep
  // in sync with the 160ms exit duration in input.css.
  useEffect(() => {
    if (!exiting) return
    const id = window.setTimeout(() => {
      for (const item of items) {
        if (item.moduleOffer) {
          plugin.dismissModuleUpdateForSession(item.moduleOffer.key)
        } else {
          plugin.dismissUpdateForSession()
        }
      }
      setExiting(false)
    }, 160)
    return () => window.clearTimeout(id)
  }, [exiting, items, plugin])

  // The header (title + subtitle) tracks the UI's default language; only the
  // body changelog follows the 中文/EN toggle.
  const headerLang = selectedNotes
    ? resolveDefaultLanguage(selectedNotes, language)
    : 'en'
  const headerNotes = selectedNotes ? (selectedNotes[headerLang] ?? '') : ''
  const bodyLang = selectedNotes
    ? resolveDefaultLanguage(selectedNotes, lang)
    : 'en'
  const bodyNotes = selectedNotes ? (selectedNotes[bodyLang] ?? '') : ''
  const subtitle = useMemo(
    () => parseChangelog(headerNotes).subtitle,
    [headerNotes],
  )
  const sections = useMemo(
    () => parseChangelog(bodyNotes).sections,
    [bodyNotes],
  )

  if (!selected || !selectedNotes || hiddenForSession) {
    return null
  }

  const hasBilingual = hasBilingualReleaseNotes(selectedNotes)
  const separator = lang === 'zh' ? '：' : ': '
  const closeLabel = t('update.dismiss', 'Dismiss')
  const selectedOffer = selected.moduleOffer

  const title =
    items.length > 1
      ? t('update.updatesAvailable', '{count} updates available').replace(
          '{count}',
          String(items.length),
        )
      : selectedOffer
        ? language === 'zh'
          ? `${selectedOffer.name} 有新版本`
          : `${selectedOffer.name} update available`
        : t('update.toastTitle', 'YOLO update available')

  // Module-only card: the button installs them all, and reports on whichever
  // is being worked on.
  const moduleOffersShown = moduleItems.map((item) => item.moduleOffer!)
  const downloadingOffer = moduleOffersShown.find(
    (offer) => offer.status === 'downloading',
  )
  const moduleBusy = moduleOffersShown.some(
    (offer) => offer.status === 'downloading' || offer.status === 'applying',
  )
  const modulesDone = moduleOffersShown.every(
    (offer) => offer.status === 'success',
  )
  const moduleCtaLabel = downloadingOffer
    ? t('update.downloading', 'Downloading {{progress}}%').replace(
        '{{progress}}',
        String(Math.round(downloadingOffer.progress)),
      )
    : moduleBusy
      ? t('update.applying', 'Installing…')
      : modulesDone
        ? t('update.updated', 'Updated')
        : moduleOffersShown.some((offer) => offer.status === 'error')
          ? t('common.retry', 'Retry')
          : moduleOffersShown.length > 1
            ? t('update.updateAll', 'Update all')
            : t('update.goUpdate', 'Update')
  const cta = coreUpdate
    ? primaryCta
    : {
        label: moduleCtaLabel,
        disabled: moduleBusy || modulesDone,
        onClick: () => void plugin.applyAllModuleUpdates(),
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
    <FloatingToast
      className={`yolo-update-toast${exiting ? ' yolo-update-toast--exiting' : ''}`}
      exiting={exiting}
    >
      <div className="yolo-update-toast-header">
        <div className="yolo-update-toast-heading">
          <div className="yolo-update-toast-titlerow">
            <span className="yolo-update-toast-title">{title}</span>
            {items.length === 1 ? (
              <span className="yolo-update-toast-version">
                {selected.version}
              </span>
            ) : null}
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
              if (selectedOffer) void plugin.muteModuleUpdate(selectedOffer.key)
              else muteUpdateVersion(selected.version)
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

      {items.length > 1 ? (
        <div className="yolo-update-toast-tabs" role="tablist">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={item.key === selected.key}
              className={`yolo-update-toast-tab${item.key === selected.key ? ' is-active' : ''}`}
              onClick={() => setSelectedKey(item.key)}
            >
              <span className="yolo-update-toast-tab-name">{item.name}</span>
              <span className="yolo-update-toast-tab-version">
                {item.version}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="yolo-update-toast-divider" />

      <div className="yolo-update-toast-body">
        {selectedOffer?.status === 'success' ? (
          <div className="yolo-update-toast-success">
            {language === 'zh'
              ? `✓ ${selectedOffer.name} 已更新到 ${selectedOffer.latestVersion}`
              : `✓ ${selectedOffer.name} updated to ${selectedOffer.latestVersion}`}
          </div>
        ) : (
          <UpdateChangelogSections sections={sections} separator={separator} />
        )}
      </div>

      {!coreUpdate && downloadingOffer ? (
        <div className="yolo-update-toast-progress" aria-hidden="true">
          <div
            className="yolo-update-toast-progress-fill"
            style={{
              transform: `scaleX(${downloadingOffer.progress / 100})`,
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
                selectedOffer
                  ? { kind: 'module', key: selectedOffer.key }
                  : undefined,
              ).open()
            }}
          >
            {t('update.viewHistory', 'View release history')}
          </button>
        </div>
        <div className="yolo-update-toast-footer-actions">
          {coreUpdate && showCommunityPluginsFallback && hasSelfUpdate ? (
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
            className={`yolo-update-toast-cta${cta.disabled ? ' is-disabled' : ''}`}
            title={cta.label}
            disabled={cta.disabled}
            onClick={cta.onClick}
          >
            {cta.label}
          </button>
        </div>
      </div>
      {coreUpdate && isSelfUpdateError && releaseUrl ? (
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
