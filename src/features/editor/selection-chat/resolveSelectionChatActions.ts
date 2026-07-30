import type { YoloSettings } from '../../../settings/schema/setting.types'

import {
  ALL_SELECTION_ACTION_CONFIGS,
  FIXED_SELECTION_ACTION_CONFIGS,
  FIXED_SELECTION_ACTION_IDS,
  type SelectionActionMode,
  type SelectionActionRewriteBehavior,
  isSelectionQuickActionId,
  resolveSelectionActionMode,
  resolveSelectionActionRewriteBehavior,
} from './selectionChatActionCatalog'

export type ResolvedSelectionChatAction = {
  id: string
  label: string
  instruction: string
  mode: SelectionActionMode
  rewriteBehavior?: SelectionActionRewriteBehavior
  assistantId?: string
}

type TranslateFn = (key: string, fallback?: string) => string

type SelectionActionPreset = {
  id: string
  label: string
  instruction: string
  mode: SelectionActionMode
  rewriteBehavior?: SelectionActionRewriteBehavior
  assistantId?: string
}

/**
 * Reproduces the action-resolution logic of SelectionActionsMenu without React.
 * Returns the same set of actions the in-editor popup would show, so registered
 * Obsidian commands stay in sync with the menu.
 */
export function resolveSelectionChatActions(
  settings: YoloSettings,
  t: TranslateFn,
): ResolvedSelectionChatAction[] {
  const defaultActions: SelectionActionPreset[] =
    ALL_SELECTION_ACTION_CONFIGS.map((config) => {
      const label = t(config.labelKey, config.labelFallback)
      return {
        id: config.id,
        label,
        instruction: config.allowEmptyInstruction ? '' : label,
        mode: config.mode ?? 'ask',
        rewriteBehavior: config.rewriteBehavior,
      }
    })

  const fixedActionLookup = new Map(
    defaultActions
      .filter((action) => FIXED_SELECTION_ACTION_IDS.has(action.id))
      .map((action) => [action.id, action]),
  )

  const customActions =
    settings.continuationOptions?.selectionChatActions?.filter((action) =>
      isSelectionQuickActionId(action.id),
    )
  // Defensive: collapse any accidental duplicate fixed-action ids to the first
  // occurrence so a single hide/show toggle behaves predictably.
  const dedupedCustomActions = customActions
    ? (() => {
        const seenFixed = new Set<string>()
        return customActions.filter((action) => {
          if (!FIXED_SELECTION_ACTION_IDS.has(action.id)) return true
          if (seenFixed.has(action.id)) return false
          seenFixed.add(action.id)
          return true
        })
      })()
    : undefined
  const resolved: SelectionActionPreset[] = dedupedCustomActions
    ? dedupedCustomActions
        .filter((action) => action.enabled)
        .map((action) => {
          // Fixed actions: ignore stored label/instruction/mode and use built-in defaults.
          const fixed = fixedActionLookup.get(action.id)
          if (fixed) return fixed
          return {
            id: action.id,
            label: action.label,
            instruction: action.instruction,
            mode: resolveSelectionActionMode(action.id, action.mode),
            rewriteBehavior: resolveSelectionActionRewriteBehavior(
              action.id,
              resolveSelectionActionMode(action.id, action.mode),
              action.rewriteBehavior,
            ),
            assistantId: action.assistantId,
          }
        })
    : defaultActions

  // Back-compat: if user data omits any fixed action id entirely (e.g. legacy
  // configs predating this feature, or a non-disabled item just missing),
  // prepend the missing ones in their canonical order so they keep showing up.
  const presentIds = new Set(resolved.map((action) => action.id))
  const customActionIds = new Set(
    (dedupedCustomActions ?? []).map((action) => action.id),
  )
  const missingFixed = FIXED_SELECTION_ACTION_CONFIGS.map((config) => config.id)
    .filter((id) => !presentIds.has(id) && !customActionIds.has(id))
    .map((id) => fixedActionLookup.get(id))
    .filter((action): action is SelectionActionPreset => action !== undefined)

  const merged = [...missingFixed, ...resolved]

  return merged.map((action) => {
    const label = action.label?.trim() || action.id
    const mode = resolveSelectionActionMode(action.id, action.mode)
    const rewriteBehavior = resolveSelectionActionRewriteBehavior(
      action.id,
      mode,
      action.rewriteBehavior,
    )
    const rawInstruction = action.instruction?.trim() || ''
    const instruction =
      mode === 'rewrite' ||
      action.id === 'custom-ask' ||
      mode === 'chat-input' ||
      mode === 'chat-send'
        ? rawInstruction
        : rawInstruction || label || action.id
    return {
      id: action.id,
      label,
      instruction,
      mode,
      rewriteBehavior,
      assistantId: action.assistantId,
    }
  })
}
