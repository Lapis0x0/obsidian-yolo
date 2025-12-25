import { TextComponent } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

type ObsidianTextInputProps = {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  type?: 'text' | 'number'
  onKeyDown?: (e: KeyboardEvent) => void
  onBlur?: () => void
}

export function ObsidianTextInput({
  value,
  placeholder,
  onChange,
  type,
  onKeyDown,
  onBlur,
}: ObsidianTextInputProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { setting } = useObsidianSetting()
  const [textComponent, setTextComponent] = useState<TextComponent | null>(null)
  const onChangeRef = useRef(onChange)
  const onKeyDownRef = useRef(onKeyDown)
  const onBlurRef = useRef(onBlur)

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
    onKeyDownRef.current = onKeyDown
    onBlurRef.current = onBlur
  }, [onChange, onKeyDown, onBlur])

  useEffect(() => {
    if (!textComponent) return
    textComponent.onChange((v) => onChangeRef.current(v))
    
    // Add keyboard event listener
    const handleKeyDown = (e: KeyboardEvent) => {
      if (onKeyDownRef.current) {
        onKeyDownRef.current(e)
      }
    }
    
    // Add blur event listener
    const handleBlur = () => {
      if (onBlurRef.current) {
        onBlurRef.current()
      }
    }
    
    textComponent.inputEl.addEventListener('keydown', handleKeyDown)
    textComponent.inputEl.addEventListener('blur', handleBlur)
    
    return () => {
      textComponent.inputEl.removeEventListener('keydown', handleKeyDown)
      textComponent.inputEl.removeEventListener('blur', handleBlur)
    }
  }, [textComponent])

  useEffect(() => {
    if (!textComponent) return
    textComponent.setValue(value)
    if (placeholder) textComponent.setPlaceholder(placeholder)
    if (type) textComponent.inputEl.type = type
  }, [textComponent, value, placeholder, type])

  return <div ref={containerRef} />
}
