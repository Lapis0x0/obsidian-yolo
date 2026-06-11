import type { SettingMigration } from '../setting.types'

type RequestTransportMode = 'browser' | 'obsidian' | 'node'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isRequestTransportMode = (
  value: unknown,
): value is RequestTransportMode =>
  value === 'browser' || value === 'obsidian' || value === 'node'

const migrateRequestTransportMode = (
  additionalSettings: Record<string, unknown>,
): Record<string, unknown> => {
  const next = { ...additionalSettings }
  const mode = additionalSettings.requestTransportMode
  const legacyUseObsidian = additionalSettings.useObsidianRequestUrl
  delete next.useObsidianRequestUrl

  if (isRecord(mode)) {
    const desktop = isRequestTransportMode(mode.desktop) ? mode.desktop : 'node'
    const mobile =
      mode.mobile === 'browser' || mode.mobile === 'obsidian'
        ? mode.mobile
        : desktop === 'obsidian'
          ? 'obsidian'
          : 'browser'
    next.requestTransportMode = { desktop, mobile }
    return next
  }

  if (mode === 'browser' || mode === 'obsidian') {
    next.requestTransportMode = {
      desktop: mode,
      mobile: mode,
    }
    return next
  }

  if (mode === 'node') {
    next.requestTransportMode = {
      desktop: 'node',
      mobile: 'browser',
    }
    return next
  }

  if (legacyUseObsidian === true) {
    next.requestTransportMode = {
      desktop: 'obsidian',
      mobile: 'obsidian',
    }
    return next
  }

  if (legacyUseObsidian === false) {
    next.requestTransportMode = {
      desktop: 'browser',
      mobile: 'browser',
    }
    return next
  }

  next.requestTransportMode = {
    desktop: 'node',
    mobile: 'browser',
  }
  return next
}

/**
 * v68→v69:
 * - Rename legacy chat mode values to ask / agent / agent-full.
 * - Replace single request transport mode with per-platform settings.
 */
export const migrateFrom68To69: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 69 }

  if (
    next.chatOptions &&
    typeof next.chatOptions === 'object' &&
    (next.chatOptions as Record<string, unknown>).chatMode === 'chat'
  ) {
    next.chatOptions = {
      ...(next.chatOptions as Record<string, unknown>),
      chatMode: 'ask',
    }
  }

  if (
    next.continuationOptions &&
    typeof next.continuationOptions === 'object' &&
    (next.continuationOptions as Record<string, unknown>).quickAskMode ===
      'chat'
  ) {
    next.continuationOptions = {
      ...(next.continuationOptions as Record<string, unknown>),
      quickAskMode: 'ask',
    }
  }

  if (Array.isArray(next.providers)) {
    next.providers = next.providers.map((provider) => {
      if (!isRecord(provider)) {
        return provider
      }

      const additionalSettings = isRecord(provider.additionalSettings)
        ? migrateRequestTransportMode(provider.additionalSettings)
        : migrateRequestTransportMode({})

      return {
        ...provider,
        additionalSettings,
      }
    })
  }

  return next
}
