import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Infinity as InfinityIcon,
  ListTodo,
  MessageSquare,
  PenLine,
  Zap,
} from 'lucide-react'
import { Platform } from 'obsidian'
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type { RegisteredModuleChatModeV1 } from '../../../core/modules/moduleChatModeRegistry'
import type { BuiltinChatModeId } from '../../../core/tools/types'
import { getNodeWindow } from '../../../utils/dom/window-context'
import { ObsidianIcon } from '../../common/ObsidianIcon'
import { YoloDropdownContent } from '../../common/popover'

/**
 * Namespaced id a module chat mode is addressed by everywhere outside its
 * own registration: `module:<moduleId>:<modeId>`. The prefix lets every
 * consumer recognize a module mode by shape alone, with no registry lookup
 * required (registry lookup is only needed to resolve *availability* — see
 * `resolveEffectiveChatMode`).
 */
export type ModuleChatModeId = `module:${string}:${string}`

/**
 * The host-native modes — excludes module chat modes. `settings.chatOptions.
 * chatMode` (global default) stays scoped to this narrower type: a global
 * default can't sensibly point at something that may be uninstalled.
 *
 * The same union the tool registry declares capability visibility against
 * (`BuiltinChatModeId`), reused rather than restated: two hand-aligned copies
 * of "which built-in modes exist" can only drift.
 */
export type BuiltinChatMode = BuiltinChatModeId

/**
 * YOLO-native capability modes plus any published module chat mode. Built-in
 * values are mutually exclusive and describe what the chat is allowed to do.
 * "Auto-approve tool calls" (YOLO) is NOT a mode — it is an orthogonal
 * boolean (`yoloEnabled`) that only takes effect in the tool-carrying modes
 * (Agent, Max), each of which keeps its own value. See
 * `chat-runtime-profiles.ts` and `yoloToggleOwnerMode`.
 */
export type ChatMode = BuiltinChatMode | ModuleChatModeId

/**
 * Semantic alias for `ChatMode` used at persistence boundaries (conversation
 * overrides, settings). A persisted value may name a module mode that is
 * currently unregistered or disabled — see `resolveEffectiveChatMode`, which
 * is the only place that downgrades a persisted value for actual use.
 */
export type PersistedChatMode = ChatMode

/**
 * Values the mode selector can display. CLI runtimes may include `plan`
 * (Claude Code only) without expanding YOLO-native `ChatMode`.
 */
export type ChatModeSelectValue = ChatMode | 'plan'
export type ChatModeSelectOptionValue = ChatModeSelectValue | 'continue'

export const CHAT_MODES: readonly ChatMode[] = ['ask', 'agent', 'max']

/**
 * Max's tools are a real filesystem and a real shell (`native_files`,
 * `terminal`), neither of which exists on mobile — so mobile is never offered
 * the mode at all, and a persisted or session-override `'max'` opened there
 * runs as Agent (see `resolveEffectiveChatMode`).
 */
const MOBILE_CHAT_MODES: readonly ChatMode[] = ['ask', 'agent']

/** The built-in modes selectable on this device — see `MOBILE_CHAT_MODES`. */
export const availableBuiltinChatModes = (): readonly ChatMode[] =>
  Platform.isDesktop ? CHAT_MODES : MOBILE_CHAT_MODES

export const CLAUDE_CODE_CHAT_MODES: readonly ChatModeSelectValue[] = [
  'agent',
  'plan',
]

export const CODEX_CHAT_MODES: readonly ChatModeSelectValue[] = ['agent']

/** Full persisted/runtime module mode id format — see `ChatMode`. */
export const MODULE_CHAT_MODE_ID_RE = /^module:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/

export const isModuleChatMode = (value: string): value is ModuleChatModeId =>
  MODULE_CHAT_MODE_ID_RE.test(value)

/**
 * Which mode's card carries the YOLO switch. `yoloEnabled` is a single value
 * describing exactly one trust profile — the selected mode's when it has one,
 * Agent's otherwise (Ask and Plan have no profile of their own but have
 * always shown Agent's switch) — so the switch renders on that one mode's
 * card. Putting a switch on both tool-mode cards would display one profile's
 * state under the other's label, since the component is only ever handed the
 * one value. See `yoloPreferenceKeyForMode`, which resolves the same question
 * at the persistence layer.
 */
