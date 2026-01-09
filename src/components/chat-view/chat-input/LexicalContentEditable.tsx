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
import { RefObject, useCallback, useEffect, useMemo } from 'react'

import { useApp } from '../../../contexts/app-context'
import { MentionableImage } from '../../../types/mentionable'
import { SearchableMentionable, fuzzySearch } from '../../../utils/fuzzy-search'

import DragDropPaste from './plugins/image/DragDropPastePlugin'
import ImagePastePlugin from './plugins/image/ImagePastePlugin'
import AutoLinkMentionPlugin from './plugins/mention/AutoLinkMentionPlugin'
import { MentionNode } from './plugins/mention/MentionNode'
import MentionPlugin from './plugins/mention/MentionPlugin'
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
  onCreateImageMentionables?: (mentionables: MentionableImage[]) => void
  initialEditorState?: InitialEditorStateType
  autoFocus?: boolean
  contentClassName?: string
  searchResultByQuery?: (query: string) => SearchableMentionable[]
  onMentionMenuToggle?: (isOpen: boolean) => void
  mentionMenuContainerRef?: RefObject<HTMLElement>
  mentionMenuPlacement?: 'top' | 'bottom'
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
  onCreateImageMentionables,
  initialEditorState,
  autoFocus = false,
  contentClassName,
  searchResultByQuery,
  onMentionMenuToggle,
  mentionMenuContainerRef,
  mentionMenuPlacement = 'top',
  plugins,
}: LexicalContentEditableProps) {
  const app = useApp()

  const initialConfig: InitialConfigType = {
    namespace: 'LexicalContentEditable',
    theme: {
      root: 'smtcmp-lexical-content-editable-root',
      paragraph: 'smtcmp-lexical-content-editable-paragraph',
    },
    nodes: [MentionNode],
    editorState: initialEditorState,
    onError: (error) => {
      console.error(error)
    },
  }

  const defaultSearch = useCallback(
    (query: string) => fuzzySearch(app, query),
    [app],
  )

  const resolvedSearch = useMemo(
    () => searchResultByQuery ?? defaultSearch,
    [defaultSearch, searchResultByQuery],
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
      />
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
      <EditorRefPlugin editorRef={editorRef} />
      <NoFormatPlugin />
      <AutoLinkMentionPlugin />
      <ImagePastePlugin onCreateImageMentionables={onCreateImageMentionables} />
      <DragDropPaste onCreateImageMentionables={onCreateImageMentionables} />
      {/* templates feature removed */}
    </LexicalComposer>
  )
}
