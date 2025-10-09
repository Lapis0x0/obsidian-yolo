import * as Popover from '@radix-ui/react-popover'
import { Check } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'

export function ChatModeDropdown({
  mode,
  onChange,
  showBruteOption = true,
  showLearningOption = true,
  learningEnabled,
  onToggleLearning,
  children,
}: {
  mode: 'rag' | 'brute'
  onChange: (m: 'rag' | 'brute') => void
  showBruteOption?: boolean
  showLearningOption?: boolean
  learningEnabled: boolean
  onToggleLearning: (enabled: boolean) => void
  children: React.ReactNode
}) {
  const { t } = useLanguage()
  type ModeKey = 'rag' | 'brute'
  type ModeItem = { key: ModeKey; label: string }
  const modeItems = useMemo<ModeItem[]>(
    () => [
      { key: 'rag', label: t('chat.modeRAG') ?? 'RAG' },
      ...(showBruteOption
        ? ([
            { key: 'brute', label: t('chat.modeBrute') ?? 'Brute' },
          ] as ModeItem[])
        : []),
    ],
    [showBruteOption, t],
  )

  const getIndexByMode = useCallback(
    (m: ModeKey) => {
      const idx = modeItems.findIndex((mi) => mi.key === m)
      return idx >= 0 ? idx : 0
    },
    [modeItems],
  )

  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState<number>(getIndexByMode(mode))

  useEffect(() => {
    setFocusedIndex(getIndexByMode(mode))
  }, [getIndexByMode, mode])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        setFocusedIndex(Math.max(0, focusedIndex - 1))
      } else if (e.key === 'ArrowDown') {
        setFocusedIndex(Math.min(modeItems.length - 1, focusedIndex + 1))
      } else if (e.key === 'Enter') {
        const idx = Math.max(0, Math.min(modeItems.length - 1, focusedIndex))
        onChange(modeItems[idx].key)
      }
    },
    [focusedIndex, onChange, modeItems],
  )

  const triggerAriaLabel = `${t('chat.modeTitle') ?? 'Chat mode'}: ${
    modeItems.find((m) => m.key === mode)?.label ?? ''
  }${learningEnabled ? `, ${t('chat.modeLearning') ?? 'Learning mode'} ON` : ''}`

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="clickable-icon" aria-label={triggerAriaLabel}>
          {children}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="smtcmp-popover smtcmp-chat-mode-dropdown-content"
          onKeyDown={handleKeyDown}
        >
          <ul>
            {modeItems.map((item, index) => (
              <li
                key={item.key}
                className={
                  (mode === item.key ? 'selected ' : '') +
                  (focusedIndex === index ? 'focused' : '')
                }
                role="menuitemradio"
                aria-checked={mode === item.key}
                onMouseEnter={() => setFocusedIndex(index)}
                onClick={() => {
                  onChange(item.key as 'rag' | 'brute')
                }}
              >
                <span className="smtcmp-popover-item-icon" aria-hidden="true">
                  {mode === item.key ? <Check size={14} /> : null}
                </span>
                <span>{item.label}</span>
              </li>
            ))}
            {showLearningOption && (
              <>
                <li className="smtcmp-divider" aria-hidden="true" />
                <li
                  onClick={() => {
                    onToggleLearning(!learningEnabled)
                  }}
                  className={learningEnabled ? 'selected' : ''}
                  aria-checked={learningEnabled}
                  role="menuitemcheckbox"
                >
                  <span className="smtcmp-popover-item-icon" aria-hidden="true">
                    {learningEnabled ? <Check size={14} /> : null}
                  </span>
                  <span>{t('chat.modeLearning') ?? 'Learning mode'}</span>
                </li>
              </>
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
