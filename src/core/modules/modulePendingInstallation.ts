import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import type { ModuleArtifactPlatform } from './moduleStore'

/** Commits one exact verified descriptor as the next startup target. */
export async function schedulePendingModule(
  transaction: ModuleDeviceStateTransaction,
  moduleId: string,
  platform: ModuleArtifactPlatform,
  descriptor: ModuleArtifactDescriptor,
): Promise<ModuleDeviceState> {
  const existing = await transaction.read()
  if (existing && existing.platform !== platform) {
    throw new Error(
      `Module "${moduleId}" device state belongs to ${existing.platform}, not ${platform}`,
    )
  }
  if (existing?.pending) {
    throw new Error(
      `Module "${moduleId}" installation is blocked by a pending activation`,
    )
  }
  const intended: ModuleDeviceState = {
    moduleId,
    platform,
    active: existing?.active ?? null,
    pending: { descriptor, activationStarted: false },
  }
  try {
    return await transaction.write(intended)
  } catch (error) {
    const actual = await transaction.read().catch(() => null)
    if (actual && statesEqual(actual, intended)) return actual
    throw error
  }
}

export function statesEqual(
  left: ModuleDeviceState,
  right: ModuleDeviceState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
