import { EditorView, WidgetType } from '@codemirror/view'
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $nodesOfType,
  LexicalEditor,
  LexicalNode,
  SerializedEditorState,
} from 'lexical'
import {
  Brain,
  FileText,
  Globe,
  Lightbulb,
  Link,
  ListTodo,
  MessageCircle,
  PenLine,
  Sparkles,
  Table,
  Workflow,
} from 'lucide-react'
import { Editor } from 'obsidian'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Root, createRoot } from 'react-dom/client'

import { AppProvider } from '../../contexts/app-context'
import { LanguageProvider, useLanguage } from '../../contexts/language-context'
import { PluginProvider, usePlugin } from '../../contexts/plugin-context'
import { SettingsProvider, useSettings } from '../../contexts/settings-context'
import { getChatModelClient } from '../../core/llm/manager'
import SmartComposerPlugin from '../../main'
import { MentionableFile, MentionableFolder } from '../../types/mentionable'
import {
  deserializeMentionable,
  getMentionableKey,
  serializeMentionable,
} from '../../utils/chat/mentionable'
import {
  clearDynamicStyleClass,
  updateDynamicStyleClass,
} from '../../utils/dom/dynamicStyleManager'
import { fuzzySearch } from '../../utils/fuzzy-search'
import LexicalContentEditable from '../chat-view/chat-input/LexicalContentEditable'
import { ModelSelect } from '../chat-view/chat-input/ModelSelect'
import { MentionNode } from '../chat-view/chat-input/plugins/mention/MentionNode'
import { NodeMutations } from '../chat-view/chat-input/plugins/on-mutation/OnMutationPlugin'

type SmartSpacePanelProps = {
  editor: Editor
  onClose: () => void
  showQuickActions?: boolean // Whether to show quick action buttons
  onOverlayStateChange?: (isOverlayActive: boolean) => void
}

type SmartSpaceMentionable = MentionableFile | MentionableFolder

