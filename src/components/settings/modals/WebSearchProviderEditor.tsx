import { App, Notice } from '../../../runtime/react-compat'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import {
  type WebSearchProviderOptions,
  webSearchProviderOptionsSchema,
} from '../../../core/web-search'
import SmartComposerPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'

type FormProps = {
  app: App
  plugin: SmartComposerPlugin
  draft?: WebSearchProviderOptions // when adding a new provider
  editId?: string // when editing an existing provider
}

export class WebSearchProviderNewModal extends ReactModal<FormProps> {
  constructor(
    app: App,
    plugin: SmartComposerPlugin,
    draft: WebSearchProviderOptions,
  ) {
    super({
      app,
      Component: Wrapper,
      props: { app, plugin, draft },
      options: {
        title: plugin.t('settings.webSearch.addProvider', 'Add provider'),
      },
      plugin,
    })
  }
}

export class WebSearchProviderEditModal extends ReactModal<FormProps> {
  constructor(app: App, plugin: SmartComposerPlugin, editId: string) {
    super({
      app,
      Component: Wrapper,
      props: { app, plugin, editId },
      options: {
        title: plugin.t('settings.webSearch.editProvider', 'Edit provider'),
      },
      plugin,
    })
  }
}

function Wrapper({
  app,
  plugin,
  draft,
  editId,
  onClose,
}: FormProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(s) => plugin.setSettings(s)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <Form
        app={app}
        plugin={plugin}
        draft={draft}
        editId={editId}
        onClose={onClose}
      />
    </SettingsProvider>
  )
}