export const yoloToggleOwnerMode = (
  mode: ChatModeSelectOptionValue,
): 'agent' | 'max' => (mode === 'max' ? 'max' : 'agent')

export const shouldShowYoloToggle = (
  availableModes: readonly ChatModeSelectOptionValue[],
  mode: ChatModeSelectOptionValue,
): boolean =>
  mode !== 'plan' &&
  !isModuleChatMode(mode) &&
  availableModes.includes(yoloToggleOwnerMode(mode))

export const isYoloModeActive = (
  showYoloControl: boolean,
  mode: ChatModeSelectOptionValue,
  yoloEnabled: boolean,
): boolean => showYoloControl && isToolChatMode(mode) && yoloEnabled

export const isChatMode = (value: string): value is ChatMode =>
  value === 'ask' ||
  value === 'agent' ||
  value === 'max' ||
  isModuleChatMode(value)

export const isChatModeSelectValue = (
  value: string,
): value is ChatModeSelectValue => isChatMode(value) || value === 'plan'

export const isChatModeSelectOptionValue = (
  value: string,
): value is ChatModeSelectOptionValue =>
  isChatModeSelectValue(value) || value === 'continue'

/**
 * Normalizes a persisted chat mode value (conversation override, seeded
 * settings default): historical aliases are folded first, then a built-in
 * value or a *fully format-valid* module mode id passes through unchanged —
 * this does NOT check registry availability, so it stays usable without a
 * registry snapshot (e.g. seeding React state on first render). Anything
 * else falls back to `fallback`. Use `resolveEffectiveChatMode` to further
 * resolve a persisted value against the live registry before running it.
 */
export const normalizePersistedChatMode = (
  raw: string | null | undefined,
  fallback: ChatMode,
): ChatMode => {
  if (raw === 'chat') {
    return 'ask'
  }
  // Legacy value: `agent-full` used to encode "agent + auto-approval". The
  // capability is just Agent now; the YOLO bit is recovered via
  // `normalizeYoloEnabled`.
  if (raw === 'agent-full') {
    return 'agent'
  }
  if (raw && isChatMode(raw)) {
    return raw
  }
  return fallback
}

/**
 * Resolves a persisted chat mode to the value that should actually run:
 * `'max'` opened on mobile downgrades to `'agent'` (the mode's tools are
 * desktop-only); unregistered or unavailable (e.g. the owning module was
 * disabled/uninstalled) module mode ids downgrade to `'agent'`; everything
 * else (built-in values, and module ids that are registered + available)
 * passes through unchanged.
 *
 * This is the ONLY place that downgrades a persisted value — call sites must
 * never persist the result back (see `chatModeForSave`). That is what lets a
 * vault synced between a desktop and a phone keep running Max on the desktop
 * while the phone silently reads the same conversation as Agent.
 */
export const resolveEffectiveChatMode = (
  persisted: ChatMode,
  registeredModuleChatModes: readonly RegisteredModuleChatModeV1[],
): ChatMode => {
  if (persisted === 'max') {
    return Platform.isDesktop ? 'max' : 'agent'
  }
  if (!isModuleChatMode(persisted)) {
    return persisted
  }
  const entry = registeredModuleChatModes.find(
    (candidate) => candidate.fullModeId === persisted,
  )
  return entry && entry.availability.status === 'available'
    ? persisted
    : 'agent'
}

/**
 * The only sanctioned way to read the chat mode that belongs in a persisted
 * conversation (override, new-conversation default, branch copy, every
 * per-message save). Callers MUST pass the session's tracked
 * `persistedChatMode`, never a runtime-downgraded effective value — a
 * disabled module must never permanently overwrite a session's chat mode.
 * Kept as a named seam (not inlined) so every write-back call site is
 * greppable and self-documents intent.
 */
export const chatModeForSave = (
  persistedChatMode: ChatMode,
): PersistedChatMode => persistedChatMode

/**
 * Recover the orthogonal YOLO flag, including from the legacy `agent-full`
 * value that conflated mode and auto-approval.
 */
