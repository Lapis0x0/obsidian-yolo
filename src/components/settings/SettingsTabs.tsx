import { App } from 'obsidian'
import React, {
  type FC,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { useLanguage } from '../../contexts/language-context'
import type YoloPlugin from '../../main'
import { SETTINGS_ACTIVE_TAB_STORAGE_KEY } from '../../utils/openPluginSettingsTab'

import { AgentTab } from './tabs/AgentTab'
import { EditorTab } from './tabs/EditorTab'
import { KnowledgeTab } from './tabs/KnowledgeTab'
import { ModelsTab } from './tabs/ModelsTab'
import { ModulesTab } from './tabs/ModulesTab'
import { OthersTab } from './tabs/OthersTab'

type SettingsTabsProps = {
  app: App
  plugin: YoloPlugin
}

export type SettingsTabId =
  | 'models'
  | 'editor'
  | 'knowledge'
  | 'modules'
  | 'agent'
  | 'others'

type SettingsTab = {
  id: SettingsTabId
  labelKey: string
  component?: FC<SettingsTabsProps>
}

const SETTINGS_TABS: SettingsTab[] = [
  {
    id: 'models',
    labelKey: 'settings.tabs.models',
    component: ModelsTab,
  },
  {
    id: 'agent',
    labelKey: 'settings.tabs.agent',
    component: AgentTab,
  },
  {
    id: 'editor',
    labelKey: 'settings.tabs.editor',
    component: EditorTab,
  },
  {
    id: 'knowledge',
    labelKey: 'settings.tabs.knowledge',
    component: KnowledgeTab,
  },
  {
    id: 'modules',
    labelKey: 'settings.tabs.modules',
  },
  {
    id: 'others',
    labelKey: 'settings.tabs.others',
    component: OthersTab,
  },
]

const STORAGE_KEY = SETTINGS_ACTIVE_TAB_STORAGE_KEY

export function SettingsTabs({ app, plugin }: SettingsTabsProps) {
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() => {
    // Load from localStorage
    const stored = app.loadLocalStorage(STORAGE_KEY)
    if (stored === 'tools') {
      return 'agent'
    }
    if (stored === 'chat') {
      return 'editor'
    }
    if (stored && SETTINGS_TABS.some((tab) => tab.id === stored)) {
      return stored as SettingsTabId
    }
    return 'models'
  })
  // 内容入场方向：与 glider 的滑动方向一致，让内容读起来是「跟着指示器走」。
  const [enterDirection, setEnterDirection] = useState<'forward' | 'backward'>(
    'forward',
  )
  const registry = plugin.getModuleSettingsContributionRegistry()
  const moduleSettings = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  )
  useEffect(() => {
    // Save to localStorage when tab changes
    void app.saveLocalStorage(STORAGE_KEY, activeTab)
  }, [activeTab])

  const ActiveComponent =
    SETTINGS_TABS.find((tab) => tab.id === activeTab)?.component || ModelsTab

  const activeTabIndex = SETTINGS_TABS.findIndex((tab) => tab.id === activeTab)
  const activeTabIndexRef = useRef(activeTabIndex)
  const navRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const selectTab = (tabId: SettingsTabId, index: number) => {
    if (tabId === activeTab) {
      return
    }
    setEnterDirection(index > activeTabIndex ? 'forward' : 'backward')
    setActiveTab(tabId)
  }

  useLayoutEffect(() => {
    // 换 tab 等于换了一份内容，滚动位置必须回到顶部；否则新内容会从上一个
    // tab 停留的偏移处开始显示，比缺少动效更割裂。
    contentRef.current?.scrollTo({ top: 0 })
  }, [activeTab])

  const updateGlider = () => {
    const nav = navRef.current
    const index = activeTabIndexRef.current
    const activeButton = tabRefs.current[index]
    if (!nav || !activeButton) {
      return
    }

    nav.style.setProperty(
      '--yolo-tab-glider-left',
      `${activeButton.offsetLeft}px`,
    )
    nav.style.setProperty(
      '--yolo-tab-glider-top',
      `${activeButton.offsetTop}px`,
    )
    nav.style.setProperty(
      '--yolo-tab-glider-width',
      `${activeButton.offsetWidth}px`,
    )
    nav.style.setProperty(
      '--yolo-tab-glider-height',
      `${activeButton.offsetHeight}px`,
    )
  }

  useLayoutEffect(() => {
    activeTabIndexRef.current = activeTabIndex
    updateGlider()
  }, [activeTabIndex])

  useEffect(() => {
    const nav = navRef.current
    if (!nav) {
      return
    }

    if (typeof ResizeObserver === 'undefined') {
      updateGlider()
      return
    }

    const observer = new ResizeObserver(() => updateGlider())
    observer.observe(nav)
    tabRefs.current.forEach((button) => {
      if (button) {
        observer.observe(button)
      }
    })

    return () => observer.disconnect()
  }, [])

  return (
    <div className="yolo-settings-tabs-container">
      <div
        className="yolo-settings-tabs-nav yolo-settings-tabs-nav--glider"
        role="tablist"
        ref={navRef}
        style={
          {
            '--yolo-tab-count': SETTINGS_TABS.length,
            '--yolo-tab-index': activeTabIndex,
          } as React.CSSProperties
        }
      >
        <div className="yolo-settings-tabs-glider" aria-hidden="true" />
        {SETTINGS_TABS.map((tab, index) => (
          <button
            key={tab.id}
            className={`yolo-settings-tab-button ${
              activeTab === tab.id ? 'is-active' : ''
            }`}
            onClick={() => selectTab(tab.id, index)}
            role="tab"
            aria-selected={activeTab === tab.id}
            ref={(element) => {
              tabRefs.current[index] = element
            }}
          >
            <span className="yolo-settings-tab-label">{t(tab.labelKey)}</span>
          </button>
        ))}
      </div>
      <div className="yolo-settings-tabs-content" ref={contentRef}>
        {/* key 让每次换 tab 重新挂载容器，入场动画得以重放。 */}
        <div
          key={activeTab}
          className="yolo-settings-tabs-body"
          data-enter-direction={enterDirection}
        >
          {activeTab === 'modules' ? (
            <ModulesTab
              service={plugin.getModuleService()}
              runtimeComponents={plugin.getRuntimeComponentService()}
              registrations={moduleSettings}
            />
          ) : (
            <ActiveComponent app={app} plugin={plugin} />
          )}
        </div>
      </div>
    </div>
  )
}
