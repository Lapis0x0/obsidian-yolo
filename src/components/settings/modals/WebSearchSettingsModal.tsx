import { Edit, Info, Plus, Trash2 } from 'lucide-react'
import { App, Menu, Notice } from 'obsidian'
import { useMemo, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import {
  WEB_SEARCH_PROVIDER_TYPES,
  type WebSearchProviderOptions,
  type WebSearchProviderType,
  type WebSearchSettings,
  createDefaultProviderOptions,
} from '../../../core/web-search'
import SmartComposerPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'
import { ConfirmModal } from '../../modals/ConfirmModal'

import {
  WebSearchProviderEditModal,
  WebSearchProviderNewModal,
} from './WebSearchProviderEditor'

type WebSearchSettingsModalProps = {
  app: App
  plugin: SmartComposerPlugin
}

export class WebSearchSettingsModal extends ReactModal<WebSearchSettingsModalProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app,
      Component: Wrapper,
      props: { app, plugin },
      options: {
        title: plugin.t('settings.webSearch.modalTitle', 'Web search settings'),
      },
      plugin,
    })
    this.modalEl.classList.add('smtcmp-modal--wide')
  }
}

function Wrapper({
  app,
  plugin,
  onClose: _onClose,
}: WebSearchSettingsModalProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(s) => plugin.setSettings(s)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <Content app={app} plugin={plugin} />
    </SettingsProvider>
  )
}

const PROVIDER_MONO: Record<WebSearchProviderType, string> = {
  tavily: 'T',
  jina: 'J',
  searxng: 'S',
  bing: 'B',
  'gemini-grounding': 'G',
  grok: 'X',
}

