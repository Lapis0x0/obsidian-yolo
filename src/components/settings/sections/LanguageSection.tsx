import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'

const LANGUAGE_KEYS = ['auto', 'en', 'zh', 'it'] as const

export function LanguageSection() {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()

  const languageOptions: Record<string, string> = {
    auto: t('settings.language.auto', 'Auto (Follow Obsidian)'),
    en: 'English',
    zh: '中文',
    it: 'Italiano',
  }

  const currentPreference =
    LANGUAGE_KEYS.includes(settings.languagePreference) &&
    settings.languagePreference
      ? settings.languagePreference
      : 'auto'

  return (
    <ObsidianSetting
      name={t('settings.language.title')}
      desc={t('settings.language.select')}
      heading
    >
      <ObsidianDropdown
        options={languageOptions}
        value={currentPreference}
        onChange={(value) => {
          if (
            !LANGUAGE_KEYS.includes(value as (typeof LANGUAGE_KEYS)[number])
          ) {
            return
          }
          void Promise.resolve(
            setSettings({
              ...settings,
              languagePreference: value as (typeof LANGUAGE_KEYS)[number],
            }),
          ).catch((error) => {
            console.error('Failed to update language preference', error)
          })
        }}
      />
    </ObsidianSetting>
  )
}
