import { Edit, Trash2 } from 'lucide-react'
import { App, Notice } from 'obsidian'
import { useMemo, useState } from 'react'
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
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
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

  const handleSetDefault = async (id: string) => {
    await updateWebSearch({ defaultProviderId: id })
  }

  const providerTypeOptions = useMemo(() => {
    const out: Record<string, string> = {}
    WEB_SEARCH_PROVIDER_TYPES.forEach((type) => {
      out[type] = t(`settings.webSearch.types.${type}`, defaultTypeLabel(type))
    })
    return out
  }, [t])

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-desc smtcmp-settings-callout">
        {t(
          'settings.webSearch.intro',
          'Configure search providers used by the built-in web_search agent tool. The default provider below is used when the agent invokes web_search.',
        )}
      </div>

      <div className="smtcmp-settings-sub-header-container">
        <div className="smtcmp-settings-sub-header">
          {t('settings.webSearch.providersHeader', 'Providers')}
        </div>
        <AddProviderControl
          options={providerTypeOptions}
          onAdd={handleAddProvider}
          buttonText={t('settings.webSearch.addProvider', 'Add provider')}
        />
      </div>

      {webSearch.providers.length === 0 ? (
        <div className="smtcmp-mcp-servers-empty">
          {t(
            'settings.webSearch.empty',
            'No providers configured yet. Add one to enable the web_search tool.',
          )}
        </div>
      ) : (
        <div className="smtcmp-mcp-servers-container">
          <div className="smtcmp-web-search-row smtcmp-web-search-header">
            <div>{t('settings.webSearch.colName', 'Name')}</div>
            <div>{t('settings.webSearch.colType', 'Type')}</div>
            <div>{t('settings.webSearch.colDefault', 'Default')}</div>
            <div>{t('settings.webSearch.colActions', 'Actions')}</div>
          </div>
          {webSearch.providers.map((provider) => (
            <div className="smtcmp-web-search-row" key={provider.id}>
              <div className="smtcmp-mcp-server-name">{provider.name}</div>
              <div>
                {t(
                  `settings.webSearch.types.${provider.type}`,
                  defaultTypeLabel(provider.type),
                )}
              </div>
              <div>
                <input
                  type="radio"
                  checked={webSearch.defaultProviderId === provider.id}
                  onChange={() => void handleSetDefault(provider.id)}
                  aria-label={t('settings.webSearch.colDefault', 'Default')}
                />
              </div>
              <div className="smtcmp-mcp-server-actions">
                <button
                  type="button"
                  className="clickable-icon"
                  aria-label={t('common.edit', 'Edit')}
                  onClick={() =>
                    new WebSearchProviderEditModal(
                      app,
                      plugin,
                      provider.id,
                    ).open()
                  }
                >
                  <Edit size={16} />
                </button>
                <button
                  type="button"
                  className="clickable-icon"
                  aria-label={t('common.delete', 'Delete')}
                  onClick={() => handleDelete(provider)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="smtcmp-settings-sub-header-container">
        <div className="smtcmp-settings-sub-header">
          {t('settings.webSearch.commonHeader', 'Common')}
        </div>
      </div>

      <ObsidianSetting
        name={t('settings.webSearch.resultSize', 'Result size')}
        desc={t(
          'settings.webSearch.resultSizeDesc',
          'Maximum number of results returned to the model per search.',
        )}
      >
        <ObsidianTextInput
          type="number"
          value={String(webSearch.common.resultSize)}
          onChange={(value) => {
            const next = Math.max(1, Math.min(50, Number(value) || 0))
            void updateWebSearch({
              common: { ...webSearch.common, resultSize: next },
            })
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.webSearch.searchTimeout', 'Search timeout (ms)')}
      >
        <ObsidianTextInput
          type="number"
          value={String(webSearch.common.searchTimeoutMs)}
          onChange={(value) => {
            const next = Math.max(1000, Math.min(120000, Number(value) || 0))
            void updateWebSearch({
              common: { ...webSearch.common, searchTimeoutMs: next },
            })
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.webSearch.scrapeTimeout', 'Scrape timeout (ms)')}
      >
        <ObsidianTextInput
          type="number"
          value={String(webSearch.common.scrapeTimeoutMs)}
          onChange={(value) => {
            const next = Math.max(1000, Math.min(120000, Number(value) || 0))
            void updateWebSearch({
              common: { ...webSearch.common, scrapeTimeoutMs: next },
            })
          }}
        />
      </ObsidianSetting>
    </div>
  )
}

function AddProviderControl({
  options,
  buttonText,
  onAdd,
}: {
  options: Record<string, string>
  buttonText: string
  onAdd: (type: WebSearchProviderType) => void
}) {
  const [picked, setPicked] = useState<WebSearchProviderType>(
    WEB_SEARCH_PROVIDER_TYPES[0],
  )
  return (
    <div className="smtcmp-web-search-add">
      <ObsidianDropdown
        value={picked}
        options={options}
        onChange={(value) => setPicked(value as WebSearchProviderType)}
      />
      <ObsidianButton text={buttonText} onClick={() => onAdd(picked)} />
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
