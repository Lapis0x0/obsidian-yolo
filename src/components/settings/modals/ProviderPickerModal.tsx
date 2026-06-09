import { Search } from 'lucide-react'
import { App } from 'obsidian'
import { useMemo, useState } from 'react'

import { PROVIDER_PRESET_INFO } from '../../../constants'
import {
  PROVIDER_CATALOG,
  PROVIDER_PICKER_CATEGORIES,
  PROVIDER_PICKER_ORDER,
  ProviderCatalogEntry,
  ProviderPickerCategory,
} from '../../../constants/provider-catalog'
import { useLanguage } from '../../../contexts/language-context'
import YoloPlugin from '../../../main'
import {
  LLMProviderPresetType,
  getDefaultApiTypeForPresetType,
} from '../../../types/provider.types'
import { ReactModal } from '../../common/ReactModal'
import { AddProviderModal } from './ProviderFormModal'

type ProviderPickerProps = {
  app: App
  plugin: YoloPlugin
}

type CategoryId = 'all' | ProviderPickerCategory

export class ProviderPickerModal extends ReactModal<ProviderPickerProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: ProviderPickerComponent,
      props: { app, plugin },
      options: {
        title: plugin.t('settings.providers.pickerTitle', 'Add provider'),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-provider-picker-modal')
  }
}

