import { App } from 'obsidian'

import YoloPlugin from '../../../main'
import { LearningSection } from '../sections/LearningSection'

type LearningTabProps = {
  app: App
  plugin: YoloPlugin
}

export function LearningTab(_props: LearningTabProps) {
  return <LearningSection />
}
