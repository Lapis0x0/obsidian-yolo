import { App, Notice } from 'obsidian'
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
import { ObsidianSetting } from '../../common/ObsidianSetting'
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

  // Updates one field of the form. We type the value loosely on purpose:
  // the discriminated union narrows down per-branch, so the callsite is the
  // one that already knows the right field/value pair for `form.type`.
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
    <>
      <ObsidianSetting
        name={t('settings.webSearch.fieldName', 'Display name')}
        required
      >
        <ObsidianTextInput
          value={form.name}
          onChange={(value) => update('name', value)}
        />
      </ObsidianSetting>

      {form.type === 'tavily' && (
        <>
          <ApiKeyField
            value={form.apiKey}
            onChange={(value) => update('apiKey', value)}
          />
          <ObsidianSetting name={t('settings.webSearch.fieldDepth', 'Depth')}>
            <select
              className="dropdown"
              value={form.depth}
              onChange={(e) =>
                update('depth', e.target.value as 'basic' | 'advanced')
              }
            >
              <option value="basic">basic</option>
              <option value="advanced">advanced</option>
            </select>
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
            'Bing requires no API key. The provider scrapes the public results page; reliability depends on Bing’s anti-bot measures.',
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
          <ObsidianSetting
            name={t('settings.webSearch.fieldSystemPrompt', 'System prompt')}
          >
            <ObsidianTextInput
              value={form.systemPrompt}
              onChange={(value) => update('systemPrompt', value)}
            />
          </ObsidianSetting>
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

      <ObsidianSetting>
        <ObsidianButton
          text={t('common.save', 'Save')}
          cta
          onClick={() => void handleSave()}
        />
        <ObsidianButton text={t('common.cancel', 'Cancel')} onClick={onClose} />
      </ObsidianSetting>
    </>
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
