import { ChevronDown, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { LanguageProvider, useLanguage } from '../contexts/language-context'
import { PluginProvider, usePlugin } from '../contexts/plugin-context'
import {
  type ReleaseNotesByLanguage,
  parseChangelog,
} from '../core/update/updateChecker'
import { useUpdateCheck } from '../hooks/useUpdateCheck'
import type YoloPlugin from '../main'

type ReleaseLanguage = 'en' | 'zh'

function resolveDefaultLanguage(
  notes: ReleaseNotesByLanguage,
  uiLanguage: string,
): ReleaseLanguage {
  const preferred: ReleaseLanguage = uiLanguage === 'zh' ? 'zh' : 'en'
  if (notes[preferred]) return preferred
  return notes.en ? 'en' : 'zh'
}

// Renders a body string, turning `inline code` spans into styled <code>.
function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <>
      {parts.map((part, index) =>
        part.length > 1 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={index} className="yolo-update-toast-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  )
}

function UpdateToast() {
  const { language, t } = useLanguage()
  const { app } = usePlugin()
  const { result, muteVersion } = useUpdateCheck()

  const [expanded, setExpanded] = useState(false)
  const [exiting, setExiting] = useState(false)
  const [lang, setLang] = useState<ReleaseLanguage>('en')

  // Reset transient view state whenever a different version surfaces.
  const latestVersion = result?.latestVersion ?? null
  useEffect(() => {
    if (result) {
      setExpanded(false)
      setExiting(false)
      setLang(resolveDefaultLanguage(result.releaseNotes, language))
    }
  }, [latestVersion, language, result])

  // Closing plays the exit animation first, then actually mutes (which unmounts
  // the card). Timer-driven rather than onAnimationEnd so it still fires under
  // prefers-reduced-motion (where the animation is disabled). Keep in sync with
  // the 160ms exit duration in input.css.
  useEffect(() => {
    if (!exiting || !result) return
    const id = window.setTimeout(() => muteVersion(result.latestVersion), 160)
    return () => window.clearTimeout(id)
  }, [exiting, result, muteVersion])

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

  if (!result?.hasUpdate || !releaseNotes) {
    return null
  }

  const hasBilingual = Boolean(releaseNotes.en && releaseNotes.zh)
  const separator = lang === 'zh' ? '：' : ': '

  // Closing the toast mutes this version: the user has acknowledged it, so we
  // don't surface it again until a higher version ships (persisted via
  // muteVersion). There is no in-session "minimize" state.
  const muteLabel = t('update.muteThisVersion', "Don't notify for this version")

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
      className={`yolo-update-toast${expanded ? ' yolo-update-toast--expanded' : ''}${exiting ? ' yolo-update-toast--exiting' : ''}`}
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
          aria-label={muteLabel}
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div className="yolo-update-toast-divider" />

      <div
        className={`yolo-update-toast-body${expanded ? ' is-expanded' : ''}`}
      >
        <div className="yolo-update-toast-sections">
          {sections.map((section, si) => (
            <div className="yolo-update-toast-section" key={si}>
              {section.name ? (
                <div className="yolo-update-toast-section-head">
                  <span
                    className={`yolo-update-toast-dot yolo-update-toast-dot--${section.tone}`}
                    aria-hidden
                  />
                  <span>{section.name}</span>
                </div>
              ) : null}
              <ul className="yolo-update-toast-items">
                {section.items.map((item, ii) => (
                  <li className="yolo-update-toast-item" key={ii}>
                    <span className="yolo-update-toast-bullet" aria-hidden>
                      —
                    </span>
                    <span className="yolo-update-toast-item-text">
                      {item.title ? (
                        <span className="yolo-update-toast-item-title">
                          {item.title}
                        </span>
                      ) : null}
                      {item.ref ? (
                        <span className="yolo-update-toast-item-ref">
                          {item.ref}
                        </span>
                      ) : null}
                      {item.title && item.body ? (
                        <span>{separator}</span>
                      ) : null}
                      <InlineText text={item.body} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {!expanded ? (
          <div className="yolo-update-toast-fade" aria-hidden />
        ) : null}
      </div>

      <div className="yolo-update-toast-footer">
        <button
          type="button"
          className="yolo-update-toast-expand"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded
            ? t('update.collapse', 'Collapse')
            : t('update.showFullChangelog', 'Show full changelog')}
          <ChevronDown
            className={`yolo-update-toast-expand-chevron${expanded ? ' is-up' : ''}`}
            size={13}
            strokeWidth={2.2}
          />
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
            // Routing the user to the update flow is a strong "handled this
            // version" signal — dismiss it (animate out, then mute), same as ✕.
            setExiting(true)
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
