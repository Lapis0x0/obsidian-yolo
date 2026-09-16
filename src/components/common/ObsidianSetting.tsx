import { Setting } from 'obsidian'
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { classNames } from '../../utils/common/classnames'

type SettingContextValue = {
  setting: Setting | null
}

const SettingContext = createContext<SettingContextValue>({ setting: null })

type ObsidianSettingProps = {
  name?: string
  nameExtra?: React.ReactNode
  desc?: string
  /** 富文本描述（可含链接）。传入后接管描述区，`desc` 不再生效。 */
  descNode?: React.ReactNode
  heading?: boolean
  className?: string
  required?: boolean
  children?: React.ReactNode
}

export function ObsidianSetting({
  name,
  nameExtra,
  desc,
  descNode,
  heading,
  className,
  required,
  children,
}: ObsidianSettingProps) {
  const [setting, setSetting] = useState<Setting | null>(null)
  const [nameExtraContainer, setNameExtraContainer] =
    useState<HTMLElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const nameExtraContainerRef = useRef<HTMLElement | null>(null)
  const defaultSettingElClassName = useRef('')
  const defaultNameElClassName = useRef('')

  useEffect(() => {
    if (!containerRef.current) return

    const newSetting = new Setting(containerRef.current)
    setSetting(newSetting)
    defaultSettingElClassName.current = newSetting.settingEl.className
    defaultNameElClassName.current = newSetting.nameEl.className

    return () => {
      newSetting.clear()
    }
  }, [])

  useEffect(() => {
    if (!setting) return

    setting.setName(name ?? '')
    if (!descNode) setting.setDesc(desc ?? '')
    if (heading) setting.setHeading()
    setting.settingEl.setAttrs({
      class: classNames(defaultSettingElClassName.current, className ?? ''),
    })
    setting.nameEl.setAttrs({
      class: classNames(
        defaultNameElClassName.current,
        required ? 'yolo-settings-required' : '',
      ),
    })
  }, [name, desc, descNode, heading, className, setting, required])

  useEffect(() => {
    if (!setting || !nameExtra) {
      nameExtraContainerRef.current?.remove()
      nameExtraContainerRef.current = null
      setNameExtraContainer(null)
      setting?.nameEl.removeClass('yolo-setting-name-row')
      return
    }

    nameExtraContainerRef.current?.remove()
    const container = document.createElement('span')
    container.className = 'yolo-setting-name-extra'
    container.dataset.settingName = name ?? ''
    setting.nameEl.addClass('yolo-setting-name-row')
    setting.nameEl.appendChild(container)
    nameExtraContainerRef.current = container
    setNameExtraContainer(container)

    return () => {
      container.remove()
      if (nameExtraContainerRef.current === container) {
        nameExtraContainerRef.current = null
        setNameExtraContainer(null)
      }
      if (!setting.nameEl.querySelector('.yolo-setting-name-extra')) {
        setting.nameEl.removeClass('yolo-setting-name-row')
      }
    }
  }, [name, nameExtra, setting])

  return (
    <SettingContext.Provider value={{ setting }}>
      <div ref={containerRef}>
        {nameExtraContainer && nameExtra
          ? createPortal(nameExtra, nameExtraContainer)
          : null}
        {setting && descNode ? createPortal(descNode, setting.descEl) : null}
        {children}
      </div>
    </SettingContext.Provider>
  )
}

export const useObsidianSetting = () => {
  const context = useContext(SettingContext)
  if (!context) {
    throw new Error('useObsidianSetting must be used within ObsidianSetting')
  }
  return context
}
