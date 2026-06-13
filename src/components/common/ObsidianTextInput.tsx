import { TextComponent } from 'obsidian'
import { type InputHTMLAttributes, useEffect, useRef, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

type ObsidianTextInputProps = {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  onBlur?: (value: string) => void
  onFocus?: () => void
  type?: 'text' | 'number'
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode']
  min?: InputHTMLAttributes<HTMLInputElement>['min']
  max?: InputHTMLAttributes<HTMLInputElement>['max']
  step?: InputHTMLAttributes<HTMLInputElement>['step']
  disabled?: boolean
}

export function ObsidianTextInput({
  value,
  placeholder,
  onChange,
  onBlur,
  onFocus,
  type,
  inputMode,
  min,
  max,
  step,
  disabled,
}: ObsidianTextInputProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { setting } = useObsidianSetting()
  const [textComponent, setTextComponent] = useState<TextComponent | null>(null)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const onFocusRef = useRef(onFocus)

  useEffect(() => {
    if (setting) {
      let newTextComponent: TextComponent | null = null
      setting.addText((component) => {
        newTextComponent = component
      })
      setTextComponent(newTextComponent)

      return () => {
        newTextComponent?.inputEl.remove()
      }
    } else if (containerRef.current) {
      const newTextComponent = new TextComponent(containerRef.current)
      setTextComponent(newTextComponent)

      return () => {
        newTextComponent?.inputEl.remove()
      }
    }
  }, [setting])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onBlurRef.current = onBlur
  }, [onBlur])

  useEffect(() => {
    onFocusRef.current = onFocus
  }, [onFocus])

  useEffect(() => {
    if (!textComponent) return
    textComponent.onChange((v) => onChangeRef.current(v))
  }, [textComponent])

  useEffect(() => {
    if (!textComponent || !onBlurRef.current) return
    const handler = () => {
      onBlurRef.current?.(textComponent.getValue())
    }
    textComponent.inputEl.addEventListener('blur', handler)
    return () => {
      textComponent.inputEl.removeEventListener('blur', handler)
    }
  }, [textComponent])

  useEffect(() => {
    if (!textComponent) return
    const handler = () => {
      onFocusRef.current?.()
    }
    textComponent.inputEl.addEventListener('focus', handler)
    return () => {
      textComponent.inputEl.removeEventListener('focus', handler)
    }
  }, [textComponent])

  useEffect(() => {
    if (!textComponent) return
    textComponent.setValue(value)
    if (placeholder) textComponent.setPlaceholder(placeholder)
    textComponent.inputEl.type = type ?? 'text'
    if (inputMode !== undefined) {
      textComponent.inputEl.inputMode = inputMode
    }
    if (min !== undefined) textComponent.inputEl.min = String(min)
    else textComponent.inputEl.removeAttribute('min')
    if (max !== undefined) textComponent.inputEl.max = String(max)
    else textComponent.inputEl.removeAttribute('max')
    if (step !== undefined) textComponent.inputEl.step = String(step)
    else textComponent.inputEl.removeAttribute('step')
    textComponent.setDisabled(!!disabled)
  }, [
    textComponent,
    value,
    placeholder,
    type,
    inputMode,
    min,
    max,
    step,
    disabled,
  ])

  return <div ref={containerRef} />
}