export const normalizeYoloEnabled = (
  rawMode: string | null | undefined,
  rawYolo: boolean | null | undefined,
  fallback = false,
): boolean => {
  if (rawMode === 'agent-full') {
    return true
  }
  if (typeof rawYolo === 'boolean') {
    return rawYolo
  }
  return fallback
}

/**
 * A trust profile belongs to one mode, so the persisted YOLO flag is stored
 * per mode. Ask and Plan have no profile of their own and keep reading and
 * writing Agent's, exactly as they did when it was the only one — see
 * `yoloToggleOwnerMode`, the UI-side answer to the same question.
 *
 * The key names a field that both `ConversationOverrideSettings` and
 * `settings.chatOptions` carry, so one lookup serves the per-conversation
 * override and the global default alike.
 */
export type YoloPreferenceKey = 'agentYoloEnabled' | 'maxYoloEnabled'

export const yoloPreferenceKeyForMode = (
  mode: ChatModeSelectOptionValue,
): YoloPreferenceKey => (mode === 'max' ? 'maxYoloEnabled' : 'agentYoloEnabled')

/** Reads the YOLO flag `mode` owns out of an overrides / chatOptions record. */
export const readYoloPreference = (
  source:
    | {
        agentYoloEnabled?: boolean | null
        maxYoloEnabled?: boolean | null
      }
    | null
    | undefined,
  mode: ChatModeSelectOptionValue,
): boolean | null | undefined => source?.[yoloPreferenceKeyForMode(mode)]

/** The overrides / chatOptions patch that stores `enabled` for `mode`. */
export const yoloPreferencePatch = (
  mode: ChatModeSelectOptionValue,
  enabled: boolean,
): { agentYoloEnabled: boolean } | { maxYoloEnabled: boolean } =>
  mode === 'max' ? { maxYoloEnabled: enabled } : { agentYoloEnabled: enabled }

export const isAgentChatMode = (mode: ChatModeSelectOptionValue): boolean =>
  mode === 'agent'

/**
 * The built-in modes that run the agent loop with tools: Agent and Max. Use
 * this — not `isAgentChatMode` — wherever the question is "does this mode
 * have tools, an assistant, a trust profile, a task list", which is nearly
 * everywhere the codebase used to compare against `'agent'`.
 * `isAgentChatMode` is left for the few places that genuinely mean the Agent
 * mode specifically.
 */
export const isToolChatMode = (mode: ChatModeSelectOptionValue): boolean =>
  mode === 'agent' || mode === 'max'

/**
 * Narrows a chat mode down to what the mention menu's `/` mode switcher
 * understands (`MENTION_CHAT_MODES` = `['ask', 'agent']` only — see
 * `MentionPlugin.tsx`, consumed from `ChatUserInput.tsx`). Max and module
 * chat modes are agent-like (tools + capability profile), so they narrow to
 * `'agent'` rather than dropping out as `undefined` — otherwise the menu
 * would highlight `'ask'` as the current mode while the conversation is
 * actually running one of them.
 */
export function narrowToMentionChatMode(
  mode: ChatModeSelectValue | undefined,
): 'ask' | 'agent' | undefined {
  if (mode === 'ask') return 'ask'
  if (mode === 'agent' || mode === 'max') return 'agent'
  if (mode !== undefined && isModuleChatMode(mode)) return 'agent'
  return undefined
}

/**
 * A module chat mode ready for rendering: text already resolved to the
 * current locale by the caller (`resolveLocalizedText` against the
 * registry's `LocalizedTextV1` label/description — see `Chat.tsx`), so this
 * component never needs registry or i18n access itself.
 */
export type ModuleChatModeOption = Readonly<{
  value: ModuleChatModeId
  label: string
  description?: string
  icon?: string
}>

/**
 * Module options the caller declared minus any not currently selectable
 * (mirrors how built-in `MODE_OPTIONS` are filtered by `availableModes` —
 * see `visibleOptions` below). Exported as a pure function so the filtering
 * rule is unit-testable without rendering the popover (this component has no
 * RTL test harness — see `ChatModeSelect.test.ts`).
 */
