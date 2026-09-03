import { App } from 'obsidian'
import React from 'react'

import type YoloPlugin from '../../../main'
import { DefaultModelsAndPromptsSection } from '../sections/DefaultModelsAndPromptsSection'
import { ProvidersAndModelsSection } from '../sections/ProvidersAndModelsSection'

type ModelsTabProps = {
  app: App
  plugin: YoloPlugin
}

export function ModelsTab({ app, plugin }: ModelsTabProps) {
  return (
    <>
      <ProvidersAndModelsSection app={app} plugin={plugin} />
      <DefaultModelsAndPromptsSection className="yolo-settings-section--tight" />
    </>
  )
}
