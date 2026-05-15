import { ToggleComponent } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

type ObsidianToggleProps = {
  value: boolean
  onChange: (value: boolean) => void
}

export function ObsidianToggle({ value, onChange }: ObsidianToggleProps) {
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

  useEffect(() => {
    if (!toggleComponent) return
    isSyncingRef.current = true
    toggleComponent.setValue(value)
    queueMicrotask(() => {
      isSyncingRef.current = false
    })
  }, [toggleComponent, value])

  return <div ref={containerRef} className="yolo-display-contents" />
}
