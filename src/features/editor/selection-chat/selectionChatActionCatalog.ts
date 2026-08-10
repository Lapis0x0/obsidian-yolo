export type SelectionActionMode = 'ask' | 'rewrite' | 'chat-input' | 'chat-send'

export type SelectionActionRewriteBehavior = 'custom' | 'preset'

export type SelectionActionConfig = {
  id: string
  labelKey: string
  labelFallback: string
  mode?: SelectionActionMode
  rewriteBehavior?: SelectionActionRewriteBehavior
  allowEmptyInstruction?: boolean
}

export const FIXED_SELECTION_ACTION_CONFIGS: SelectionActionConfig[] = [
  {
    id: 'custom-rewrite',
    labelKey: 'selection.actions.customRewrite',
    labelFallback: '自定义改写',
    mode: 'rewrite',
    rewriteBehavior: 'custom',
    allowEmptyInstruction: true,
  },
  {
    id: 'custom-ask',
    labelKey: 'selection.actions.customAsk',
    labelFallback: '自定义提问',
    mode: 'ask',
    allowEmptyInstruction: true,
  },
  {
    id: 'add-to-sidebar',
    labelKey: 'selection.actions.addToSidebar',
    labelFallback: '添加到侧边栏',
    mode: 'chat-input',
    allowEmptyInstruction: true,
  },
]

const NON_QUICK_SELECTION_ACTION_IDS = new Set(['adjust-length'])

export function isSelectionQuickActionId(id: string): boolean {
  return !NON_QUICK_SELECTION_ACTION_IDS.has(id)
}

export const DEFAULT_SELECTION_ACTION_CONFIGS: SelectionActionConfig[] = [
  {
    id: 'explain',
    labelKey: 'selection.actions.explain',
    labelFallback: '深入解释',
    mode: 'ask',
  },
  {
    id: 'suggest',
    labelKey: 'selection.actions.suggest',
    labelFallback: '提供建议',
    mode: 'ask',
  },
  {
    id: 'translate-to-chinese',
    labelKey: 'selection.actions.translateToChinese',
    labelFallback: '翻译成中文',
    mode: 'ask',
  },
]

export const ALL_SELECTION_ACTION_CONFIGS = [
  ...FIXED_SELECTION_ACTION_CONFIGS,
  ...DEFAULT_SELECTION_ACTION_CONFIGS,
]

export const FIXED_SELECTION_ACTION_IDS = new Set(
  FIXED_SELECTION_ACTION_CONFIGS.map((config) => config.id),
)

export const SELECTION_ACTION_CONFIG_BY_ID: Record<
  string,
  SelectionActionConfig
> = Object.fromEntries(
  ALL_SELECTION_ACTION_CONFIGS.map((config) => [config.id, config]),
)

export function resolveSelectionActionMode(
  id: string,
  mode?: SelectionActionMode,
): SelectionActionMode {
  if (mode) return mode
  if (id === 'rewrite' || id === 'custom-rewrite') return 'rewrite'
  if (id === 'chat-send') return 'chat-send'
  if (id === 'chat-input' || id === 'add-to-sidebar') return 'chat-input'
  return 'ask'
}

export function resolveSelectionActionRewriteBehavior(
  id: string,
  mode: SelectionActionMode,
  behavior?: SelectionActionRewriteBehavior,
): SelectionActionRewriteBehavior | undefined {
  if (mode !== 'rewrite') return undefined
  if (behavior) return behavior
  return id === 'custom-rewrite' ? 'custom' : 'preset'
}
