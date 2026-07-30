import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Asterisk,
  Check,
  ChevronDown,
  MessageCircle,
  SquareTerminal,
} from 'lucide-react'
import { useRef } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  type ChatRuntimeId,
  isCliRuntimeAvailable,
} from '../../core/cli-runtime'
import { YoloDropdownContent } from '../common/popover'

type RuntimeKind = 'chat' | 'cli'

export type RuntimeSelectorOption = {
  id: ChatRuntimeId
  kind: RuntimeKind
  labelKey: string
  descriptionKey: string
}

const RUNTIME_OPTIONS: Record<ChatRuntimeId, RuntimeSelectorOption> = {
  yolo: {
    id: 'yolo',
    kind: 'chat',
    labelKey: 'sidebar.runtimeSelector.yoloLabel',
    descriptionKey: 'sidebar.runtimeSelector.yoloDescription',
  },
  'claude-code': {
    id: 'claude-code',
    kind: 'cli',
    labelKey: 'sidebar.runtimeSelector.claudeCodeLabel',
    descriptionKey: 'sidebar.runtimeSelector.claudeCodeDescription',
  },
  codex: {
    id: 'codex',
    kind: 'cli',
    labelKey: 'sidebar.runtimeSelector.codexLabel',
    descriptionKey: 'sidebar.runtimeSelector.codexDescription',
  },
}

const DESKTOP_RUNTIME_IDS: readonly ChatRuntimeId[] = [
  'yolo',
  'claude-code',
  'codex',
]
const MOBILE_RUNTIME_IDS: readonly ChatRuntimeId[] = ['yolo']

export const getRuntimeSelectorOptions = (
  cliRuntimeAvailable: boolean,
): readonly RuntimeSelectorOption[] =>
  (cliRuntimeAvailable ? DESKTOP_RUNTIME_IDS : MOBILE_RUNTIME_IDS).map(
    (runtimeId) => RUNTIME_OPTIONS[runtimeId],
  )

export const resolveAvailableRuntimeId = (
  value: string,
  cliRuntimeAvailable: boolean,
): ChatRuntimeId | undefined =>
  getRuntimeSelectorOptions(cliRuntimeAvailable).find(
    (option) => option.id === value,
  )?.id

export type RuntimeSelectorProps = {
  currentRuntimeId: ChatRuntimeId
  onRuntimeChange: (runtimeId: ChatRuntimeId) => void
  disabled?: boolean
  className?: string
}

const RuntimeIcon = ({ runtimeId }: { runtimeId: ChatRuntimeId }) => {
  if (runtimeId === 'yolo') {
    return <MessageCircle size={15} strokeWidth={2} />
  }
  if (runtimeId === 'claude-code') {
    return <Asterisk size={15} strokeWidth={2} />
  }
  return <SquareTerminal size={15} strokeWidth={2} />
}

export function RuntimeSelector({
  currentRuntimeId,
  onRuntimeChange,
  disabled = false,
  className,
}: RuntimeSelectorProps) {
  const { t } = useLanguage()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const cliRuntimeAvailable = isCliRuntimeAvailable()

  if (!cliRuntimeAvailable) {
    return null
  }

  const availableOptions = getRuntimeSelectorOptions(cliRuntimeAvailable)
  const currentOption = RUNTIME_OPTIONS[currentRuntimeId]
  const currentLabel = t(currentOption.labelKey)
  const currentBadge = t(
    currentOption.kind === 'chat'
      ? 'sidebar.runtimeSelector.chatBadge'
      : 'sidebar.runtimeSelector.cliBadge',
  )
  const accessibleLabel = t('sidebar.runtimeSelector.accessibleLabel').replace(
    '{runtime}',
    currentLabel,
  )

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        ref={triggerRef}
        type="button"
        className={`yolo-runtime-selector${className ? ` ${className}` : ''}`}
        disabled={disabled}
        aria-label={accessibleLabel}
        data-runtime-id={currentRuntimeId}
      >
        <span className="yolo-runtime-selector__icon" aria-hidden="true">
          <RuntimeIcon runtimeId={currentOption.id} />
        </span>
        <span className="yolo-runtime-selector__label">{currentLabel}</span>
        <span className="yolo-runtime-selector__badge">{currentBadge}</span>
        <ChevronDown
          className="yolo-runtime-selector__chevron"
          size={13}
          strokeWidth={2.2}
          aria-hidden="true"
        />
      </DropdownMenu.Trigger>

      <YoloDropdownContent
        anchorRef={triggerRef}
        variant="default"
        minWidth={224}
        maxWidth={280}
        maxHeight={320}
        className="yolo-runtime-selector__content"
        side="bottom"
        sideOffset={6}
        align="start"
        collisionPadding={8}
        loop
      >
        <DropdownMenu.RadioGroup
          className="yolo-model-select-list yolo-runtime-selector__list"
          value={currentRuntimeId}
          aria-label={t('sidebar.runtimeSelector.menuLabel')}
          onValueChange={(value) => {
            const runtimeId = resolveAvailableRuntimeId(
              value,
              cliRuntimeAvailable,
            )
            if (runtimeId && runtimeId !== currentRuntimeId) {
              onRuntimeChange(runtimeId)
            }
          }}
        >
          {availableOptions.map((option) => {
            const badge = t(
              option.kind === 'chat'
                ? 'sidebar.runtimeSelector.chatBadge'
                : 'sidebar.runtimeSelector.cliBadge',
            )
            return (
              <DropdownMenu.RadioItem
                key={option.id}
                value={option.id}
                className="yolo-popover-item yolo-runtime-selector__option"
                data-runtime-id={option.id}
              >
                <span
                  className="yolo-runtime-selector__option-icon"
                  aria-hidden="true"
                >
                  <RuntimeIcon runtimeId={option.id} />
                </span>
                <span className="yolo-runtime-selector__option-copy">
                  <span className="yolo-runtime-selector__option-heading">
                    <span className="yolo-runtime-selector__option-label">
                      {t(option.labelKey)}
                    </span>
                    <span className="yolo-runtime-selector__badge">
                      {badge}
                    </span>
                  </span>
                  <span className="yolo-runtime-selector__option-description">
                    {t(option.descriptionKey)}
                  </span>
                </span>
                <DropdownMenu.ItemIndicator className="yolo-popover-item__indicator">
                  <Check size={12} aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            )
          })}
        </DropdownMenu.RadioGroup>
      </YoloDropdownContent>
    </DropdownMenu.Root>
  )
}
