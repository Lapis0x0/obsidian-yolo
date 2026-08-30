import type { LocalizedTextV1 } from '../src/core/modules/moduleI18n'
import type {
  YoloModuleModelSnapshotV1,
  YoloModuleSettingsContributionV1,
} from '../src/core/modules/moduleSettingsContributions'
import type { YoloModuleWorkerV1 } from '../src/core/modules/moduleWorkerHost'
import type {
  YoloHostApiV1,
  YoloModuleActionToastV1,
  YoloModuleChatModeToolV1,
  YoloModuleChatModeV1,
  YoloModuleFileMenuActionV1,
  YoloModuleFileViewContextV1,
  YoloModuleFileViewInstanceV1,
  YoloModuleFileViewV1,
  YoloModuleI18nV1,
  YoloModuleKeymapBindingV1,
  YoloModuleKeymapModifierV1,
  YoloModuleMenuItemV1,
  YoloModuleOpenFileLocationV1,
  YoloModuleRuntimeRegistration,
  YoloModuleVaultEntryV1,
} from '../src/core/modules/types'

declare global {
  const yolo: YoloModuleRuntimeRegistration
  type YoloModuleHostApiVersion = '1.9.0'
  type YoloModuleHostApiV1 = YoloHostApiV1
  type YoloModuleHostActionToastV1 = YoloModuleActionToastV1
  type YoloModuleHostChatModeV1 = YoloModuleChatModeV1
  type YoloModuleHostChatModeToolV1 = YoloModuleChatModeToolV1
  type YoloModuleHostFileMenuActionV1 = YoloModuleFileMenuActionV1
  type YoloModuleHostFileViewContextV1 = YoloModuleFileViewContextV1
  type YoloModuleHostFileViewInstanceV1 = YoloModuleFileViewInstanceV1
  type YoloModuleHostFileViewV1 = YoloModuleFileViewV1
  type YoloModuleHostI18nV1 = YoloModuleI18nV1
  type YoloModuleHostKeymapBindingV1 = YoloModuleKeymapBindingV1
  type YoloModuleHostKeymapModifierV1 = YoloModuleKeymapModifierV1
  type YoloModuleHostLocalizedTextV1 = LocalizedTextV1
  type YoloModuleHostMenuItemV1 = YoloModuleMenuItemV1
  type YoloModuleHostOpenFileLocationV1 = YoloModuleOpenFileLocationV1
  type YoloModuleHostSettingsContributionV1 = YoloModuleSettingsContributionV1
  type YoloModuleHostModelSnapshotV1 = YoloModuleModelSnapshotV1
  type YoloModuleHostVaultEntryV1 = YoloModuleVaultEntryV1
  type YoloModuleHostWorkerV1 = YoloModuleWorkerV1
}

export {}
