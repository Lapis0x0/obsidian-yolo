import { App } from 'obsidian'
import React from 'react'

import YoloPlugin from '../../../main'
import { AudioFileTranscriptionSection } from '../sections/AudioFileTranscriptionSection'
import { ContextVoiceInputSection } from '../sections/ContextVoiceInputSection'
import { VoiceFloatingIslandSettingsSection } from '../sections/VoiceFloatingIslandSettingsSection'
import { VoiceReadAloudSection } from '../sections/VoiceReadAloudSection'

type VoiceTabProps = {
  app: App
  plugin: YoloPlugin
}

export function VoiceTab(_props: VoiceTabProps) {
  return (
    <>
      <VoiceFloatingIslandSettingsSection />
      <ContextVoiceInputSection />
      <AudioFileTranscriptionSection />
      <VoiceReadAloudSection />
    </>
  )
}