export function resolveVisibleModuleModeOptions(
  moduleModeOptions: readonly ModuleChatModeOption[],
  availableModes: readonly ChatModeSelectOptionValue[],
): readonly ModuleChatModeOption[] {
  return moduleModeOptions.filter((option) =>
    availableModes.includes(option.value),
  )
}

type ModeOption = {
  value: ChatModeSelectOptionValue
  labelKey: string
  labelFallback: string
  descKey: string
  descFallback: string
  icon: React.ReactNode
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'ask',
    labelKey: 'chatMode.ask',
    labelFallback: 'Ask',
    descKey: 'chatMode.askDesc',
    descFallback: 'Ask, refine, create',
    icon: <MessageSquare size={16} />,
  },
  {
    value: 'agent',
    labelKey: 'chatMode.agent',
    labelFallback: 'Agent',
    descKey: 'chatMode.agentDesc',
    descFallback: 'Tools for complex tasks',
    icon: <Bot size={16} />,
  },
  {
    value: 'max',
    labelKey: 'chatMode.max',
    labelFallback: 'Max',
    descKey: 'chatMode.maxDesc',
    descFallback: 'Work directly on local files and the terminal (desktop)',
    icon: <Zap size={16} />,
  },
  {
    value: 'plan',
    labelKey: 'chatMode.plan',
    labelFallback: 'Plan',
    descKey: 'chatMode.planDesc',
    descFallback: 'Explore and design before editing',
    icon: <ListTodo size={16} />,
  },
  {
    value: 'continue',
    labelKey: 'chatMode.continue',
    labelFallback: 'Write',
    descKey: 'chatMode.continueDesc',
    descFallback: 'Continue writing at the cursor, press Tab to accept',
    icon: <PenLine size={16} />,
  },
]

const EMPTY_MODULE_MODE_OPTIONS: readonly ModuleChatModeOption[] = []

export const ChatModeSelect = forwardRef<
  HTMLButtonElement,
  {
    mode: ChatModeSelectOptionValue
    onChange: (mode: ChatModeSelectOptionValue) => void
    availableModes?: readonly ChatModeSelectOptionValue[]
    /** Rendered after the built-in options — see `resolveVisibleModuleModeOptions`. */
    moduleModeOptions?: readonly ModuleChatModeOption[]
    yoloEnabled: boolean
    onYoloChange: (enabled: boolean) => void
    showYoloToggle?: boolean
    triggerLabel?: string
    popoverClassName?: string
    onArrowDownWhenClosed?: () => boolean
    onMenuOpenChange?: (isOpen: boolean) => void
    onKeyDown?: (
      event: React.KeyboardEvent<HTMLButtonElement>,
      isMenuOpen: boolean,
    ) => void
    container?: HTMLElement
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
    align?: 'start' | 'center' | 'end'
    alignOffset?: number
  }