function ProviderPickerComponent({
  app,
  plugin,
  onClose,
}: ProviderPickerProps & { onClose: () => void }) {
  const { t } = useLanguage()

  // `draft` is what the user is typing; `query` is what actually drives
  // filtering. We only commit draft → query on Enter (or when the field is
  // cleared back to empty) so the grid does not reflow on every keystroke,
  // which is jarring because the modal height is content-sized.
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryId>('all')

  // Which presets the user has already configured at least one instance of.
  // Surfaced as an "已添加" badge to gently discourage duplicates without
  // blocking them — duplicate provider instances are legitimate (different
  // base URLs / keys for the same brand).
  //
  // We read `plugin.settings` directly rather than `useSettings()` because the
  // ReactModal host only wires PluginProvider + LanguageProvider, not the
  // settings context. The picker is short-lived; recomputing once on mount
  // is the right scope.
  const addedPresets = useMemo(() => {
    const presets = new Set<LLMProviderPresetType>()
    for (const provider of plugin.settings.providers) {
      presets.add(provider.presetType)
    }
    return presets
  }, [plugin])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return PROVIDER_PICKER_ORDER.filter((presetType) => {
      const catalog = PROVIDER_CATALOG[presetType]
      if (category !== 'all' && catalog.category !== category) return false
      if (!normalized) return true
      const info = PROVIDER_PRESET_INFO[presetType]
      const haystack = [info.label, presetType, catalog.monogram]
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalized)
    })
  }, [query, category])

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryId, number> = {
      all: PROVIDER_PICKER_ORDER.length,
      main: 0,
      cn: 0,
      gw: 0,
      cloud: 0,
      local: 0,
    }
    for (const presetType of PROVIDER_PICKER_ORDER) {
      counts[PROVIDER_CATALOG[presetType].category] += 1
    }
    return counts
  }, [])

  const customLabel = t(
    'settings.providers.pickerCustomLabel',
    'Custom provider',
  )
  const customSecondary = 'custom · OpenAI compatible'

  const customMatchesQuery = (() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return true
    if (category !== 'all') return false
    return (
      customLabel.toLowerCase().includes(normalized) ||
      customSecondary.toLowerCase().includes(normalized) ||
      'openai-compatible openai compatible'.includes(normalized)
    )
  })()

  const openProvider = (presetType: LLMProviderPresetType) => {
    onClose()
    new AddProviderModal(app, plugin, presetType).open()
  }

  return (
    <div className="yolo-provider-picker">
      <div className="yolo-provider-picker__toolbar">
        <div className="yolo-provider-picker__search">
          <Search
            aria-hidden
            className="yolo-provider-picker__search-icon"
            size={14}
            strokeWidth={2}
          />
          <input
            type="text"
            autoFocus
            value={draft}
            onChange={(event) => {
              const next = event.target.value
              setDraft(next)
              if (next === '') setQuery('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                setQuery(draft)
              }
            }}
            placeholder={t(
              'settings.providers.pickerSearchPlaceholder',
              'Search providers · press Enter',
            )}
            className="yolo-provider-picker__search-input"
          />
        </div>
        <div className="yolo-provider-picker__count">
          {filtered.length + (customMatchesQuery ? 1 : 0)} /{' '}
          {PROVIDER_PICKER_ORDER.length + 1}
        </div>
      </div>

      <div className="yolo-provider-picker__chips">
        {PROVIDER_PICKER_CATEGORIES.map((c) => {
          const on = category === c.id
          return (
            <button
              key={c.id}
              type="button"
              className={`yolo-provider-picker__chip${
                on ? ' yolo-provider-picker__chip--on' : ''
              }`}
              onClick={() => setCategory(c.id)}
            >
              <span>{t(`settings.providers.${c.labelKey}`, c.fallback)}</span>
              <span className="yolo-provider-picker__chip-count">
                {categoryCounts[c.id]}
              </span>
            </button>
          )
        })}
      </div>

      <div className="yolo-provider-picker__grid">
        {customMatchesQuery && (
          <button
            type="button"
            className="yolo-provider-picker__tile yolo-provider-picker__tile--custom"
            onClick={() => openProvider('openai-compatible')}
          >
            <div className="yolo-provider-picker__tile-head">
              <div className="yolo-provider-picker__tile-icon yolo-provider-picker__tile-icon--custom">
                +
              </div>
              <div className="yolo-provider-picker__tile-text">
                <div className="yolo-provider-picker__tile-name">
                  {customLabel}
                </div>
                <div className="yolo-provider-picker__tile-badges">
                  <span className="yolo-pp-badge yolo-pp-badge--mute">
                    {t(
                      'settings.providers.pickerCustomDesc',
                      'Manually enter base URL and API key',
                    )}
                  </span>
                </div>
              </div>
            </div>
          </button>
        )}

        {filtered.map((presetType) => {
          const catalog = PROVIDER_CATALOG[presetType]
          const info = PROVIDER_PRESET_INFO[presetType]
          const isAdded = addedPresets.has(presetType)
          const isOpenAiCompatible =
            getDefaultApiTypeForPresetType(presetType) === 'openai-compatible'
          return (
            <button
              key={presetType}
              type="button"
              className="yolo-provider-picker__tile"
              data-tint={catalog.tint}
              onClick={() => openProvider(presetType)}
            >
              <div className="yolo-provider-picker__tile-head">
                <TileIcon catalog={catalog} />
                <div className="yolo-provider-picker__tile-text">
                  <div className="yolo-provider-picker__tile-name">
                    {info.label}
                  </div>
                  <div className="yolo-provider-picker__tile-badges">
                    <span
                      className={`yolo-pp-badge yolo-pp-badge--${
                        isOpenAiCompatible ? 'mute' : 'amber'
                      }`}
                    >
                      {isOpenAiCompatible
                        ? t(
                            'settings.providers.badgeOpenAiCompatible',
                            'OpenAI compatible',
                          )
                        : t(
                            'settings.providers.badgeNative',
                            'Native protocol',
                          )}
                    </span>
                    {catalog.oauth && (
                      <span className="yolo-pp-badge yolo-pp-badge--teal">
                        {t('settings.providers.badgeOAuth', 'OAuth')}
                      </span>
                    )}
                    {isAdded && (
                      <span className="yolo-pp-badge yolo-pp-badge--purple">
                        {t('settings.providers.badgeAdded', 'Added')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TileIcon({ catalog }: { catalog: ProviderCatalogEntry }) {
  if (catalog.logo) {
    return (
      <div
        className="yolo-provider-picker__tile-icon yolo-provider-picker__tile-icon--logo"
        data-tint={catalog.tint}
      >
        <img src={catalog.logo} alt="" draggable={false} />
      </div>
    )
  }
  const isCJK = /[一-龥]/.test(catalog.monogram)
  return (
    <div
      className={`yolo-provider-picker__tile-icon yolo-provider-picker__tile-icon--mono${
        isCJK ? ' yolo-provider-picker__tile-icon--cjk' : ''
      }`}
      data-tint={catalog.tint}
    >
      {catalog.monogram}
    </div>
  )
}
