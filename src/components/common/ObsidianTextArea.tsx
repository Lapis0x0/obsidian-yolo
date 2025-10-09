import { TextAreaComponent } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

type ObsidianTextAreaProps = {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  containerClassName?: string
  inputClassName?: string
  autoFocus?: boolean
  onKeyDown?: (ev: KeyboardEvent) => void
  disabled?: boolean
}

export function ObsidianTextArea({
  value,
  placeholder,
  onChange,
  containerClassName,
  inputClassName,
  autoFocus,
  onKeyDown,
  disabled = false,
}: ObsidianTextAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { setting } = useObsidianSetting()
  const [textAreaComponent, setTextAreaComponent] =
    useState<TextAreaComponent | null>(null)
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    if (setting) {
      let newTextAreaComponent: TextAreaComponent | null = null
      setting.addTextArea((component) => {
        newTextAreaComponent = component
      })
      setTextAreaComponent(newTextAreaComponent)

      return () => {
        newTextAreaComponent?.inputEl.remove()
      }
    } else if (containerRef.current) {
      const newTextAreaComponent = new TextAreaComponent(containerRef.current)
      setTextAreaComponent(newTextAreaComponent)

      return () => {
        newTextAreaComponent?.inputEl.remove()
      }
    }
  }, [setting])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!textAreaComponent) return
    textAreaComponent.onChange((v) => onChangeRef.current(v))
  }, [textAreaComponent])

  useEffect(() => {
    if (!textAreaComponent) return
    if (placeholder) textAreaComponent.setPlaceholder(placeholder)
    textAreaComponent.setValue(value)
    textAreaComponent.inputEl.disabled = !!disabled
  }, [textAreaComponent, value, placeholder, disabled])

  // Apply input class for theming instead of inline styles
  useEffect(() => {
    if (!textAreaComponent) return
    if (inputClassName) textAreaComponent.inputEl.classList.add(inputClassName)
  }, [textAreaComponent, inputClassName])

  // Auto focus when required
  useEffect(() => {
    if (!textAreaComponent) return
    if (autoFocus) {
      textAreaComponent.inputEl.focus()
      // move caret to end
      const el = textAreaComponent.inputEl
      const len = el.value.length
      try {
        el.setSelectionRange(len, len)
      } catch {}
    }
  }, [textAreaComponent, autoFocus])

  // Keydown handler binding
  useEffect(() => {
    if (!textAreaComponent || !onKeyDown) return
    const el = textAreaComponent.inputEl
    const handler = (e: KeyboardEvent) => onKeyDown(e)
    el.addEventListener('keydown', handler)
    return () => {
      el.removeEventListener('keydown', handler)
    }
  }, [textAreaComponent, onKeyDown])

  return (
    <div
      ref={containerRef}
      className={`smtcmp-textarea-container${containerClassName ? ' ' + containerClassName : ''}`}
    />
  )
}