function SmartSpacePanelBody({
  editor,
  onClose,
  showQuickActions = true,
  containerRef,
  onOverlayStateChange,
}: SmartSpacePanelProps & {
  containerRef?: React.RefObject<HTMLDivElement>
}) {
  const plugin = usePlugin()
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const draftState = useMemo(() => plugin.getSmartSpaceDraftState(), [plugin])
  const initialMentionables = useMemo(() => {
    if (!draftState?.mentionables || draftState.mentionables.length === 0) {
      return []
    }
    const hydrated: SmartSpaceMentionable[] = []
    for (const serialized of draftState.mentionables) {
      const mentionable = deserializeMentionable(serialized, plugin.app)
      if (
        mentionable &&
        (mentionable.type === 'file' || mentionable.type === 'folder')
      ) {
        hydrated.push(mentionable)
      }
    }
    return hydrated
  }, [draftState, plugin.app])
  const initialInstructionText = draftState?.instructionText ?? ''
  const initialEditorState = draftState?.editorState ?? null
  const contentEditableRef = useRef<HTMLDivElement>(null)
  const lexicalEditorRef = useRef<LexicalEditor | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const inputCardRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const localContainerRef = useRef<HTMLDivElement>(null)
  const resolvedContainerRef = containerRef ?? localContainerRef
  const modelSelectRef = useRef<HTMLButtonElement>(null)
  const webSearchButtonRef = useRef<HTMLButtonElement>(null)
  const urlContextButtonRef = useRef<HTMLButtonElement>(null)
  const [instructionText, setInstructionText] = useState(initialInstructionText)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [useWebSearch, setUseWebSearch] = useState(
    settings?.continuationOptions?.smartSpaceUseWebSearch ?? false,
  )
  const [useUrlContext, setUseUrlContext] = useState(
    settings?.continuationOptions?.smartSpaceUseUrlContext ?? false,
  )
  const [isSubmitConfirmPending, setIsSubmitConfirmPending] = useState(false)
  const [selectedModelId, setSelectedModelId] = useState<string>(
    settings?.continuationOptions?.continuationModelId ??
      settings?.chatModelId ??
      '',
  )
  const [mentionables, setMentionables] = useState<SmartSpaceMentionable[]>(
    () => initialMentionables,
  )
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false)
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false)
  const [mentionMenuPlacement, setMentionMenuPlacement] = useState<
    'top' | 'bottom'
  >('top')
  const [quickActionsPlacement, setQuickActionsPlacement] = useState<
    'top' | 'bottom'
  >('bottom')
  const quickActionsPlacementRef = useRef<'top' | 'bottom'>('bottom')
  const quickActionsPlacementLockedRef = useRef(false)
  const quickActionsHasInitializedRef = useRef(false)
  const quickActionsLayoutRafIdRef = useRef<number | null>(null)
  const quickActionsLayoutRafId2Ref = useRef<number | null>(null)
  const [isQuickActionsLayoutReady, setIsQuickActionsLayoutReady] =
    useState(false)
  const [quickActionsOffset, setQuickActionsOffset] = useState<number>(0)
  const [quickActionsMaxHeight, setQuickActionsMaxHeight] = useState<number>(0)
  const [isMultilineInput, setIsMultilineInput] = useState(false)
  const [isKeyboardNavigationActive, setIsKeyboardNavigationActive] =
    useState(false)
  const latestInstructionTextRef = useRef(initialInstructionText)
  const latestMentionablesRef =
    useRef<SmartSpaceMentionable[]>(initialMentionables)
  const latestEditorStateRef = useRef<SerializedEditorState | null>(
    initialEditorState,
  )
  const shouldPersistDraftRef = useRef(true)
  const initialEditorStateCallback = useMemo(() => {
    if (!initialEditorState) {
      return undefined
    }
    return (editor: LexicalEditor) => {
      try {
        editor.setEditorState(editor.parseEditorState(initialEditorState))
        editor.update(() => {
          $getRoot().selectEnd()
        })
      } catch (error) {
        console.error('Failed to restore Smart Space draft', error)
      }
    }
  }, [initialEditorState])
  const hasRestoredDraftSelectionRef = useRef(false)
  const prevModelMenuOpenRef = useRef(isModelMenuOpen)

  const derivedModelId =
    settings?.continuationOptions?.continuationModelId ??
    settings?.chatModelId ??
    ''

  const derivedUseWebSearch =
    settings?.continuationOptions?.smartSpaceUseWebSearch ?? false
  const derivedUseUrlContext =
    settings?.continuationOptions?.smartSpaceUseUrlContext ?? false
  const hasBlockingOverlay = isMentionMenuOpen || isModelMenuOpen
  const activateKeyboardNavigation = useCallback(() => {
    setIsKeyboardNavigationActive((prev) => (prev ? prev : true))
  }, [])
  const deactivateKeyboardNavigation = useCallback(() => {
    setIsKeyboardNavigationActive((prev) => (prev ? false : prev))
  }, [])

  useEffect(() => {
    contentEditableRef.current?.focus()
  }, [])

  useEffect(() => {
    lexicalEditorRef.current?.setEditable(!isSubmitting)
  }, [isSubmitting])

  useEffect(() => {
    const element = contentEditableRef.current
    if (!element) return

    const computeIsMultiline = () => {
      if (!element.childNodes.length) {
        setIsMultilineInput(false)
        return
      }

      const range = document.createRange()
      range.selectNodeContents(element)
      const rects = Array.from(range.getClientRects()).filter(
        // filter out zero-height rects created by empty nodes
        (rect) => rect.height > 0 && rect.width > 0,
      )

      if (rects.length === 0) {
        setIsMultilineInput(false)
        return
      }

      const tolerance = 2
      const lineYPositions = new Set(
        rects.map((rect) => Math.round(rect.top / tolerance) * tolerance),
      )
      const isMulti = lineYPositions.size > 1
      setIsMultilineInput((prev) => (prev === isMulti ? prev : isMulti))
    }

    const observer = new ResizeObserver(computeIsMultiline)
    observer.observe(element)
    computeIsMultiline()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setSelectedModelId((prev) =>
      prev === derivedModelId ? prev : derivedModelId,
    )
  }, [derivedModelId])

  useEffect(() => {
    setUseWebSearch((prev) =>
      prev === derivedUseWebSearch ? prev : derivedUseWebSearch,
    )
  }, [derivedUseWebSearch])

  useEffect(() => {
    setUseUrlContext((prev) =>
      prev === derivedUseUrlContext ? prev : derivedUseUrlContext,
    )
  }, [derivedUseUrlContext])

  useEffect(() => {
    onOverlayStateChange?.(hasBlockingOverlay)
  }, [hasBlockingOverlay, onOverlayStateChange])

  useEffect(() => {
    return () => {
      onOverlayStateChange?.(false)
    }
  }, [onOverlayStateChange])

  useEffect(() => {
    if (prevModelMenuOpenRef.current && !isModelMenuOpen) {
      contentEditableRef.current?.focus({ preventScroll: true })
    }
    prevModelMenuOpenRef.current = isModelMenuOpen
  }, [isModelMenuOpen])

  useEffect(() => {
    if (!draftState || hasRestoredDraftSelectionRef.current) {
      return
    }
    let cancelled = false
    const attemptSelectionRestore = () => {
      if (cancelled || hasRestoredDraftSelectionRef.current) return
      const editor = lexicalEditorRef.current
      if (editor) {
        hasRestoredDraftSelectionRef.current = true
        editor.update(() => {
          $getRoot().selectEnd()
        })
        return
      }
      requestAnimationFrame(attemptSelectionRestore)
    }
    attemptSelectionRestore()
    return () => {
      cancelled = true
    }
  }, [draftState])

  useEffect(() => {
    latestInstructionTextRef.current = instructionText
  }, [instructionText])

  useEffect(() => {
    latestMentionablesRef.current = mentionables
  }, [mentionables])

  useEffect(() => {
    return () => {
      if (!shouldPersistDraftRef.current) {
        plugin.setSmartSpaceDraftState(null)
        return
      }
      const text = latestInstructionTextRef.current
      const mentionableList = latestMentionablesRef.current
      if (text.length === 0 && mentionableList.length === 0) {
        plugin.setSmartSpaceDraftState(null)
        return
      }
      plugin.setSmartSpaceDraftState({
        instructionText: text,
        mentionables: mentionableList.map((item) => serializeMentionable(item)),
        editorState: latestEditorStateRef.current ?? undefined,
      })
    }
  }, [plugin])

  const mentionSearch = useCallback(
    (query: string) =>
      fuzzySearch(plugin.app, query).filter(
        (item): item is SmartSpaceMentionable =>
          item.type === 'file' || item.type === 'folder',
      ),
    [plugin.app],
  )

  const updateMentionMenuPlacement = useCallback(() => {
    const card = inputCardRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const margin = 16
    const spaceAbove = rect.top - margin
    const spaceBelow = viewportHeight - rect.bottom - margin
    const preferredHeight = 260
    if (spaceAbove < preferredHeight && spaceBelow > spaceAbove) {
      setMentionMenuPlacement('bottom')
    } else {
      setMentionMenuPlacement('top')
    }
  }, [])

  useEffect(() => {
    quickActionsPlacementRef.current = quickActionsPlacement
  }, [quickActionsPlacement])

  const updateQuickActionsLayout = useCallback(() => {
    const panel = resolvedContainerRef.current
    const card = inputCardRef.current
    if (!panel || !card) return

    const panelRect = panel.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const belowAnchorRect =
      errorRef.current?.getBoundingClientRect() ?? cardRect

    const viewportHeight = window.innerHeight
    const margin = 16
    const gap = 12

    const availableAbove = cardRect.top - gap - margin
    const availableBelow =
      viewportHeight - belowAnchorRect.bottom - gap - margin
    const preferredHeight = 260

    const nextPlacement: 'top' | 'bottom' =
      availableBelow < preferredHeight && availableAbove > availableBelow
        ? 'top'
        : 'bottom'

    const resolvedPlacement = quickActionsPlacementLockedRef.current
      ? quickActionsPlacementRef.current
      : nextPlacement

    const cardTopWithinPanel = cardRect.top - panelRect.top
    const cardBottomWithinPanel = belowAnchorRect.bottom - panelRect.top

    const nextOffset =
      resolvedPlacement === 'bottom'
        ? Math.round(cardBottomWithinPanel + gap)
        : Math.round(panelRect.height - cardTopWithinPanel + gap)

    const nextMaxHeight = Math.max(
      0,
      Math.floor(
        resolvedPlacement === 'bottom' ? availableBelow : availableAbove,
      ),
    )

    if (!quickActionsPlacementLockedRef.current) {
      quickActionsPlacementRef.current = resolvedPlacement
      setQuickActionsPlacement((prev) =>
        prev === resolvedPlacement ? prev : resolvedPlacement,
      )
    }
    setQuickActionsOffset((prev) => (prev === nextOffset ? prev : nextOffset))
    setQuickActionsMaxHeight((prev) =>
      prev === nextMaxHeight ? prev : nextMaxHeight,
    )
  }, [resolvedContainerRef])

  const handleMentionNodeMutation = useCallback(
    (mutations: NodeMutations<MentionNode>) => {
      setMentionables((currentMentionables) => {
        const mentionMap = new Map(
          currentMentionables.map((item) => [
            getMentionableKey(serializeMentionable(item)),
            item,
          ]),
        )
        let hasChange = false

        mutations.forEach((mutation) => {
          const serializedMentionable = mutation.node.getMentionable()
          const mentionKey = getMentionableKey(serializedMentionable)

          if (mutation.mutation === 'destroyed') {
            const stillExists = lexicalEditorRef.current?.read(() => {
              const nodes = $nodesOfType(MentionNode)
              return nodes.some(
                (node) =>
                  getMentionableKey(node.getMentionable()) === mentionKey,
              )
            })
            if (!stillExists && mentionMap.has(mentionKey)) {
              mentionMap.delete(mentionKey)
              hasChange = true
            }
            return
          }

          const mentionable = deserializeMentionable(
            serializedMentionable,
            plugin.app,
          )
          if (
            mentionable &&
            (mentionable.type === 'file' || mentionable.type === 'folder') &&
            !mentionMap.has(mentionKey)
          ) {
            mentionMap.set(mentionKey, mentionable)
            hasChange = true
          }
        })

        if (!hasChange) {
          return currentMentionables
        }
        return Array.from(mentionMap.values())
      })
    },
    [plugin.app],
  )

  useEffect(() => {
    if (!isMentionMenuOpen) return
    updateMentionMenuPlacement()

    const handleResize = () => updateMentionMenuPlacement()
    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleResize, true)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleResize, true)
    }
  }, [isMentionMenuOpen, updateMentionMenuPlacement])

  // Check if current model supports Gemini tools
  const hasGeminiTools = useMemo(() => {
    try {
      const continuationModelId =
        plugin.settings?.continuationOptions?.continuationModelId ??
        plugin.settings?.chatModelId

      const { model } = getChatModelClient({
        settings: plugin.settings,
        modelId: continuationModelId,
      })
      if (
        model.providerType === 'gemini' ||
        model.providerType === 'openai-compatible'
      ) {
        return model.toolType === 'gemini'
      }
      return false
    } catch {
      return false
    }
  }, [plugin.settings])

  useEffect(() => {
    setIsSubmitConfirmPending(false)
  }, [instructionText, mentionables.length])

  const sections = useMemo(() => {
    type SectionItem = {
      id: string
      label: string
      instruction: string
      icon: React.ReactNode
    }

    type Section = {
      id: string
      title: string
      items: SectionItem[]
    }

    // Get custom quick actions from settings if available
    const customActions =
      plugin.settings?.continuationOptions?.smartSpaceQuickActions

    if (customActions && customActions.length > 0) {
      // Use custom actions
      const enabledActions = customActions.filter((action) => action.enabled)

      // Group actions by category
      const categorizedActions = {
        suggestions: [] as SectionItem[],
        writing: [] as SectionItem[],
        thinking: [] as SectionItem[],
        custom: [] as SectionItem[],
      }

      const iconMap = {
        sparkles: Sparkles,
        filetext: FileText,
        listtodo: ListTodo,
        workflow: Workflow,
        table: Table,
        penline: PenLine,
        lightbulb: Lightbulb,
        brain: Brain,
        messagecircle: MessageCircle,
      } as const

      for (const action of enabledActions) {
        const IconComponent =
          iconMap[action.icon as keyof typeof iconMap] || Sparkles
        const item: SectionItem = {
          id: action.id,
          label: action.label,
          instruction: action.instruction,
          icon: (
            <IconComponent
              className="smtcmp-smart-space-item-icon-svg"
              size={14}
            />
          ),
        }
        const category = action.category || 'custom'
        categorizedActions[category].push(item)
      }

      const sections: Section[] = []

      const categoryTitles: Record<string, string> = {
        suggestions: t('chat.customContinueSections.suggestions.title', '建议'),
        writing: t('chat.customContinueSections.writing.title', '撰写'),
        thinking: t(
          'chat.customContinueSections.thinking.title',
          '思考 · 询问 · 对话',
        ),
        custom: t('chat.customContinueSections.custom.title', '自定义'),
      }

      for (const [category, items] of Object.entries(categorizedActions)) {
        if (items.length > 0) {
          sections.push({
            id: category,
            title: categoryTitles[category] || category,
            items,
          })
        }
      }

      return sections
    } else {
      // Use default actions
      const makeItem = (
        id: string,
        labelKey: string,
        instructionKey: string,
        icon: React.ReactNode,
      ): SectionItem | null => {
        const label = t(labelKey, '')
        const instruction = t(instructionKey, '')
        if (!label || !instruction) return null
        return { id, label, instruction, icon }
      }

      const makeSection = (
        id: string,
        titleKey: string,
        items: (SectionItem | null)[],
      ): Section | null => {
        const title = t(titleKey, '')
        const resolvedItems = items.filter(
          (item): item is SectionItem => !!item,
        )
        if (!title || resolvedItems.length === 0) return null
        return { id, title, items: resolvedItems }
      }

      return [
        makeSection(
          'suggestions',
          'chat.customContinueSections.suggestions.title',
          [
            makeItem(
              'continue',
              'chat.customContinueSections.suggestions.items.continue.label',
              'chat.customContinueSections.suggestions.items.continue.instruction',
              <Sparkles
                className="smtcmp-smart-space-item-icon-svg"
                size={14}
              />,
            ),
          ],
        ),
        makeSection('writing', 'chat.customContinueSections.writing.title', [
          makeItem(
            'summarize',
            'chat.customContinueSections.writing.items.summarize.label',
            'chat.customContinueSections.writing.items.summarize.instruction',
            <FileText className="smtcmp-smart-space-item-icon-svg" size={14} />,
          ),
          makeItem(
            'todo',
            'chat.customContinueSections.writing.items.todo.label',
            'chat.customContinueSections.writing.items.todo.instruction',
            <ListTodo className="smtcmp-smart-space-item-icon-svg" size={14} />,
          ),
          makeItem(
            'flowchart',
            'chat.customContinueSections.writing.items.flowchart.label',
            'chat.customContinueSections.writing.items.flowchart.instruction',
            <Workflow className="smtcmp-smart-space-item-icon-svg" size={14} />,
          ),
          makeItem(
            'table',
            'chat.customContinueSections.writing.items.table.label',
            'chat.customContinueSections.writing.items.table.instruction',
            <Table className="smtcmp-smart-space-item-icon-svg" size={14} />,
          ),
          makeItem(
            'freewrite',
            'chat.customContinueSections.writing.items.freewrite.label',
            'chat.customContinueSections.writing.items.freewrite.instruction',
            <PenLine className="smtcmp-smart-space-item-icon-svg" size={14} />,
          ),
        ]),
        makeSection('thinking', 'chat.customContinueSections.thinking.title', [
          makeItem(
            'brainstorm',
            'chat.customContinueSections.thinking.items.brainstorm.label',
            'chat.customContinueSections.thinking.items.brainstorm.instruction',
            <Lightbulb
              className="smtcmp-smart-space-item-icon-svg"
              size={14}
            />,
          ),
          makeItem(
            'analyze',
            'chat.customContinueSections.thinking.items.analyze.label',
            'chat.customContinueSections.thinking.items.analyze.instruction',
            <Brain className="smtcmp-smart-space-item-icon-svg" size={14} />,
          ),
          makeItem(
            'dialogue',
            'chat.customContinueSections.thinking.items.dialogue.label',
            'chat.customContinueSections.thinking.items.dialogue.instruction',
            <MessageCircle
              className="smtcmp-smart-space-item-icon-svg"
              size={14}
            />,
          ),
        ]),
      ].filter((section): section is Section => !!section)
    }
  }, [t, plugin.settings])

  const totalItems = useMemo(
    () => sections.reduce((sum, section) => sum + section.items.length, 0),
    [sections],
  )

  const shouldShowQuickActions =
    showQuickActions && totalItems > 0 && !isMentionMenuOpen

  useEffect(() => {
    if (!shouldShowQuickActions) return
    const panel = resolvedContainerRef.current
    const card = inputCardRef.current
    if (!panel || !card) return

    const observer = new ResizeObserver(() => {
      if (!quickActionsHasInitializedRef.current) return
      updateQuickActionsLayout()
    })
    observer.observe(panel)
    observer.observe(card)

    const handleResize = () => {
      if (!quickActionsHasInitializedRef.current) return
      updateQuickActionsLayout()
    }
    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [shouldShowQuickActions, resolvedContainerRef, updateQuickActionsLayout])

  useEffect(() => {
    if (!shouldShowQuickActions) return
    if (quickActionsHasInitializedRef.current) return

    setIsQuickActionsLayoutReady(false)
    quickActionsPlacementLockedRef.current = false

    if (quickActionsLayoutRafIdRef.current !== null) {
      cancelAnimationFrame(quickActionsLayoutRafIdRef.current)
      quickActionsLayoutRafIdRef.current = null
    }
    if (quickActionsLayoutRafId2Ref.current !== null) {
      cancelAnimationFrame(quickActionsLayoutRafId2Ref.current)
      quickActionsLayoutRafId2Ref.current = null
    }

    let cancelled = false
    quickActionsLayoutRafIdRef.current = window.requestAnimationFrame(() => {
      quickActionsLayoutRafIdRef.current = null
      quickActionsLayoutRafId2Ref.current = window.requestAnimationFrame(() => {
        quickActionsLayoutRafId2Ref.current = null
        if (cancelled) return
        updateQuickActionsLayout()
        quickActionsPlacementLockedRef.current = true
        quickActionsHasInitializedRef.current = true
        setIsQuickActionsLayoutReady(true)
      })
    })

    return () => {
      cancelled = true
      if (quickActionsLayoutRafIdRef.current !== null) {
        cancelAnimationFrame(quickActionsLayoutRafIdRef.current)
        quickActionsLayoutRafIdRef.current = null
      }
      if (quickActionsLayoutRafId2Ref.current !== null) {
        cancelAnimationFrame(quickActionsLayoutRafId2Ref.current)
        quickActionsLayoutRafId2Ref.current = null
      }
    }
  }, [shouldShowQuickActions, updateQuickActionsLayout])

  useEffect(() => {
    if (itemRefs.current.length !== totalItems) {
      const nextRefs = new Array<HTMLButtonElement | null>(totalItems).fill(
        null,
      )
      for (let i = 0; i < totalItems; i += 1) {
        nextRefs[i] = itemRefs.current[i] ?? null
      }
      itemRefs.current = nextRefs
    }
  }, [totalItems])

  const focusFirstItem = () => {
    for (const ref of itemRefs.current) {
      if (ref && !ref.disabled) {
        activateKeyboardNavigation()
        ref.focus()
        return
      }
    }
  }

  const focusLastItem = () => {
    for (let i = itemRefs.current.length - 1; i >= 0; i -= 1) {
      const ref = itemRefs.current[i]
      if (ref && !ref.disabled) {
        activateKeyboardNavigation()
        ref.focus()
        return
      }
    }
  }

  const moveFocus = (startIndex: number, direction: 1 | -1) => {
    if (totalItems === 0) return
    let nextIndex = startIndex
    for (let i = 0; i < totalItems; i += 1) {
      nextIndex = (nextIndex + direction + totalItems) % totalItems
      const ref = itemRefs.current[nextIndex]
      if (ref && !ref.disabled) {
        activateKeyboardNavigation()
        ref.focus()
        return
      }
    }
  }

  const handleSubmit = useCallback(
    async (value?: string) => {
      if (isSubmitting) return
      setIsSubmitting(true)
      setError(null)
      setIsSubmitConfirmPending(false)
      const payload = (value ?? instructionText).trim()
      try {
        const geminiTools = hasGeminiTools
          ? { useWebSearch, useUrlContext }
          : undefined
        await plugin.continueWriting(
          editor,
          payload.length > 0 ? payload : undefined,
          geminiTools,
          mentionables,
        )
        shouldPersistDraftRef.current = false
        plugin.setSmartSpaceDraftState(null)
        onClose()
      } catch (err) {
        console.error('Smart Space failed', err)
        setError(
          err instanceof Error
            ? err.message
            : t('chat.customContinueError', '智能续写失败，请重试'),
        )
      } finally {
        setIsSubmitting(false)
      }
    },
    [
      editor,
      hasGeminiTools,
      instructionText,
      isSubmitting,
      mentionables,
      onClose,
      plugin,
      t,
      useUrlContext,
      useWebSearch,
    ],
  )

  const handleEditorEnter = useCallback(
    (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) {
        setIsSubmitConfirmPending(false)
        void handleSubmit()
        return
      }

      if (isSubmitConfirmPending) {
        setIsSubmitConfirmPending(false)
        void handleSubmit()
      } else {
        setIsSubmitConfirmPending(true)
      }
    },
    [handleSubmit, isSubmitConfirmPending],
  )

  const isCaretAtRightEdge = useCallback(() => {
    const editor = lexicalEditorRef.current
    if (!editor) return false

    return editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
        return false
      }

      const anchor = selection.anchor
      const node = anchor.getNode()
      if (!node) return false

      if ($isTextNode(node)) {
        if (anchor.offset < node.getTextContentSize()) {
          return false
        }
      } else if ($isElementNode(node)) {
        if (anchor.offset < node.getChildrenSize()) {
          return false
        }
      } else {
        return false
      }

      let currentNode: LexicalNode | null = node
      while (currentNode) {
        let sibling = currentNode.getNextSibling()
        while (sibling) {
          if (sibling.getTextContentSize() > 0) {
            return false
          }
          sibling = sibling.getNextSibling()
        }
        currentNode = currentNode.getParent()
      }

      return true
    })
  }, [])

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const canHandleNavigation =
      !isMentionMenuOpen &&
      !isSubmitting &&
      instructionText.length === 0 &&
      mentionables.length === 0

    if (!canHandleNavigation) {
      if (
        event.key === 'ArrowRight' &&
        !isMentionMenuOpen &&
        !isSubmitting &&
        isCaretAtRightEdge()
      ) {
        event.preventDefault()
        modelSelectRef.current?.focus()
      }
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    if (event.key === 'ArrowDown') {
      if (totalItems === 0) return
      event.preventDefault()
      focusFirstItem()
      return
    }

    if (event.key === 'ArrowUp') {
      if (totalItems === 0) return
      event.preventDefault()
      focusLastItem()
      return
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      modelSelectRef.current?.focus()
      return
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (urlContextButtonRef.current) {
        urlContextButtonRef.current.focus()
      } else if (webSearchButtonRef.current) {
        webSearchButtonRef.current.focus()
      } else {
        modelSelectRef.current?.focus()
      }
    }
  }

  const handleItemKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
    instructionText: string,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (index === totalItems - 1) {
        contentEditableRef.current?.focus({ preventScroll: true })
      } else {
        moveFocus(index, 1)
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index === 0) {
        contentEditableRef.current?.focus({ preventScroll: true })
      } else {
        moveFocus(index, -1)
      }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void handleSubmit(instructionText)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const handleQuickActionsPointerMove = useCallback(() => {
    if (!isKeyboardNavigationActive) return
    // 鼠标开始移动时恢复 hover 行为
    deactivateKeyboardNavigation()
  }, [deactivateKeyboardNavigation, isKeyboardNavigationActive])

  const isInputEmpty = instructionText.length === 0 && mentionables.length === 0

  return (
    <div className="smtcmp-smart-space-panel" ref={resolvedContainerRef}>
      {!isSubmitting ? (
        <>
          <div className="smtcmp-smart-space-input-card" ref={inputCardRef}>
            <div
              className={`smtcmp-smart-space-header${
                isMultilineInput ? ' is-multiline' : ''
              }${isInputEmpty ? ' is-empty' : ''}`}
            >
              <div className="smtcmp-smart-space-avatar">
                <Sparkles size={14} />
              </div>
              <div className="smtcmp-smart-space-input-wrapper">
                <div
                  className={`smtcmp-smart-space-input${isSubmitting ? ' is-disabled' : ''}${
                    isMultilineInput ? ' is-multiline' : ''
                  }${isInputEmpty ? ' is-empty' : ''}`}
                  onKeyDownCapture={handleInputKeyDown}
                  onClick={() => contentEditableRef.current?.focus()}
                  aria-disabled={isSubmitting ? 'true' : undefined}
                >
                  {isInputEmpty && (
                    <div className="smtcmp-smart-space-input-placeholder">
                      {t(
                        'chat.customContinuePromptPlaceholder',
                        'Ask AI (@ to attach files)...',
                      )}
                    </div>
                  )}
                  <LexicalContentEditable
                    initialEditorState={initialEditorStateCallback}
                    editorRef={lexicalEditorRef}
                    contentEditableRef={contentEditableRef}
                    onChange={(state) => {
                      latestEditorStateRef.current = state
                    }}
                    onTextContentChange={setInstructionText}
                    onEnter={handleEditorEnter}
                    onMentionNodeMutation={handleMentionNodeMutation}
                    onMentionMenuToggle={setIsMentionMenuOpen}
                    searchResultByQuery={mentionSearch}
                    mentionMenuContainerRef={inputCardRef}
                    mentionMenuPlacement={mentionMenuPlacement}
                    autoFocus
                    contentClassName="obsidian-default-textarea smtcmp-content-editable smtcmp-smart-space-content-editable"
                  />
                </div>
                {(instructionText.length > 0 ||
                  mentionables.length > 0 ||
                  isSubmitConfirmPending) && (
                  <div className="smtcmp-smart-space-input-hint">
                    {isSubmitConfirmPending
                      ? t('chat.customContinueConfirmHint', '⏎ 是否确认提交？')
                      : t('chat.customContinueHint', '⏎ 提交')}
                  </div>
                )}
              </div>
              <div className="smtcmp-smart-space-controls">
                <div className="smtcmp-smart-space-model-select">
                  <ModelSelect
                    ref={modelSelectRef}
                    modelId={selectedModelId}
                    onMenuOpenChange={setIsModelMenuOpen}
                    onChange={(modelId) => {
                      setSelectedModelId(modelId)
                      if (settings) {
                        void setSettings({
                          ...settings,
                          continuationOptions: {
                            ...settings.continuationOptions,
                            continuationModelId: modelId,
                          },
                        })
                      }
                    }}
                    onModelSelected={() => {
                      window.setTimeout(() => {
                        contentEditableRef.current?.focus({
                          preventScroll: true,
                        })
                      }, 0)
                    }}
                    onKeyDown={(event, isMenuOpen) => {
                      // 如果菜单已打开，只处理 Escape，其他键交给 Radix UI
                      if (isMenuOpen) {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          onClose()
                        }
                        return
                      }

                      // 菜单未打开时的键盘导航
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        onClose()
                      } else if (event.key === 'ArrowLeft') {
                        // 左方向键返回输入框
                        event.preventDefault()
                        contentEditableRef.current?.focus()
                      } else if (event.key === 'ArrowRight') {
                        // 右方向键移动到工具按钮（如果存在）
                        event.preventDefault()
                        if (webSearchButtonRef.current) {
                          webSearchButtonRef.current.focus()
                        } else {
                          // 如果没有工具按钮，回到输入框
                          contentEditableRef.current?.focus()
                        }
                      }
                    }}
                    side="top"
                    align="end"
                    // 24 = 12px 卡片内边距 + 12px 面板间距，保证与下方快捷选项的间距一致
                    sideOffset={24}
                    // 负偏移让弹层右侧与输入框右缘（16px 内边距）保持对齐
                    alignOffset={-16}
                    container={containerRef?.current ?? undefined}
                    contentClassName="smtcmp-smart-space-popover"
                  />
                </div>
                {hasGeminiTools && (
                  <div className="smtcmp-smart-space-tools">
                    <button
                      ref={webSearchButtonRef}
                      type="button"
                      className={`smtcmp-smart-space-tool-button ${
                        useWebSearch ? 'active' : ''
                      }`}
                      onClick={() => {
                        const newValue = !useWebSearch
                        setUseWebSearch(newValue)
                        if (settings) {
                          void setSettings({
                            ...settings,
                            continuationOptions: {
                              ...settings.continuationOptions,
                              smartSpaceUseWebSearch: newValue,
                            },
                          })
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          onClose()
                        } else if (event.key === 'ArrowLeft') {
                          // 左方向键返回模型选择框
                          event.preventDefault()
                          modelSelectRef.current?.focus()
                        } else if (event.key === 'ArrowRight') {
                          // 右方向键移动到下一个工具按钮
                          event.preventDefault()
                          urlContextButtonRef.current?.focus()
                        }
                      }}
                      title={t(
                        'chat.conversationSettings.webSearch',
                        'Web search',
                      )}
                      aria-label={t(
                        'chat.conversationSettings.webSearch',
                        'Web search',
                      )}
                    >
                      <Globe size={14} />
                    </button>
                    <button
                      ref={urlContextButtonRef}
                      type="button"
                      className={`smtcmp-smart-space-tool-button ${
                        useUrlContext ? 'active' : ''
                      }`}
                      onClick={() => {
                        const newValue = !useUrlContext
                        setUseUrlContext(newValue)
                        if (settings) {
                          void setSettings({
                            ...settings,
                            continuationOptions: {
                              ...settings.continuationOptions,
                              smartSpaceUseUrlContext: newValue,
                            },
                          })
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          onClose()
                        } else if (event.key === 'ArrowLeft') {
                          // 左方向键返回上一个工具按钮
                          event.preventDefault()
                          webSearchButtonRef.current?.focus()
                        } else if (event.key === 'ArrowRight') {
                          // 右方向键返回输入框（循环）
                          event.preventDefault()
                          contentEditableRef.current?.focus()
                        }
                      }}
                      title={t(
                        'chat.conversationSettings.urlContext',
                        'URL Context',
                      )}
                      aria-label={t(
                        'chat.conversationSettings.urlContext',
                        'URL Context',
                      )}
                    >
                      <Link size={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          {error && (
            <div
              className="smtcmp-smart-space-error"
              role="alert"
              ref={errorRef}
            >
              {error}
            </div>
          )}
          {shouldShowQuickActions && isQuickActionsLayoutReady && (
            <div
              className={`smtcmp-smart-space-section-card is-floating smtcmp-smart-space-section-card--${quickActionsPlacement}${
                isKeyboardNavigationActive ? ' is-keyboard-nav' : ''
              }`}
              onPointerMove={handleQuickActionsPointerMove}
              style={{
                ...(quickActionsPlacement === 'bottom'
                  ? { top: quickActionsOffset }
                  : { bottom: quickActionsOffset }),
                maxHeight: quickActionsMaxHeight,
              }}
            >
              <div className="smtcmp-smart-space-section-list">
                {(() => {
                  let itemIndex = -1
                  return sections.map((section) => (
                    <div
                      className="smtcmp-smart-space-section"
                      key={section.id}
                    >
                      <div className="smtcmp-smart-space-section-title">
                        {section.title}
                      </div>
                      <div className="smtcmp-smart-space-section-items">
                        {section.items.map((item) => {
                          itemIndex += 1
                          const currentIndex = itemIndex
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className="smtcmp-smart-space-item"
                              onClick={() =>
                                void handleSubmit(item.instruction)
                              }
                              onKeyDown={(event) =>
                                handleItemKeyDown(
                                  event,
                                  currentIndex,
                                  item.instruction,
                                )
                              }
                              disabled={isSubmitting}
                              ref={(element) => {
                                itemRefs.current[currentIndex] = element
                              }}
                            >
                              <span className="smtcmp-smart-space-item-icon">
                                {item.icon}
                              </span>
                              <span className="smtcmp-smart-space-item-label">
                                {item.label}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))
                })()}
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}

export class SmartSpaceWidget extends WidgetType {
  private static overlayRoot: HTMLElement | null = null
  private static currentInstance: SmartSpaceWidget | null = null

  private root: Root | null = null
  private overlayContainer: HTMLDivElement | null = null
  private anchor: HTMLSpanElement | null = null
  private cleanupListeners: (() => void) | null = null
  private cleanupCallbacks: (() => void)[] = []
  private rafId: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private isClosing = false
  private closeAnimationTimeout: number | null = null
  private containerRef: React.RefObject<HTMLDivElement> =
    React.createRef<HTMLDivElement>()
  private hasBlockingOverlay = false

  constructor(
    private readonly options: {
      plugin: SmartComposerPlugin
      editor: Editor
      view: EditorView
      onClose: () => void
      showQuickActions?: boolean
    },
  ) {
    super()
  }

  eq(): boolean {
    return false
  }

  toDOM(): HTMLElement {
    const anchor = document.createElement('span')
    anchor.className = 'smtcmp-smart-space-inline-anchor'
    anchor.setAttribute('aria-hidden', 'true')
    this.anchor = anchor

    // 保存当前实例的引用
    SmartSpaceWidget.currentInstance = this

    this.mountOverlay()
    this.setupGlobalListeners()
    this.schedulePositionUpdate()

    return anchor
  }

  destroy(): void {
    // 清除当前实例引用
    if (SmartSpaceWidget.currentInstance === this) {
      SmartSpaceWidget.currentInstance = null
    }

    if (this.closeAnimationTimeout !== null) {
      window.clearTimeout(this.closeAnimationTimeout)
      this.closeAnimationTimeout = null
    }

    if (this.cleanupListeners) {
      this.cleanupListeners()
      this.cleanupListeners = null
    }
    for (const cleanup of this.cleanupCallbacks) {
      try {
        cleanup()
      } catch {
        // ignore cleanup errors
      }
    }
    this.cleanupCallbacks = []

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }

    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    this.root?.unmount()
    this.root = null
    if (this.overlayContainer?.parentNode) {
      this.overlayContainer.parentNode.removeChild(this.overlayContainer)
    }
    if (this.overlayContainer) {
      clearDynamicStyleClass(this.overlayContainer)
    }
    this.overlayContainer = null
    const overlayRoot = SmartSpaceWidget.overlayRoot
    if (overlayRoot && overlayRoot.childElementCount === 0) {
      overlayRoot.remove()
      SmartSpaceWidget.overlayRoot = null
    }
    this.anchor = null
  }

  private static getOverlayRoot(): HTMLElement {
    if (SmartSpaceWidget.overlayRoot) return SmartSpaceWidget.overlayRoot
    const root = document.createElement('div')
    root.className = 'smtcmp-smart-space-overlay-root'
    document.body.appendChild(root)
    SmartSpaceWidget.overlayRoot = root
    return root
  }

  // 静态方法：从外部触发当前实例的关闭动画
  static closeCurrentWithAnimation(): boolean {
    if (SmartSpaceWidget.currentInstance) {
      SmartSpaceWidget.currentInstance.closeWithAnimation()
      return true
    }
    return false
  }

  private closeWithAnimation = () => {
    if (this.isClosing) return
    this.isClosing = true
    this.hasBlockingOverlay = false

    // 添加关闭动画类
    if (this.overlayContainer) {
      this.overlayContainer.classList.add('closing')
    }

    // 等待动画完成后执行真正的关闭
    this.closeAnimationTimeout = window.setTimeout(() => {
      this.closeAnimationTimeout = null
      this.options.onClose()
    }, 200) // 与 CSS 动画时长一致
  }

  private mountOverlay() {
    const overlayRoot = SmartSpaceWidget.getOverlayRoot()
    const overlayContainer = document.createElement('div')
    overlayContainer.className = 'smtcmp-smart-space-overlay'
    overlayRoot.appendChild(overlayContainer)
    this.overlayContainer = overlayContainer

    this.root = createRoot(overlayContainer)
    this.root.render(
      <PluginProvider plugin={this.options.plugin}>
        <SettingsProvider
          settings={this.options.plugin.settings}
          setSettings={(newSettings) =>
            this.options.plugin.setSettings(newSettings)
          }
          addSettingsChangeListener={(listener) =>
            this.options.plugin.addSettingsChangeListener(listener)
          }
        >
          <LanguageProvider>
            <AppProvider app={this.options.plugin.app}>
              <SmartSpacePanelBody
                editor={this.options.editor}
                onClose={this.closeWithAnimation}
                showQuickActions={this.options.showQuickActions}
                containerRef={this.containerRef}
                onOverlayStateChange={this.handleOverlayStateChange}
              />
            </AppProvider>
          </LanguageProvider>
        </SettingsProvider>
      </PluginProvider>,
    )

    const handleScroll = () => this.schedulePositionUpdate()
    window.addEventListener('scroll', handleScroll, true)
    this.cleanupCallbacks.push(() =>
      window.removeEventListener('scroll', handleScroll, true),
    )

    const handleResize = () => this.schedulePositionUpdate()
    window.addEventListener('resize', handleResize)
    this.cleanupCallbacks.push(() =>
      window.removeEventListener('resize', handleResize),
    )

    const scrollDom = this.options.view?.scrollDOM
    if (scrollDom) {
      scrollDom.addEventListener('scroll', handleScroll)
      this.cleanupCallbacks.push(() =>
        scrollDom.removeEventListener('scroll', handleScroll),
      )
    }

    this.resizeObserver = new ResizeObserver(() =>
      this.schedulePositionUpdate(),
    )
    if (scrollDom) this.resizeObserver.observe(scrollDom)
    this.resizeObserver.observe(overlayContainer)
  }

  private setupGlobalListeners() {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (this.overlayContainer?.contains(target)) return
      if (this.anchor?.contains(target)) return
      this.closeWithAnimation()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (this.hasBlockingOverlay) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      this.closeWithAnimation()
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    this.cleanupListeners = () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
      this.cleanupListeners = null
    }
  }

  private schedulePositionUpdate() {
    if (this.rafId !== null) return
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = null
      this.updateOverlayPosition()
    })
  }

  private updateOverlayPosition() {
    if (!this.overlayContainer || !this.anchor) return
    if (!this.anchor.isConnected) {
      // Anchor not mounted yet, try again on next frame
      this.schedulePositionUpdate()
      return
    }
    const anchorRect = this.anchor.getBoundingClientRect()

    const viewportWidth = window.innerWidth
    const margin = 12
    const offsetY = 6

    const scrollDom = this.options.view.scrollDOM
    const scrollRect = scrollDom?.getBoundingClientRect()
    const sizer = scrollDom?.querySelector('.cm-sizer')
    const sizerRect = sizer?.getBoundingClientRect()

    const fallbackWidth = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--file-line-width',
      ) || '720',
      10,
    )

    const editorContentWidth =
      sizerRect?.width ?? scrollRect?.width ?? fallbackWidth
    const maxPanelWidth = Math.max(
      120,
      Math.min(editorContentWidth, viewportWidth - margin * 2),
    )

    const contentLeft = sizerRect?.left ?? scrollRect?.left ?? margin
    const contentRight = contentLeft + editorContentWidth

    let left = anchorRect.left
    left = Math.min(left, contentRight - maxPanelWidth)
    left = Math.max(left, contentLeft)
    left = Math.min(left, viewportWidth - margin - maxPanelWidth)
    left = Math.max(left, margin)

    const top = anchorRect.bottom + offsetY

    updateDynamicStyleClass(
      this.overlayContainer,
      'smtcmp-smart-space-overlay-pos',
      {
        width: maxPanelWidth,
        left: Math.round(left),
        top: Math.round(top),
      },
    )
  }

  private handleOverlayStateChange = (isActive: boolean) => {
    this.hasBlockingOverlay = isActive
  }
}
