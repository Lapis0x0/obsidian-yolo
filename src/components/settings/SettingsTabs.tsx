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
import type {
  ModuleSettingsContributionRegistry,
  RegisteredModuleSettingsContributionV1,
} from '../../core/modules/moduleSettingsContributions'
import YoloPlugin from '../../main'

import { LearningSection } from './sections/LearningSection'
import { ModuleSettingsSection } from './sections/ModuleSettingsSection'
import { AgentTab } from './tabs/AgentTab'
import { EditorTab } from './tabs/EditorTab'
import { KnowledgeTab } from './tabs/KnowledgeTab'
import { LearningTab } from './tabs/LearningTab'
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
  | 'learning'
  | 'modules'
  | 'agent'
  | 'others'

type SettingsTab = {
  id: SettingsTabId
  labelKey: string
  component: FC<SettingsTabsProps>
}

const ModulesSettingsTab: FC<SettingsTabsProps> = ({ app, plugin }) => (
  <ModulesTab
    app={app}
    service={plugin.getModuleService()}
    removeLearningData={() => plugin.uninstallAndRemoveLearningData()}
  />
)

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
    id: 'learning',
    labelKey: 'settings.tabs.learning',
    component: LearningTab,
  },
  {
    id: 'modules',
    labelKey: 'settings.tabs.modules',
    component: ModulesSettingsTab,
  },
  {
    id: 'others',
    labelKey: 'settings.tabs.others',
    component: OthersTab,
  },
]

const STORAGE_KEY = 'yolo_settings_active_tab'

const EMPTY_MODULE_SETTINGS_SNAPSHOT: readonly RegisteredModuleSettingsContributionV1[] =
  Object.freeze([])
const EMPTY_MODULE_SETTINGS_REGISTRY = {
  getSnapshot: () => EMPTY_MODULE_SETTINGS_SNAPSHOT,
  subscribe: () => () => undefined,
}

export function partitionModuleSettings(
  registrations: readonly RegisteredModuleSettingsContributionV1[],
) {
  return {
    learning: registrations.filter(({ moduleId }) => moduleId === 'learning'),
    other: registrations.filter(({ moduleId }) => moduleId !== 'learning'),
  }
}

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
  const registry =
    (
      plugin as YoloPlugin & {
        getModuleSettingsContributionRegistry?: () => ModuleSettingsContributionRegistry
      }
    ).getModuleSettingsContributionRegistry?.() ??
    EMPTY_MODULE_SETTINGS_REGISTRY
  const moduleSettings = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  )
  const partitionedModuleSettings = partitionModuleSettings(moduleSettings)
  const learningHandoffState = useSyncExternalStore(
    (listener) => plugin.subscribeLearningModuleSettingsHandoff(listener),
    () => plugin.getLearningModuleSettingsHandoffState(),
    () => plugin.getLearningModuleSettingsHandoffState(),
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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

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
            onClick={() => setActiveTab(tab.id)}
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
      <div className="yolo-settings-tabs-content">
        {activeTab === 'learning' ? (
          <LearningSection
            moduleSettings={partitionedModuleSettings.learning}
            handoffState={learningHandoffState}
            retryHandoff={() => plugin.retryLearningModuleSettingsHandoff()}
          />
        ) : (
          <ActiveComponent app={app} plugin={plugin} />
        )}
        {activeTab === 'modules' &&
        partitionedModuleSettings.other.length > 0 ? (
          <ModuleSettingsSection
            registrations={partitionedModuleSettings.other}
          />
        ) : null}
      </div>
    </div>
  )
}
