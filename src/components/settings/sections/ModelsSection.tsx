import { App } from 'obsidian'
import React from 'react'

import { useLanguage } from '../../../contexts/language-context'
import YoloPlugin from '../../../main'
import { ChatModelsSubSection } from './models/ChatModelsSubSection'
import { EmbeddingModelsSubSection } from './models/EmbeddingModelsSubSection'

type ModelsSectionProps = {
  app: App
  plugin: YoloPlugin
}

export function ModelsSection({ app, plugin }: ModelsSectionProps) {
  const { t } = useLanguage()

  return (
    <div className="yolo-settings-section">
      <div className="yolo-settings-header">{t('settings.models.title')}</div>
      <ChatModelsSubSection app={app} plugin={plugin} />
      <EmbeddingModelsSubSection app={app} plugin={plugin} />
    </div>
  )
}
