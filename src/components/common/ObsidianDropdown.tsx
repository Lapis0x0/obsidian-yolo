import { DropdownComponent } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

export type ObsidianDropdownOptionGroup = {
  label: string
  options: {
    value: string
    label: string
  }[]
}

type ObsidianDropdownProps = {
  value: string
  options?: Record<string, string>
  groupedOptions?: ObsidianDropdownOptionGroup[]
  onChange: (value: string) => void
  disabled?: boolean
}

export function ObsidianDropdown({
  value,
  options,
  groupedOptions,
  onChange,
  disabled = false,
}: ObsidianDropdownProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { setting } = useObsidianSetting()
  const [dropdownComponent, setDropdownComponent] =
    useState<DropdownComponent | null>(null)
  const onChangeRef = useRef(onChange)
  const isSyncingRef = useRef(false)

  useEffect(() => {
    if (setting) {
      let newDropdownComponent: DropdownComponent | null = null
      setting.addDropdown((component) => {
        newDropdownComponent = component
      })
      setDropdownComponent(newDropdownComponent)

      return () => {
        newDropdownComponent?.selectEl.remove()
      }
    } else if (containerRef.current) {
      const newDropdownComponent = new DropdownComponent(containerRef.current)
      setDropdownComponent(newDropdownComponent)

      return () => {
        newDropdownComponent?.selectEl.remove()
      }
    }
  }, [setting])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!dropdownComponent) return
    dropdownComponent.onChange((v) => {
      if (isSyncingRef.current) {
        return
      }
      onChangeRef.current(v)
    })
  }, [dropdownComponent])

  useEffect(() => {
    if (!dropdownComponent) return

    const selectEl = dropdownComponent.selectEl
    isSyncingRef.current = true
    selectEl.empty()

    if (groupedOptions && groupedOptions.length > 0) {
      groupedOptions.forEach((group) => {
        if (!group || group.options.length === 0) return
        const optgroupEl = document.createElement('optgroup')
        optgroupEl.label = group.label
        optgroupEl.classList.add('smtcmp-obsidian-dropdown-optgroup')
        group.options.forEach(({ value: optionValue, label: optionLabel }) => {
          const optionEl = document.createElement('option')
          optionEl.value = optionValue
          optionEl.textContent = optionLabel
          optionEl.classList.add('smtcmp-obsidian-dropdown-option')
          optgroupEl.appendChild(optionEl)
        })
        selectEl.appendChild(optgroupEl)
      })
    } else {
      dropdownComponent.addOptions(options ?? {})
    }

    dropdownComponent.setValue(value)
    selectEl.disabled = !!disabled
    queueMicrotask(() => {
      isSyncingRef.current = false
    })
  }, [dropdownComponent, options, groupedOptions, value, disabled])

  return <div ref={containerRef} />
}
