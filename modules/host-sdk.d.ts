import type {
  YoloModuleModelSnapshotV1,
  YoloModuleSettingsContributionV1,
} from '../src/core/modules/moduleSettingsContributions'
import type { YoloModuleWorkerV1 } from '../src/core/modules/moduleWorkerHost'
import type {
  YoloHostApiV1,
  YoloModuleActionToastV1,
  YoloModuleOpenFileLocationV1,
  YoloModuleRuntimeRegistration,
} from '../src/core/modules/types'

declare global {
  const yolo: YoloModuleRuntimeRegistration
  type YoloModuleHostApiVersion = '1.2.0'
  type YoloModuleHostApiV1 = YoloHostApiV1
  type YoloModuleHostActionToastV1 = YoloModuleActionToastV1
  type YoloModuleHostOpenFileLocationV1 = YoloModuleOpenFileLocationV1
  type YoloModuleHostSettingsContributionV1 = YoloModuleSettingsContributionV1
  type YoloModuleHostModelSnapshotV1 = YoloModuleModelSnapshotV1
  type YoloModuleHostWorkerV1 = YoloModuleWorkerV1
}

export {}
