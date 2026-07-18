import type { LearningBackgroundPort } from '../domain/runtime/ports'

type HostBackground = YoloModuleHostApiV1['background']

export function createHostLearningBackgroundPort(
  background: HostBackground,
): LearningBackgroundPort {
  return {
    upsert: (activity) =>
      background.upsert({
        id: activity.id,
        title: activity.title,
        detail: activity.detail,
        summary: activity.summary,
        icon: activity.icon,
        status: activity.status,
        onOpen: activity.action?.run,
      }),
    remove: (id) => background.remove(id),
  }
}
