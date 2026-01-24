import { App } from 'obsidian'
import React from 'react'

import { useLanguage } from '../../../contexts/language-context'
import SmartComposerPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { EtcSection } from '../sections/EtcSection'

type OthersTabProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function OthersTab({ app, plugin }: OthersTabProps) {
  const { t } = useLanguage()

  return (
    <>
      <div className="smtcmp-settings-section">
        <ObsidianSetting
          name={t('settings.supportSmartComposer.name')}
          desc={t('settings.supportSmartComposer.desc')}
          heading
          className="smtcmp-settings-support-smart-composer"
        >
          <ObsidianButton
            text={t('settings.supportSmartComposer.buyMeACoffee')}
            onClick={() =>
              window.open('https://afdian.com/a/lapis0x0', '_blank')
            }
            cta
          />
        </ObsidianSetting>
      </div>
      <EtcSection app={app} plugin={plugin} />
    </>
  )
}
