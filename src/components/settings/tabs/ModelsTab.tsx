import { App } from 'obsidian'
import React from 'react'

import SmartComposerPlugin from '../../../main'
import { DefaultModelsAndPromptsSection } from '../sections/DefaultModelsAndPromptsSection'
import { ProvidersAndModelsSection } from '../sections/ProvidersAndModelsSection'

type ModelsTabProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function ModelsTab({ app, plugin }: ModelsTabProps) {
  return (
    <>
      <ProvidersAndModelsSection app={app} plugin={plugin} />
      <DefaultModelsAndPromptsSection />
    </>
  )
}
