import anthropicLogo from '../../assets/provider-icons/anthropic.svg'
import hermesLogo from '../../assets/provider-icons/hermes.svg'
import openaiLogo from '../../assets/provider-icons/openai.svg'
import piLogo from '../../assets/provider-icons/pi.svg'

import { RUNTIME_CAPABILITIES } from './capabilities'
import type { ChatRuntimeCapabilities } from './capabilities'
import { CLI_RUNTIME_IDS } from './types'
import type { CliRuntimeId } from './types'

/**
 * Everything the host UI needs to present a CLI runtime — label, icon, and
 * capability flags — without knowing that runtime's implementation exists.
 * Browser-safe: no node/desktop dependencies, so it can be imported from
 * mobile-reachable code paths.
 *
 * Adding a runtime here (plus a factory in `coordinator.ts`) is the whole
 * cost of surfacing it across the selector, settings schema, and the other
 * per-id UI spots that read from this registry instead of hardcoding ids.
 */
export type CliRuntimeDescriptor = Readonly<{
  id: CliRuntimeId
  /** i18n key, e.g. `sidebar.runtimeSelector.claudeCodeLabel`. */
  labelKey: string
  /**
   * i18n key for a compact badge form (e.g. chat-list runtime badges).
   * Falls back to `labelKey` when a runtime has no shorter form.
   */
  shortLabelKey?: string
  descriptionKey: string
  /** RuntimeSelector's brand asset and `data-provider` attribute value. */
  icon: Readonly<{ src: string; provider: string }>
  capabilities: ChatRuntimeCapabilities
}>

const DESCRIPTORS_BY_ID: Readonly<Record<CliRuntimeId, CliRuntimeDescriptor>> =
  {
    'claude-code': {
      id: 'claude-code',
      labelKey: 'sidebar.runtimeSelector.claudeCodeLabel',
      shortLabelKey: 'sidebar.runtimeSelector.claudeCodeShortLabel',
      descriptionKey: 'sidebar.runtimeSelector.claudeCodeDescription',
      icon: { src: anthropicLogo, provider: 'anthropic' },
      capabilities: RUNTIME_CAPABILITIES['claude-code'],
    },
    codex: {
      id: 'codex',
      labelKey: 'sidebar.runtimeSelector.codexLabel',
      descriptionKey: 'sidebar.runtimeSelector.codexDescription',
      icon: { src: openaiLogo, provider: 'openai' },
      capabilities: RUNTIME_CAPABILITIES.codex,
    },
    hermes: {
      id: 'hermes',
      labelKey: 'sidebar.runtimeSelector.hermesLabel',
      descriptionKey: 'sidebar.runtimeSelector.hermesDescription',
      icon: { src: hermesLogo, provider: 'hermes' },
      capabilities: RUNTIME_CAPABILITIES.hermes,
    },
    pi: {
      id: 'pi',
      labelKey: 'sidebar.runtimeSelector.piLabel',
      descriptionKey: 'sidebar.runtimeSelector.piDescription',
      icon: { src: piLogo, provider: 'pi' },
      capabilities: RUNTIME_CAPABILITIES.pi,
    },
  }

/** Ordered by display order — the order the selector and menus render in. */
export const CLI_RUNTIME_DESCRIPTORS: readonly CliRuntimeDescriptor[] =
  CLI_RUNTIME_IDS.map((id) => DESCRIPTORS_BY_ID[id])

export const getCliRuntimeDescriptor = (
  id: CliRuntimeId,
): CliRuntimeDescriptor => DESCRIPTORS_BY_ID[id]
