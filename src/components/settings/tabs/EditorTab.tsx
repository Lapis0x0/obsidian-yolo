import { App } from 'obsidian'
import React from 'react'

import YoloPlugin from '../../../main'
import { ContinuationSection } from '../sections/ContinuationSection'

type EditorTabProps = {
  app: App
  plugin: YoloPlugin
}

export function EditorTab({ app }: EditorTabProps) {
  return (
    <>
      <ContinuationSection app={app} />
    </>
  )
}
