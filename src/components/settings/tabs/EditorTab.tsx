import { App } from 'obsidian'
import React from 'react'

import YoloPlugin from '../../../main'
import { AudioFileTranscriptionSection } from '../sections/AudioFileTranscriptionSection'
import { ContextVoiceInputSection } from '../sections/ContextVoiceInputSection'
import { ContinuationSection } from '../sections/ContinuationSection'

type EditorTabProps = {
  app: App
  plugin: YoloPlugin
}

export function EditorTab({ app }: EditorTabProps) {
  return (
    <>
      <ContinuationSection app={app} />
      <ContextVoiceInputSection />
      <AudioFileTranscriptionSection />
    </>
  )
}
