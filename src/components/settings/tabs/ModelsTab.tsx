import { App } from 'obsidian'
import React from 'react'

import YoloPlugin from '../../../main'
import { AsrProvidersSection } from '../sections/AsrProvidersSection'
import { DefaultModelsAndPromptsSection } from '../sections/DefaultModelsAndPromptsSection'
import { ProvidersAndModelsSection } from '../sections/ProvidersAndModelsSection'
import { TtsProvidersSection } from '../sections/TtsProvidersSection'

type ModelsTabProps = {
  app: App
  plugin: YoloPlugin
}

export function ModelsTab({ app, plugin }: ModelsTabProps) {
  return (
    <>
      <ProvidersAndModelsSection app={app} plugin={plugin} />
      <DefaultModelsAndPromptsSection className="yolo-settings-section--tight" />
      <AsrProvidersSection app={app} plugin={plugin} />
      <TtsProvidersSection app={app} plugin={plugin} />
    </>
  )
}