>(
  (
    {
      mode,
      onChange,
      availableModes = CHAT_MODES,
      moduleModeOptions = EMPTY_MODULE_MODE_OPTIONS,
      yoloEnabled,
      onYoloChange,
      showYoloToggle = true,
      triggerLabel,
      popoverClassName,
      onArrowDownWhenClosed,
      onMenuOpenChange,
      onKeyDown,
      container,
      side = 'top',
      sideOffset = 4,
      align = 'start',
      alignOffset = -12,
    },
    ref,
  ) => {
    const { t } = useLanguage()
    const [isOpen, setIsOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const visibleOptions = useMemo(
      () =>
        MODE_OPTIONS.filter((option) => availableModes.includes(option.value)),
      [availableModes],
    )
    const visibleModuleOptions = useMemo(
      () => resolveVisibleModuleModeOptions(moduleModeOptions, availableModes),
      [moduleModeOptions, availableModes],
    )
    const showYoloControl =
      showYoloToggle && shouldShowYoloToggle(availableModes, mode)
    const navOrder = useMemo(() => {
      const keys: ChatModeSelectOptionValue[] = [
        ...visibleOptions.map((option) => option.value),
        ...visibleModuleOptions.map((option) => option.value),
      ]
      return showYoloControl ? ([...keys, 'yolo'] as const) : keys
    }, [showYoloControl, visibleOptions, visibleModuleOptions])
    type NavKey = (typeof navOrder)[number]
    const itemRefs = useRef<
      Partial<Record<NavKey | 'yolo', HTMLElement | null>>
    >({})

    const setTriggerRef = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node
        if (typeof ref === 'function') {
          ref(node)
        } else if (ref) {
          ref.current = node
        }
      },
      [ref],
    )

    const currentOption =
      visibleOptions.find((opt) => opt.value === mode) ?? visibleOptions[0]
    const currentModuleOption = visibleModuleOptions.find(
      (option) => option.value === mode,
    )

    const focusSelectedItem = useCallback(() => {
      const target = itemRefs.current[mode]
      if (!target) return
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }, [mode])

    const focusByDelta = useCallback(
      (delta: number) => {
        const ownerWindow = getNodeWindow(triggerRef.current)
        const activeEl = ownerWindow.document.activeElement
        let currentIndex = navOrder.findIndex(
          (key) => itemRefs.current[key] === activeEl,
        )
        if (currentIndex < 0) {
          const modeIndex = navOrder.findIndex((key) => key === mode)
          currentIndex = modeIndex >= 0 ? modeIndex : 0
        }
        const nextIndex =
          (currentIndex + delta + navOrder.length) % navOrder.length
        const target = itemRefs.current[navOrder[nextIndex]]
        if (target) {
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      },
      [mode, navOrder],
    )

    useEffect(() => {
      if (!isOpen) return
      const ownerWindow = getNodeWindow(triggerRef.current)
      const rafId = ownerWindow.requestAnimationFrame(() => {
        focusSelectedItem()
      })
      return () => ownerWindow.cancelAnimationFrame(rafId)
    }, [focusSelectedItem, isOpen])

    const handleOpenChange = (open: boolean) => {
      setIsOpen(open)
      onMenuOpenChange?.(open)
    }

    const handleTriggerKeyDown = (
      event: React.KeyboardEvent<HTMLButtonElement>,
    ) => {
      if (event.key === 'ArrowDown' && onArrowDownWhenClosed?.()) {
        event.preventDefault()
        return
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (onKeyDown) {
          onKeyDown(event, isOpen)
        }
        if (event.defaultPrevented) {
          return
        }

        if (!isOpen) {
          event.preventDefault()
          setIsOpen(true)
          return
        }
        event.preventDefault()
        focusSelectedItem()
        return
      }

      if (isOpen && event.key === 'Escape') {
        event.preventDefault()
        handleOpenChange(false)
        return
      }

      if (onKeyDown) {
        onKeyDown(event, isOpen)
      }
    }

    const selectMode = (next: ChatModeSelectOptionValue) => {
      onChange(next)
      handleOpenChange(false)
    }

    const handleYoloToggle = () => {
      // Behavior A: YOLO is orthogonal. Toggling it never changes the
      // capability mode and keeps the menu open so the switch state is visible.
      onYoloChange(!yoloEnabled)
    }

    const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        focusByDelta(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        focusByDelta(-1)
      }
    }
    const isYoloActive = isYoloModeActive(showYoloControl, mode, yoloEnabled)

    return (
      <DropdownMenu.Root open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenu.Trigger
          ref={setTriggerRef}
          className="yolo-chat-input-model-select yolo-chat-mode-select"
          data-mode={mode}
          data-yolo={isYoloActive ? 'on' : 'off'}
          onKeyDown={handleTriggerKeyDown}
        >
          <div className="yolo-chat-input-model-select__model-name">
            {triggerLabel ??
              currentModuleOption?.label ??
              t(
                currentOption?.labelKey ?? 'chatMode.ask',
                currentOption?.labelFallback ?? 'Ask',
              )}
          </div>
          {isYoloActive ? (
            <div
              className="yolo-chat-mode-select__yolo-badge"
              title={t('chatMode.yolo', 'YOLO')}
            >
              <InfinityIcon size={11} />
            </div>
          ) : null}
          <div className="yolo-chat-input-model-select__icon">
            {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </DropdownMenu.Trigger>

        <YoloDropdownContent
          container={container}
          anchorRef={triggerRef}
          variant="default"
          className={popoverClassName}
          minWidth={220}
          side={side}
          sideOffset={sideOffset}
          align={align}
          alignOffset={alignOffset}
          collisionPadding={8}
          loop
          onPointerDownOutside={(e) => {
            e.stopPropagation()
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            triggerRef.current?.focus({ preventScroll: true })
          }}
        >
          <div
            className="yolo-model-select-list yolo-chat-mode-select-list"
            role="menu"
            onKeyDown={handleListKeyDown}
          >
            {visibleOptions.map((option) => {
              const isSelected = option.value === mode
              if (
                showYoloControl &&
                option.value === yoloToggleOwnerMode(mode)
              ) {
                return (
                  <div
                    key={option.value}
                    role="menuitemradio"
                    tabIndex={0}
                    aria-checked={isSelected}
                    className="yolo-popover-item yolo-chat-mode-agent-card"
                    data-mode={option.value}
                    data-state={isSelected ? 'checked' : 'unchecked'}
                    ref={(element) => {
                      itemRefs.current[option.value] = element
                    }}
                    onClick={() => selectMode(option.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        selectMode(option.value)
                      }
                    }}
                  >
                    <span className="yolo-chat-mode-select-item__icon">
                      {option.icon}
                    </span>
                    <span className="yolo-chat-mode-select-item__content">
                      <span className="yolo-chat-mode-agent-card__title-row">
                        <span className="yolo-chat-mode-select-item__label">
                          {t(option.labelKey, option.labelFallback)}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={yoloEnabled}
                          data-active={yoloEnabled}
                          ref={(element) => {
                            itemRefs.current.yolo = element
                          }}
                          className="yolo-chat-mode-yolo-toggle"
                          title={t(
                            'chatMode.yoloDesc',
                            'Auto-approve tool calls for complex tasks',
                          )}
                          onClick={(event) => {
                            event.stopPropagation()
                            handleYoloToggle()
                          }}
                        >
                          <span className="yolo-chat-mode-yolo-toggle__label">
                            {t('chatMode.yolo', 'YOLO')}
                          </span>
                          <span
                            className="yolo-chat-mode-yolo-toggle__switch"
                            aria-hidden="true"
                          >
                            <span className="yolo-chat-mode-yolo-toggle__thumb" />
                          </span>
                        </button>
                      </span>
                      <span className="yolo-chat-mode-select-item__desc">
                        {t(option.descKey, option.descFallback)}
                      </span>
                    </span>
                  </div>
                )
              }

              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  data-mode={option.value}
                  data-state={isSelected ? 'checked' : 'unchecked'}
                  ref={(element) => {
                    itemRefs.current[option.value] = element
                  }}
                  className="yolo-popover-item yolo-chat-mode-select-item"
                  onClick={() => selectMode(option.value)}
                >
                  <span className="yolo-chat-mode-select-item__icon">
                    {option.icon}
                  </span>
                  <span className="yolo-chat-mode-select-item__content">
                    <span className="yolo-chat-mode-select-item__label">
                      {t(option.labelKey, option.labelFallback)}
                    </span>
                    <span className="yolo-chat-mode-select-item__desc">
                      {t(option.descKey, option.descFallback)}
                    </span>
                  </span>
                </button>
              )
            })}
            {visibleModuleOptions.map((option) => {
              const isSelected = option.value === mode
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  data-mode={option.value}
                  data-state={isSelected ? 'checked' : 'unchecked'}
                  ref={(element) => {
                    itemRefs.current[option.value] = element
                  }}
                  className="yolo-popover-item yolo-chat-mode-select-item"
                  onClick={() => selectMode(option.value)}
                >
                  <span className="yolo-chat-mode-select-item__icon">
                    <ObsidianIcon name={option.icon} />
                  </span>
                  <span className="yolo-chat-mode-select-item__content">
                    <span className="yolo-chat-mode-select-item__label">
                      {option.label}
                    </span>
                    {option.description ? (
                      <span className="yolo-chat-mode-select-item__desc">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        </YoloDropdownContent>
      </DropdownMenu.Root>
    )
  },
)

ChatModeSelect.displayName = 'ChatModeSelect'
