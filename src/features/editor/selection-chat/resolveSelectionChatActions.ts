import type {
  SelectionActionMode,
  SelectionActionRewriteBehavior,
} from '../../../components/selection/SelectionActionsMenu'
import type { YoloSettings } from '../../../settings/schema/setting.types'

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

const FIXED_ACTION_IDS = new Set([
  'adjust-length',
  'custom-rewrite',
  'custom-ask',
  'add-to-sidebar',
])

const FIXED_ACTION_ORDER = [
  'adjust-length',
  'custom-rewrite',
  'custom-ask',
  'add-to-sidebar',
]

const resolveMode = (
  id: string,
  mode?: SelectionActionMode,
): SelectionActionMode => {
  if (mode) return mode
  if (id === 'rewrite' || id === 'custom-rewrite') return 'rewrite'
  if (id === 'chat-send') return 'chat-send'
  if (id === 'chat-input' || id === 'add-to-sidebar') return 'chat-input'
  return 'ask'
}

const resolveRewriteBehavior = (
  id: string,
  mode: SelectionActionMode,
  behavior?: SelectionActionRewriteBehavior,
): SelectionActionRewriteBehavior | undefined => {
  if (mode !== 'rewrite') return undefined
  if (behavior) return behavior
  return id === 'custom-rewrite' ? 'custom' : 'preset'
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
  const defaultActions: SelectionActionPreset[] = [
    {
      id: 'adjust-length',
      label: t('selection.actions.adjustLength', '调整篇幅'),
      instruction: '',
      mode: 'rewrite',
      rewriteBehavior: 'custom',
    },
    {
      id: 'custom-rewrite',
      label: t('selection.actions.customRewrite', '自定义改写'),
      instruction: '',
      mode: 'rewrite',
      rewriteBehavior: 'custom',
    },
    {
      id: 'custom-ask',
      label: t('selection.actions.customAsk', '自定义提问'),
      instruction: '',
      mode: 'ask',
    },
    {
      id: 'add-to-sidebar',
      label: t('selection.actions.addToSidebar', '添加到侧边栏'),
      instruction: '',
      mode: 'chat-input',
    },
    {
      id: 'explain',
      label: t('selection.actions.explain', '深入解释'),
      instruction: t('selection.actions.explain', '深入解释'),
      mode: 'ask',
    },
    {
      id: 'suggest',
      label: t('selection.actions.suggest', '提供建议'),
      instruction: t('selection.actions.suggest', '提供建议'),
      mode: 'ask',
    },
    {
      id: 'translate-to-chinese',
      label: t('selection.actions.translateToChinese', '翻译成中文'),
      instruction: t('selection.actions.translateToChinese', '翻译成中文'),
      mode: 'ask',
    },
  ]

  const fixedActionLookup = new Map(
    defaultActions
      .filter((action) => FIXED_ACTION_IDS.has(action.id))
      .map((action) => [action.id, action]),
  )

  const customActions = settings.continuationOptions?.selectionChatActions
  // Defensive: collapse any accidental duplicate fixed-action ids to the first
  // occurrence so a single hide/show toggle behaves predictably.
  const dedupedCustomActions = customActions
    ? (() => {
        const seenFixed = new Set<string>()
        return customActions.filter((action) => {
          if (!FIXED_ACTION_IDS.has(action.id)) return true
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
            mode: resolveMode(action.id, action.mode),
            rewriteBehavior: resolveRewriteBehavior(
              action.id,
              resolveMode(action.id, action.mode),
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
  const missingFixed = FIXED_ACTION_ORDER.filter(
    (id) => !presentIds.has(id) && !customActionIds.has(id),
  )
    .map((id) => fixedActionLookup.get(id))
    .filter((action): action is SelectionActionPreset => action !== undefined)

  const merged = [...missingFixed, ...resolved]

  return merged.map((action) => {
    const label = action.label?.trim() || action.id
    const mode = resolveMode(action.id, action.mode)
    const rewriteBehavior = resolveRewriteBehavior(
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
