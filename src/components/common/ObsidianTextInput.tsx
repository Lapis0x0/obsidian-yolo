import { TextComponent } from 'obsidian'
import { type HTMLAttributes, useEffect, useRef, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

type ObsidianTextInputProps = {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  onBlur?: (value: string) => void
  onFocus?: () => void
  type?: 'text' | 'number'
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode']
}

export function ObsidianTextInput({
  value,
  placeholder,
  onChange,
  onBlur,
  onFocus,
  type,
  inputMode,
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
    if (type) textComponent.inputEl.type = type
    if (inputMode !== undefined) {
      textComponent.inputEl.inputMode = inputMode
    }
  }, [textComponent, value, placeholder, type, inputMode])

  return <div ref={containerRef} />
}
