import {
  InitialConfigType,
  InitialEditorStateType,
  LexicalComposer,
} from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { EditorRefPlugin } from '@lexical/react/LexicalEditorRefPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $getRoot, LexicalEditor, SerializedEditorState } from 'lexical'
import { RefObject, useCallback, useEffect, useState } from 'react'

import { useApp } from '../../../contexts/app-context'
import { LiteSkillEntry } from '../../../core/skills/liteSkills'
import { Assistant } from '../../../types/assistant.types'
import { MentionableFolder } from '../../../types/mentionable'
import { Mentionable, MentionableImage } from '../../../types/mentionable'
import {
  SearchableMentionable,
  fuzzySearch,
  fuzzySearchFolders,
} from '../../../utils/fuzzy-search'

import DragDropPaste from './plugins/image/DragDropPastePlugin'
import ImagePastePlugin from './plugins/image/ImagePastePlugin'
import AutoLinkMentionPlugin from './plugins/mention/AutoLinkMentionPlugin'
import { MentionNode } from './plugins/mention/MentionNode'
import MentionPlugin from './plugins/mention/MentionPlugin'
import { SkillNode } from './plugins/mention/SkillNode'
import SkillSlashPlugin, {
  type SlashCommand,
} from './plugins/mention/SkillSlashPlugin'
import NoFormatPlugin from './plugins/no-format/NoFormatPlugin'
import OnEnterPlugin from './plugins/on-enter/OnEnterPlugin'
import OnMutationPlugin, {
  NodeMutations,
} from './plugins/on-mutation/OnMutationPlugin'
// templates feature removed

export type LexicalContentEditableProps = {
  editorRef: RefObject<LexicalEditor>
  contentEditableRef: RefObject<HTMLDivElement>
  onChange?: (content: SerializedEditorState) => void
  onTextContentChange?: (textContent: string) => void
  onEnter?: (evt: KeyboardEvent) => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onFocus?: () => void
  onMentionNodeMutation?: (mutations: NodeMutations<MentionNode>) => void
  onSkillNodeMutation?: (mutations: NodeMutations<SkillNode>) => void
  onCreateImageMentionables?: (mentionables: MentionableImage[]) => void
  initialEditorState?: InitialEditorStateType
  autoFocus?: boolean
  contentClassName?: string
  searchResultByQuery?: (query: string) => SearchableMentionable[]
  onMentionMenuToggle?: (isOpen: boolean) => void
  mentionMenuContainerRef?: RefObject<HTMLElement>
  mentionMenuPlacement?: 'top' | 'bottom'
  mentionDisplayMode?: 'inline' | 'badge'
  onSelectMentionable?: (mentionable: Mentionable) => void
  mentionMenuMode?: 'direct-search' | 'entry'
  assistants?: Assistant[]
  currentAssistantId?: string
  onSelectAssistant?: (assistantId: string) => void
  currentChatMode?: 'chat' | 'agent'
  onSelectChatMode?: (mode: 'chat' | 'agent') => void
  allowAgentModeOption?: boolean
  skills?: LiteSkillEntry[]
  selectedSkillIds?: string[]
  onSelectSkill?: (skill: LiteSkillEntry) => void
  onRunSlashCommand?: (command: SlashCommand) => void
  plugins?: {
    onEnter?: {
      onVaultChat: () => void
    }
    // templates feature removed
  }
}

