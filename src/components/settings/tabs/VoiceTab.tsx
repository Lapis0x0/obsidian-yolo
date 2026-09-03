import { App } from 'obsidian'
import React from 'react'

import { AudioFileTranscriptionSection } from '../sections/AudioFileTranscriptionSection'
import { ContextVoiceInputSection } from '../sections/ContextVoiceInputSection'
import { VoiceFloatingIslandSettingsSection } from '../sections/VoiceFloatingIslandSettingsSection'
import { VoiceReadAloudSection } from '../sections/VoiceReadAloudSection'
import type { VoiceSettingsPlugin } from '../voiceSettingsPlugin'

type VoiceTabProps = {
  app: App
  plugin: VoiceSettingsPlugin
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