function Content({ app, plugin }: { app: App; plugin: SmartComposerPlugin }) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const webSearch = settings.webSearch

  const updateWebSearch = async (next: Partial<WebSearchSettings>) => {
    await setSettings({
      ...settings,
      webSearch: { ...webSearch, ...next },
    })
  }

  const handleAddProvider = (type: WebSearchProviderType) => {
    const id = uuidv4()
    const draft = createDefaultProviderOptions(type, id)
    new WebSearchProviderNewModal(app, plugin, draft).open()
  }

  const handleDelete = (provider: WebSearchProviderOptions) => {
    new ConfirmModal(app, {
      title: t('settings.webSearch.deleteConfirmTitle', 'Delete provider'),
      message: t(
        'settings.webSearch.deleteConfirmMessage',
        'Are you sure you want to delete this web search provider?',
      ),
      ctaText: t('common.delete', 'Delete'),
      onConfirm: () => {
        const remaining = webSearch.providers.filter(
          (p) => p.id !== provider.id,
        )
        const nextDefault =
          webSearch.defaultProviderId === provider.id
            ? remaining[0]?.id
            : webSearch.defaultProviderId
        void updateWebSearch({
          providers: remaining,
          defaultProviderId: nextDefault,
        }).catch((err) => {
          console.error('Failed to delete web search provider', err)
          new Notice(
            t('settings.webSearch.deleteFailed', 'Failed to delete provider.'),
          )
        })
      },
    }).open()
  }

  const handleSetDefault = (id: string) => {
    if (webSearch.defaultProviderId === id) return
    void updateWebSearch({ defaultProviderId: id })
  }

  const typeLabels = useMemo(() => {
    const out: Record<WebSearchProviderType, string> = {} as Record<
      WebSearchProviderType,
      string
    >
    WEB_SEARCH_PROVIDER_TYPES.forEach((type) => {
      out[type] = t(`settings.webSearch.types.${type}`, defaultTypeLabel(type))
    })
    return out
  }, [t])

  const addBtnRef = useRef<HTMLButtonElement | null>(null)
  const handleOpenAddMenu = () => {
    const menu = new Menu()
    WEB_SEARCH_PROVIDER_TYPES.forEach((type) => {
      menu.addItem((item) =>
        item.setTitle(typeLabels[type]).onClick(() => handleAddProvider(type)),
      )
    })
    const rect = addBtnRef.current?.getBoundingClientRect()
    if (rect) {
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 })
    } else {
      menu.showAtMouseEvent(
        new MouseEvent('click', {
          clientX: window.innerWidth / 2,
          clientY: window.innerHeight / 2,
        }),
      )
    }
  }

  return (
    <div className="smtcmp-ws">
      <div className="smtcmp-ws-intro">
        {t(
          'settings.webSearch.intro',
          'Configure search providers used by the built-in web_search agent tool. The default provider below is used when the agent invokes web_search.',
        )}
      </div>

      <div className="smtcmp-ws-section">
        <div className="smtcmp-ws-section-head">
          <div className="smtcmp-ws-section-label">
            {t('settings.webSearch.providersHeader', 'Providers')}
          </div>
          <button
            ref={addBtnRef}
            type="button"
            className="smtcmp-ws-add-btn"
            onClick={handleOpenAddMenu}
          >
            <Plus size={12} />
            {t('settings.webSearch.addProvider', 'Add')}
          </button>
        </div>

        {webSearch.providers.length === 0 ? (
          <div className="smtcmp-ws-empty">
            {t(
              'settings.webSearch.empty',
              'No providers configured yet. Add one to enable the web_search tool.',
            )}
          </div>
        ) : (
          <div className="smtcmp-ws-providers">
            {webSearch.providers.map((provider) => {
              const isDefault = webSearch.defaultProviderId === provider.id
              return (
                <div
                  key={provider.id}
                  className={
                    'smtcmp-ws-provider-row' + (isDefault ? ' is-default' : '')
                  }
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSetDefault(provider.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleSetDefault(provider.id)
                    }
                  }}
                >
                  <span className="smtcmp-ws-radio" aria-hidden="true">
                    {isDefault && <span className="smtcmp-ws-radio-dot" />}
                  </span>
                  <div className="smtcmp-ws-provider-main">
                    <span
                      className={`smtcmp-ws-monogram smtcmp-ws-monogram--${provider.type}`}
                      aria-hidden="true"
                    >
                      {PROVIDER_MONO[provider.type]}
                    </span>
                    <div className="smtcmp-ws-provider-name-row">
                      <span className="smtcmp-ws-provider-name">
                        {provider.name}
                      </span>
                      {isDefault && (
                        <span className="smtcmp-ws-tag smtcmp-ws-tag--default">
                          {t('settings.webSearch.tagDefault', 'Default')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className="smtcmp-ws-provider-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="smtcmp-ws-icon-btn"
                      aria-label={t('common.edit', 'Edit')}
                      onClick={() =>
                        new WebSearchProviderEditModal(
                          app,
                          plugin,
                          provider.id,
                        ).open()
                      }
                    >
                      <Edit size={14} />
                    </button>
                    <button
                      type="button"
                      className="smtcmp-ws-icon-btn"
                      aria-label={t('common.delete', 'Delete')}
                      onClick={() => handleDelete(provider)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="smtcmp-ws-section">
        <div className="smtcmp-ws-section-head">
          <div className="smtcmp-ws-section-label">
            {t('settings.webSearch.commonHeader', 'Common')}
          </div>
        </div>

        <NumberFieldRow
          label={t('settings.webSearch.resultSize', 'Result size')}
          hint={t(
            'settings.webSearch.resultSizeDesc',
            'Maximum number of results returned to the model per search.',
          )}
          value={webSearch.common.resultSize}
          unit={t('settings.webSearch.unitResults', 'items')}
          min={1}
          max={50}
          onChange={(next) =>
            void updateWebSearch({
              common: { ...webSearch.common, resultSize: next },
            })
          }
        />
        <NumberFieldRow
          label={t('settings.webSearch.searchTimeoutLabel', 'Search timeout')}
          hint={t(
            'settings.webSearch.searchTimeoutDesc',
            'Maximum wait time for a provider search call.',
          )}
          value={webSearch.common.searchTimeoutMs}
          unit="ms"
          min={1000}
          max={120000}
          onChange={(next) =>
            void updateWebSearch({
              common: { ...webSearch.common, searchTimeoutMs: next },
            })
          }
        />
        <NumberFieldRow
          label={t('settings.webSearch.scrapeTimeoutLabel', 'Scrape timeout')}
          hint={t(
            'settings.webSearch.scrapeTimeoutDesc',
            'Maximum wait time for a single web_scrape call.',
          )}
          value={webSearch.common.scrapeTimeoutMs}
          unit="ms"
          min={1000}
          max={120000}
          onChange={(next) =>
            void updateWebSearch({
              common: { ...webSearch.common, scrapeTimeoutMs: next },
            })
          }
        />

        <div className="smtcmp-ws-info">
          <Info size={14} className="smtcmp-ws-info-icon" />
          <div>
            {t(
              'settings.webSearch.failoverNotice',
              'When a call fails the plugin does not silently fall back to another provider. The error is surfaced to the model so the agent can decide whether to retry or switch strategy.',
            )}
          </div>
        </div>
      </div>

      <div className="smtcmp-ws-footnote">
        {t('settings.webSearch.providerCount', 'Total providers')}:{' '}
        {webSearch.providers.length}
      </div>
    </div>
  )
}

function NumberFieldRow({
  label,
  hint,
  value,
  unit,
  min,
  max,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  unit?: string
  min: number
  max: number
  onChange: (next: number) => void
}) {
  return (
    <div className="smtcmp-ws-field-row">
      <div>
        <div className="smtcmp-ws-field-label">{label}</div>
        {hint && <div className="smtcmp-ws-field-hint">{hint}</div>}
      </div>
      <div className="smtcmp-ws-number">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const parsed = Number(e.target.value)
            if (!Number.isFinite(parsed)) return
            const clamped = Math.max(min, Math.min(max, Math.round(parsed)))
            onChange(clamped)
          }}
        />
        {unit && <span className="smtcmp-ws-number-unit">{unit}</span>}
      </div>
    </div>
  )
}

function defaultTypeLabel(type: WebSearchProviderType): string {
  switch (type) {
    case 'tavily':
      return 'Tavily'
    case 'jina':
      return 'Jina'
    case 'searxng':
      return 'SearXNG'
    case 'bing':
      return 'Bing (no key)'
    case 'gemini-grounding':
      return 'Gemini (Grounding)'
    case 'grok':
      return 'Grok'
  }
}
