import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatUserMessage } from '../../types/chat'
import {
  AUTO_TITLE_FAILURE_COOLDOWN_MS,
  generateConversationTitleText,
} from '../../utils/chat/generateConversationTitle'
import type { AutoPromotedTransportMode } from '../llm/requestTransport'

import type { CliRuntimeScope } from './coordinator'
import { getCliSessionIndexKey } from './session-index'
import type { CliSessionRef } from './types'

const titleGenerationInFlight = new Set<string>()
const titleGenerationCooldownUntil = new Map<string, number>()

export type EnsureCliSessionAutoTitleInput = {
  settings: YoloSettings
  language: string
  scope: CliRuntimeScope
  sessionRef: CliSessionRef
  userMessage: ChatUserMessage
  onAutoPromoteTransportMode?: (
    providerId: string,
    mode: AutoPromotedTransportMode,
  ) => void
}

/**
 * On CLI submit: if the YOLO overlay has no title yet, generate one with the
 * shared title core, persist it on the overlay, and best-effort rename the
 * native Claude/Codex session.
 */
export const ensureCliSessionAutoTitle = async ({
  settings,
  language,
  scope,
  sessionRef,
  userMessage,
  onAutoPromoteTransportMode,
}: EnsureCliSessionAutoTitleInput): Promise<boolean> => {
  const key = getCliSessionIndexKey(sessionRef)
  let ownsInFlight = false
  try {
    const existingOverlayTitle =
      await scope.sessionService.getOverlayTitle(sessionRef)
    if (existingOverlayTitle) return false

    const cooldownUntil = titleGenerationCooldownUntil.get(key) ?? 0
    if (cooldownUntil > Date.now()) {
      console.debug('[YOLO] Auto title skipped', {
        sessionKey: key,
        reason: 'cooldown_active',
      })
      return false
    }
    if (titleGenerationInFlight.has(key)) {
      console.debug('[YOLO] Auto title skipped', {
        sessionKey: key,
        reason: 'in_flight',
      })
      return false
    }

    titleGenerationInFlight.add(key)
    ownsInFlight = true
    const result = await generateConversationTitleText({
      settings,
      language,
      messages: [userMessage],
      onAutoPromoteTransportMode,
      debug: {
        conversationId: key,
        sourceUserMessageId: userMessage.id,
      },
    })
    if (!result.ok) {
      console.debug('[YOLO] Auto title skipped', {
        sessionKey: key,
        reason: result.reason,
      })
      if (result.reason === 'llm_generation_failed') {
        const errorMessage =
          result.error instanceof Error
            ? result.error.message
            : typeof result.error === 'string'
              ? result.error
              : result.error
                ? JSON.stringify(result.error)
                : 'unknown_error'
        console.error('[YOLO] Failed to generate CLI session title', {
          sessionKey: key,
          error: errorMessage,
        })
        titleGenerationCooldownUntil.set(
          key,
          Date.now() + AUTO_TITLE_FAILURE_COOLDOWN_MS,
        )
      }
      return false
    }

    // Re-check after generation to avoid racing a concurrent rename.
    if (await scope.sessionService.getOverlayTitle(sessionRef)) return false

    titleGenerationCooldownUntil.delete(key)
    await scope.sessionService.applyGeneratedTitle({
      ref: sessionRef,
      title: result.title,
    })
    return true
  } catch (error) {
    console.warn('[YOLO] Failed to ensure CLI session title', {
      sessionKey: key,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  } finally {
    if (ownsInFlight) titleGenerationInFlight.delete(key)
  }
}
