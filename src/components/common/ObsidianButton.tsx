import { ButtonComponent, setIcon } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

type ObsidianButtonProps = {
  text?: string
  icon?: string
  tooltip?: string
  className?: string
  onClick: () => void
  cta?: boolean
  warning?: boolean
  disabled?: boolean
}

export function ObsidianButton({
  text,
  icon,
  tooltip,
  className,
  onClick,
  cta,
  warning,
  disabled,
}: ObsidianButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { setting } = useObsidianSetting()
  const [buttonComponent, setButtonComponent] =
    useState<ButtonComponent | null>(null)
  const onClickRef = useRef(onClick)

  useEffect(() => {
    if (setting) {
      let newButtonComponent: ButtonComponent | null = null
      setting.addButton((component) => {
        newButtonComponent = component
      })
      setButtonComponent(newButtonComponent)

      return () => {
        newButtonComponent?.buttonEl.remove()
      }
    } else if (containerRef.current) {
      const newButtonComponent = new ButtonComponent(containerRef.current)
      setButtonComponent(newButtonComponent)

      return () => {
        newButtonComponent?.buttonEl.remove()
      }
    }
  }, [setting])

  useEffect(() => {
    onClickRef.current = onClick
  }, [onClick])

  useEffect(() => {
    if (!buttonComponent) return
    buttonComponent.onClick(() => onClickRef.current())
  }, [buttonComponent])

  useEffect(() => {
    if (!buttonComponent) return

    if (icon && text) {
      // setIcon() 会清空按钮内容，图标和文字不能靠 setIcon + setButtonText 共存；
      // 各给一个 span 容器，间距由 .yolo-button-icon-text 负责。
      buttonComponent.buttonEl.empty()
      buttonComponent.buttonEl.addClass('yolo-button-icon-text')
      const iconEl = buttonComponent.buttonEl.createSpan({
        cls: 'yolo-button-icon',
      })
      setIcon(iconEl, icon)
      buttonComponent.buttonEl.createSpan({ text })
    } else {
      buttonComponent.buttonEl.removeClass('yolo-button-icon-text')
      if (text) buttonComponent.setButtonText(text)
      if (icon) buttonComponent.setIcon(icon)
    }
    if (tooltip) buttonComponent.setTooltip(tooltip)
    if (className) buttonComponent.buttonEl.addClass(className)
    if (cta) buttonComponent.setCta()
    else buttonComponent.buttonEl.removeClass('mod-cta')
    if (warning) buttonComponent.setWarning()
    else buttonComponent.buttonEl.removeClass('mod-warning')
    buttonComponent.setDisabled(!!disabled)
    return () => {
      if (className) buttonComponent.buttonEl.removeClass(className)
    }
  }, [buttonComponent, text, icon, tooltip, className, cta, warning, disabled])

  return <div ref={containerRef} />
}