export default function LexicalContentEditable({
  editorRef,
  contentEditableRef,
  onChange,
  onTextContentChange,
  onEnter,
  onKeyDown,
  onFocus,
  onMentionNodeMutation,
  onSkillNodeMutation,
  onCreateImageMentionables,
  initialEditorState,
  autoFocus = false,
  contentClassName,
  searchResultByQuery,
  onMentionMenuToggle,
  mentionMenuContainerRef,
  mentionMenuPlacement = 'top',
  mentionDisplayMode = 'inline',
  onSelectMentionable,
  mentionMenuMode = 'direct-search',
  assistants = [],
  currentAssistantId,
  onSelectAssistant,
  currentChatMode,
  onSelectChatMode,
  allowAgentModeOption = true,
  skills = [],
  selectedSkillIds = [],
  onSelectSkill,
  onRunSlashCommand,
  plugins,
}: LexicalContentEditableProps) {
  const app = useApp()
  const [activeFilePath, setActiveFilePath] = useState<string | null>(
    app.workspace.getActiveFile()?.path ?? null,
  )

  const initialConfig: InitialConfigType = {
    namespace: 'LexicalContentEditable',
    theme: {
      root: 'smtcmp-lexical-content-editable-root',
      paragraph: 'smtcmp-lexical-content-editable-paragraph',
    },
    nodes: [MentionNode, SkillNode],
    editorState: initialEditorState,
    onError: (error) => {
      console.error(error)
    },
  }

  const defaultSearch = useCallback(
    (query: string) => fuzzySearch(app, query),
    [app],
  )
  const searchFoldersByQuery = useCallback(
    (query: string): MentionableFolder[] => fuzzySearchFolders(app, query),
    [app],
  )

  const resolvedSearch = useCallback(
    (query: string) => {
      void activeFilePath
      const searchFn = searchResultByQuery ?? defaultSearch
      return searchFn(query)
    },
    [activeFilePath, defaultSearch, searchResultByQuery],
  )

  /*
   * Using requestAnimationFrame for autoFocus instead of using editor.focus()
   * due to known issues with editor.focus() when initialConfig.editorState is set
   * See: https://github.com/facebook/lexical/issues/4460
   */
  useEffect(() => {
    if (autoFocus) {
      requestAnimationFrame(() => {
        contentEditableRef.current?.focus()
      })
    }
  }, [autoFocus, contentEditableRef])

  useEffect(() => {
    const handleActiveLeafChange = () => {
      setActiveFilePath(app.workspace.getActiveFile()?.path ?? null)
    }
    app.workspace.on('active-leaf-change', handleActiveLeafChange)
    return () => {
      app.workspace.off('active-leaf-change', handleActiveLeafChange)
    }
  }, [app])

  return (
    <LexicalComposer initialConfig={initialConfig}>
      {/* 
            There was two approach to make mentionable node copy and pasteable.
            1. use RichTextPlugin and reset text format when paste
              - so I implemented NoFormatPlugin to reset text format when paste
            2. use PlainTextPlugin and override paste command
              - PlainTextPlugin only pastes text, so we need to implement custom paste handler.
              - https://github.com/facebook/lexical/discussions/5112
           */}
      <RichTextPlugin
        contentEditable={
          <ContentEditable
            className={
              contentClassName ??
              'smtcmp-obsidian-textarea smtcmp-content-editable'
            }
            onFocus={onFocus}
            onKeyDown={onKeyDown}
            ref={contentEditableRef}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <MentionPlugin
        searchResultByQuery={resolvedSearch}
        onMenuOpenChange={onMentionMenuToggle}
        menuContainerRef={mentionMenuContainerRef}
        placement={mentionMenuPlacement}
        mentionDisplayMode={mentionDisplayMode}
        onSelectMentionable={onSelectMentionable}
        menuMode={mentionMenuMode}
        assistants={assistants}
        currentAssistantId={currentAssistantId}
        onSelectAssistant={onSelectAssistant}
        currentChatMode={currentChatMode}
        onSelectChatMode={onSelectChatMode}
        allowAgentModeOption={allowAgentModeOption}
        searchFoldersByQuery={searchFoldersByQuery}
      />
      {(skills.length > 0 || onRunSlashCommand) && (
        <SkillSlashPlugin
          skills={skills}
          selectedSkillIds={selectedSkillIds}
          mentionDisplayMode={mentionDisplayMode}
          onMenuOpenChange={onMentionMenuToggle}
          menuContainerRef={mentionMenuContainerRef}
          placement={mentionMenuPlacement}
          onSelectSkill={onSelectSkill}
          onRunCommand={onRunSlashCommand}
        />
      )}
      <OnChangePlugin
        onChange={(editorState, _editor) => {
          onChange?.(editorState.toJSON())
          if (onTextContentChange) {
            editorState.read(() => {
              const textContent = $getRoot().getTextContent()
              onTextContentChange(textContent)
            })
          }
        }}
      />
      {onEnter && (
        <OnEnterPlugin
          onEnter={onEnter}
          onVaultChat={plugins?.onEnter?.onVaultChat}
        />
      )}
      <OnMutationPlugin
        nodeClass={MentionNode}
        onMutation={(mutations) => {
          onMentionNodeMutation?.(mutations)
        }}
      />
      <OnMutationPlugin
        nodeClass={SkillNode}
        onMutation={(mutations) => {
          onSkillNodeMutation?.(mutations)
        }}
      />
      <EditorRefPlugin editorRef={editorRef} />
      <NoFormatPlugin />
      <AutoLinkMentionPlugin />
      <ImagePastePlugin onCreateImageMentionables={onCreateImageMentionables} />
      <DragDropPaste onCreateImageMentionables={onCreateImageMentionables} />
      {/* templates feature removed */}
    </LexicalComposer>
  )
}