function Form({ draft, editId, onClose }: FormProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()

  const initial = useMemo<WebSearchProviderOptions>(() => {
    if (draft) return draft
    const existing = settings.webSearch.providers.find((p) => p.id === editId)
    if (!existing) {
      throw new Error(`Web search provider not found: ${editId}`)
    }
    return existing
  }, [draft, editId, settings.webSearch.providers])

  const [form, setForm] = useState<WebSearchProviderOptions>(initial)

  // The discriminated union narrows down per-branch at the callsite.
  const update = (key: string, value: unknown) => {
    setForm(
      (prev) =>
        ({
          ...(prev as Record<string, unknown>),
          [key]: value,
        }) as WebSearchProviderOptions,
    )
  }

  const handleSave = async () => {
    const parsed = webSearchProviderOptionsSchema.safeParse(form)
    if (!parsed.success) {
      new Notice(parsed.error.issues.map((i) => i.message).join('\n'))
      return
    }
    const validated = parsed.data
    const isNew =
      !!draft &&
      !settings.webSearch.providers.some((p) => p.id === validated.id)
    const nextProviders = isNew
      ? [...settings.webSearch.providers, validated]
      : settings.webSearch.providers.map((p) =>
          p.id === validated.id ? validated : p,
        )
    const nextDefault =
      settings.webSearch.defaultProviderId ?? (isNew ? validated.id : undefined)
    await setSettings({
      ...settings,
      webSearch: {
        ...settings.webSearch,
        providers: nextProviders,
        defaultProviderId: nextDefault,
      },
    })
    onClose()
  }

  return (
    <div className="smtcmp-ws-edit-form">
      {form.type === 'tavily' && (
        <>
          <ApiKeyField
            value={form.apiKey}
            onChange={(value) => update('apiKey', value)}
          />
          <ObsidianSetting name={t('settings.webSearch.fieldDepth', 'Depth')}>
            <ObsidianDropdown
              value={form.depth}
              options={{ basic: 'basic', advanced: 'advanced' }}
              onChange={(value) => update('depth', value)}
            />
          </ObsidianSetting>
        </>
      )}

      {form.type === 'jina' && (
        <>
          <ApiKeyField
            value={form.apiKey}
            onChange={(value) => update('apiKey', value)}
          />
          <ObsidianSetting
            name={t('settings.webSearch.fieldSearchUrl', 'Search URL')}
          >
            <ObsidianTextInput
              value={form.searchUrl}
              onChange={(value) => update('searchUrl', value)}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.webSearch.fieldScrapeUrl', 'Scrape URL')}
          >
            <ObsidianTextInput
              value={form.scrapeUrl}
              onChange={(value) => update('scrapeUrl', value)}
            />
          </ObsidianSetting>
        </>
      )}

      {form.type === 'searxng' && (
        <>
          <ObsidianSetting
            name={t('settings.webSearch.fieldBaseUrl', 'Base URL')}
            required
          >
            <ObsidianTextInput
              value={form.baseUrl}
              placeholder="https://searxng.example.com"
              onChange={(value) => update('baseUrl', value)}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.webSearch.fieldLanguage', 'Language')}
          >
            <ObsidianTextInput
              value={form.language}
              placeholder="auto"
              onChange={(value) => update('language', value)}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t(
              'settings.webSearch.fieldEngines',
              'Engines (comma-separated)',
            )}
          >
            <ObsidianTextInput
              value={form.engines.join(',')}
              placeholder="google,bing,duckduckgo"
              onChange={(value) =>
                update(
                  'engines',
                  value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.webSearch.fieldUsername', 'Basic auth username')}
          >
            <ObsidianTextInput
              value={form.username}
              onChange={(value) => update('username', value)}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.webSearch.fieldPassword', 'Basic auth password')}
          >
            <ObsidianTextInput
              value={form.password}
              onChange={(value) => update('password', value)}
            />
          </ObsidianSetting>
        </>
      )}

      {form.type === 'bing' && (
        <div className="smtcmp-settings-desc">
          {t(
            'settings.webSearch.bingNote',
            'Bing requires no API key. The provider scrapes the public results page; reliability depends on Bing\u2019s anti-bot measures.',
          )}
        </div>
      )}

      {form.type === 'gemini-grounding' && (
        <>
          <ApiKeyField
            value={form.apiKey}
            onChange={(value) => update('apiKey', value)}
          />
          <ObsidianSetting name={t('settings.webSearch.fieldModel', 'Model')}>
            <ObsidianTextInput
              value={form.model}
              onChange={(value) => update('model', value)}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.webSearch.fieldBaseUrl', 'Base URL')}
          >
            <ObsidianTextInput
              value={form.baseUrl}
              onChange={(value) => update('baseUrl', value)}
            />
          </ObsidianSetting>
          <SystemPromptField
            value={form.systemPrompt}
            onChange={(value) => update('systemPrompt', value)}
          />
        </>
      )}

      {form.type === 'grok' && (
        <>
          <ApiKeyField
            value={form.apiKey}
            onChange={(value) => update('apiKey', value)}
          />
          <ObsidianSetting name={t('settings.webSearch.fieldModel', 'Model')}>
            <ObsidianTextInput
              value={form.model}
              onChange={(value) => update('model', value)}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.webSearch.fieldBaseUrl', 'Base URL')}
          >
            <ObsidianTextInput
              value={form.baseUrl}
              onChange={(value) => update('baseUrl', value)}
            />
          </ObsidianSetting>
          <SystemPromptField
            value={form.systemPrompt}
            onChange={(value) => update('systemPrompt', value)}
          />
          <ObsidianSetting
            name={t('settings.webSearch.fieldEnableX', 'Also search X')}
          >
            <ObsidianToggle
              value={form.enableX}
              onChange={(value) => update('enableX', value)}
            />
          </ObsidianSetting>
        </>
      )}

      {form.type === 'zhipu' && (
        <>
          <ApiKeyField
            value={form.apiKey}
            onChange={(value) => update('apiKey', value)}
          />
          <ObsidianSetting
            name={t('settings.webSearch.fieldZhipuEngine', 'Search engine')}
          >
            <ObsidianDropdown
              value={form.searchEngine}
              options={{
                search_std: 'search_std',
                search_pro: 'search_pro',
                search_pro_sogou: 'search_pro_sogou',
                search_pro_quark: 'search_pro_quark',
              }}
              onChange={(value) => update('searchEngine', value)}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.webSearch.fieldZhipuContentSize', 'Content size')}
          >
            <ObsidianDropdown
              value={form.contentSize}
              options={{ medium: 'medium', high: 'high' }}
              onChange={(value) => update('contentSize', value)}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.webSearch.fieldZhipuRecency', 'Recency filter')}
          >
            <ObsidianDropdown
              value={form.searchRecencyFilter}
              options={{
                noLimit: 'noLimit',
                oneDay: 'oneDay',
                oneWeek: 'oneWeek',
                oneMonth: 'oneMonth',
                oneYear: 'oneYear',
              }}
              onChange={(value) => update('searchRecencyFilter', value)}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t(
              'settings.webSearch.fieldZhipuDomainFilter',
              'Domain filter (optional)',
            )}
          >
            <ObsidianTextInput
              value={form.searchDomainFilter}
              placeholder="example.com"
              onChange={(value) => update('searchDomainFilter', value)}
            />
          </ObsidianSetting>
        </>
      )}

      <ObsidianSetting>
        <ObsidianButton
          text={t('common.save', 'Save')}
          cta
          onClick={() => void handleSave()}
        />
        <ObsidianButton text={t('common.cancel', 'Cancel')} onClick={onClose} />
      </ObsidianSetting>
    </div>
  )
}

function ApiKeyField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useLanguage()
  return (
    <ObsidianSetting
      name={t('settings.webSearch.fieldApiKey', 'API key')}
      required
    >
      <ObsidianTextInput value={value} onChange={onChange} />
    </ObsidianSetting>
  )
}

function SystemPromptField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useLanguage()
  return (
    <>
      <ObsidianSetting
        name={t('settings.webSearch.fieldSystemPrompt', 'System prompt')}
        className="smtcmp-settings-textarea-header"
      />
      <ObsidianSetting className="smtcmp-settings-textarea">
        <ObsidianTextArea
          value={value}
          onChange={onChange}
          autoResize
          maxAutoResizeHeight={360}
          inputClassName="smtcmp-ws-system-prompt-textarea"
        />
      </ObsidianSetting>
    </>
  )
}
