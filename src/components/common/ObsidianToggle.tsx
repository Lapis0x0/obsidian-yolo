import { ToggleComponent } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

type ObsidianToggleProps = {
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}

export function ObsidianToggle({
  value,
  onChange,
  disabled,
  ariaLabel,
}: ObsidianToggleProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { setting } = useObsidianSetting()
  const [toggleComponent, setToggleComponent] =
    useState<ToggleComponent | null>(null)
  const onChangeRef = useRef(onChange)
  const isSyncingRef = useRef(false)

  useEffect(() => {
    if (setting) {
      let newToggleComponent: ToggleComponent | null = null
      setting.addToggle((component) => {
        newToggleComponent = component
        newToggleComponent?.toggleEl.addClass('yolo-checkbox-container')
      })
      setToggleComponent(newToggleComponent)

      return () => {
        newToggleComponent?.toggleEl.remove()
      }
    } else if (containerRef.current) {
      const newToggleComponent = new ToggleComponent(containerRef.current)
      newToggleComponent.toggleEl.addClass('yolo-checkbox-container')
      setToggleComponent(newToggleComponent)

      return () => {
        newToggleComponent?.toggleEl.remove()
      }
    }
  }, [setting])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!toggleComponent) return
    toggleComponent.onChange((v) => {
      if (isSyncingRef.current) {
        return
      }
      onChangeRef.current(v)
    })
  }, [toggleComponent])

  // Re-sync the underlying Obsidian ToggleComponent on every render. This
  // matters when the user toggles, the parent receives `onChange(v)` but
  // chooses NOT to commit the change (e.g., gates it behind a confirmation
  // modal). The React `value` prop stays the same, so a dependency-checked
  // effect would skip — leaving the DOM toggle visually drifted from the
  // source of truth. Checking `getValue()` first keeps this cheap when in sync.
  useEffect(() => {
    if (!toggleComponent) return
    if (toggleComponent.getValue() === value) return
    isSyncingRef.current = true
    toggleComponent.setValue(value)
    queueMicrotask(() => {
      isSyncingRef.current = false
    })
  })

  useEffect(() => {
    if (!toggleComponent) return
    toggleComponent.setDisabled(!!disabled)
    // setDisabled only sets the flag; visually nothing changes unless the
    // theme has a rule. Toggle .is-disabled so styles/chat/input.css
    // (.yolo-checkbox-container.is-disabled) can dim and block clicks.
    toggleComponent.toggleEl.toggleClass('is-disabled', !!disabled)
  }, [toggleComponent, disabled])

  useEffect(() => {
    if (!toggleComponent) return
    if (ariaLabel) {
      toggleComponent.toggleEl.setAttribute('aria-label', ariaLabel)
    } else {
      toggleComponent.toggleEl.removeAttribute('aria-label')
    }
  }, [toggleComponent, ariaLabel])

  return <div ref={containerRef} className="yolo-display-contents" />
}
