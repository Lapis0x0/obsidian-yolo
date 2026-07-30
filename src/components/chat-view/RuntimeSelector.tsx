import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Asterisk, Check, ChevronDown, SquareTerminal } from 'lucide-react'
import { useRef } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  type CliRuntimeId,
  isCliRuntimeAvailable,
} from '../../core/cli-runtime'
import { YoloDropdownContent } from '../common/popover'

export type RuntimeSelectorOption = {
  id: CliRuntimeId
  labelKey: string
  descriptionKey: string
}

const RUNTIME_OPTIONS: Record<CliRuntimeId, RuntimeSelectorOption> = {
  'claude-code': {
    id: 'claude-code',
    labelKey: 'sidebar.runtimeSelector.claudeCodeLabel',
    descriptionKey: 'sidebar.runtimeSelector.claudeCodeDescription',
  },
  codex: {
    id: 'codex',
    labelKey: 'sidebar.runtimeSelector.codexLabel',
    descriptionKey: 'sidebar.runtimeSelector.codexDescription',
  },
}

const CLI_RUNTIME_IDS: readonly CliRuntimeId[] = ['claude-code', 'codex']

export const getRuntimeSelectorOptions = (
  cliRuntimeAvailable: boolean,
): readonly RuntimeSelectorOption[] =>
  cliRuntimeAvailable
    ? CLI_RUNTIME_IDS.map((runtimeId) => RUNTIME_OPTIONS[runtimeId])
    : []

export const resolveAvailableRuntimeId = (
  value: string,
  cliRuntimeAvailable: boolean,
): CliRuntimeId | undefined =>
  getRuntimeSelectorOptions(cliRuntimeAvailable).find(
    (option) => option.id === value,
  )?.id

export type RuntimeSelectorProps = {
  currentRuntimeId: CliRuntimeId
  onRuntimeChange: (runtimeId: CliRuntimeId) => void
  disabled?: boolean
  className?: string
}

const RuntimeIcon = ({ runtimeId }: { runtimeId: CliRuntimeId }) => {
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
