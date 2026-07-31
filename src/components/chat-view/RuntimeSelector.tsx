import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import { useId, useRef } from 'react'

import anthropicLogo from '../../assets/provider-icons/anthropic.svg'
import openaiLogo from '../../assets/provider-icons/openai.svg'
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
const RUNTIME_LOGOS: Record<
  CliRuntimeId,
  { src: string; provider: 'anthropic' | 'openai' }
> = {
  'claude-code': { src: anthropicLogo, provider: 'anthropic' },
  codex: { src: openaiLogo, provider: 'openai' },
}

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
  const logo = RUNTIME_LOGOS[runtimeId]
  return (
    <img
      className="yolo-runtime-selector__provider-logo"
      src={logo.src}
      alt=""
      draggable={false}
      data-provider={logo.provider}
    />
  )
}

export function RuntimeSelector({
  currentRuntimeId,
  onRuntimeChange,
  disabled = false,
  className,
}: RuntimeSelectorProps) {
  const { t } = useLanguage()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuLabelId = useId()
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
        <DropdownMenu.Label id={menuLabelId} className="yolo-sr-only">
          {t('sidebar.runtimeSelector.menuLabel')}
        </DropdownMenu.Label>
        <DropdownMenu.RadioGroup
          className="yolo-model-select-list yolo-runtime-selector__list"
          value={currentRuntimeId}
          aria-labelledby={menuLabelId}
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
                  <span className="yolo-runtime-selector__option-label">
                    {t(option.labelKey)}
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
