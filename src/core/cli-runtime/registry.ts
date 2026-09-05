import anthropicLogo from '../../assets/provider-icons/anthropic.svg'
import hermesLogo from '../../assets/provider-icons/hermes.svg'
import ompLogo from '../../assets/provider-icons/omp.svg'
import openaiLogo from '../../assets/provider-icons/openai.svg'
import piLogo from '../../assets/provider-icons/pi.svg'
import xaiLogo from '../../assets/provider-icons/xai.svg'

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
  /** Stable English fallback for call sites where a locale key is absent. */
  defaultLabel: string
  /** i18n key, e.g. `sidebar.runtimeSelector.claudeCodeLabel`. */
  labelKey: string
  /**
   * i18n key for a compact badge form (e.g. chat-list runtime badges).
   * Falls back to `labelKey` when a runtime has no shorter form.
   */
  shortLabelKey?: string
  descriptionKey: string
  /**
   * This runtime is a variant of another one and collapses into *that*
   * runtime's single row in the selector, instead of claiming a row of its
   * own. Purely a presentation declaration: the variant keeps a fully
   * independent runtime id everywhere else (sessions, settings, badges,
   * factories). Declared by the variant, never by the runtime it folds into.
   */
  variantOf?: CliRuntimeId
  /** RuntimeSelector's brand asset and `data-provider` attribute value. */
  icon: Readonly<{ src: string; provider: string }>
  capabilities: ChatRuntimeCapabilities
}>

const DESCRIPTORS_BY_ID: Readonly<Record<CliRuntimeId, CliRuntimeDescriptor>> =
  {
    'claude-code': {
      id: 'claude-code',
      defaultLabel: 'Claude Code',
      labelKey: 'sidebar.runtimeSelector.claudeCodeLabel',
      shortLabelKey: 'sidebar.runtimeSelector.claudeCodeShortLabel',
      descriptionKey: 'sidebar.runtimeSelector.claudeCodeDescription',
      icon: { src: anthropicLogo, provider: 'anthropic' },
      capabilities: RUNTIME_CAPABILITIES['claude-code'],
    },
    codex: {
      id: 'codex',
      defaultLabel: 'Codex',
      labelKey: 'sidebar.runtimeSelector.codexLabel',
      descriptionKey: 'sidebar.runtimeSelector.codexDescription',
      icon: { src: openaiLogo, provider: 'openai' },
      capabilities: RUNTIME_CAPABILITIES.codex,
    },
    hermes: {
      id: 'hermes',
      defaultLabel: 'Hermes',
      labelKey: 'sidebar.runtimeSelector.hermesLabel',
      descriptionKey: 'sidebar.runtimeSelector.hermesDescription',
      icon: { src: hermesLogo, provider: 'hermes' },
      capabilities: RUNTIME_CAPABILITIES.hermes,
    },
    pi: {
      id: 'pi',
      defaultLabel: 'Pi',
      labelKey: 'sidebar.runtimeSelector.piLabel',
      descriptionKey: 'sidebar.runtimeSelector.piDescription',
      icon: { src: piLogo, provider: 'pi' },
      capabilities: RUNTIME_CAPABILITIES.pi,
    },
    omp: {
      id: 'omp',
      defaultLabel: 'omp',
      labelKey: 'sidebar.runtimeSelector.ompLabel',
      descriptionKey: 'sidebar.runtimeSelector.ompDescription',
      variantOf: 'pi',
      icon: { src: ompLogo, provider: 'omp' },
      capabilities: RUNTIME_CAPABILITIES.omp,
    },
    grok: {
      id: 'grok',
      defaultLabel: 'Grok',
      labelKey: 'sidebar.runtimeSelector.grokLabel',
      descriptionKey: 'sidebar.runtimeSelector.grokDescription',
      icon: { src: xaiLogo, provider: 'xai' },
      capabilities: RUNTIME_CAPABILITIES.grok,
    },
  }

/** Ordered by display order — the order the selector and menus render in. */
export const CLI_RUNTIME_DESCRIPTORS: readonly CliRuntimeDescriptor[] =
  CLI_RUNTIME_IDS.map((id) => DESCRIPTORS_BY_ID[id])

export const getCliRuntimeDescriptor = (
  id: CliRuntimeId,
): CliRuntimeDescriptor => DESCRIPTORS_BY_ID[id]

/**
 * One row of the runtime picker: the runtime whose identity the row carries,
 * plus the runtimes that declared `variantOf` on it and therefore fold into
 * this row as inline switches instead of claiming rows of their own.
 *
 * Collapsing is resolved here rather than in the selector so the picker stays
 * generic — declaring `variantOf` on a new fork is the whole cost of folding
 * it in. Only the picker consumes rows; every other surface (badges, input
 * controls, settings) reads descriptors by id, because those surfaces state
 * *which* runtime is in play and a variant is never "its base" there.
 */
export type CliRuntimeSelectorRow = Readonly<{
  primary: CliRuntimeDescriptor
  /** In registry order; empty for a runtime nothing forks. */
  variants: readonly CliRuntimeDescriptor[]
}>

/** Ordered by display order, same as `CLI_RUNTIME_DESCRIPTORS` minus variants. */
export const CLI_RUNTIME_SELECTOR_ROWS: readonly CliRuntimeSelectorRow[] =
  CLI_RUNTIME_DESCRIPTORS.filter((descriptor) => !descriptor.variantOf).map(
    (primary) => ({
      primary,
      variants: CLI_RUNTIME_DESCRIPTORS.filter(
        (descriptor) => descriptor.variantOf === primary.id,
      ),
    }),
  )
