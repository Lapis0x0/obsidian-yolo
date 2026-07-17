import type {
  YoloHostApiV1,
  YoloModuleRuntimeRegistration,
} from '../src/core/modules/types'

declare global {
  const yolo: YoloModuleRuntimeRegistration
  type YoloModuleHostApiV1 = YoloHostApiV1
}

export {}
