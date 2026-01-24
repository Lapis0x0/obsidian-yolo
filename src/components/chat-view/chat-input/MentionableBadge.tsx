import cx from 'clsx'
import { ChevronRight, ChevronUp, X } from 'lucide-react'
import { PropsWithChildren } from 'react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import {
  Mentionable,
  MentionableBlock,
  MentionableCurrentFile,
  MentionableFile,
  MentionableFolder,
  MentionableImage,
  MentionableUrl,
  MentionableVault,
} from '../../../types/mentionable'

import { getMentionableIcon } from './utils/get-metionable-icon'

function BadgeBase({
  children,
  onDelete,
  onClick,
  isFocused,
  isExpanded,
  onToggleExpand,
  showExpandButton = false,
  showDeleteButton = true,
}: PropsWithChildren<{
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  isExpanded?: boolean
  onToggleExpand?: () => void
  showExpandButton?: boolean
  showDeleteButton?: boolean
}>) {
  return (
    <div
      className={`smtcmp-chat-user-input-file-badge ${isFocused ? 'smtcmp-chat-user-input-file-badge-focused' : ''}`}
      onClick={onClick}
    >
      {showExpandButton && (
        <div
          className="smtcmp-chat-user-input-file-badge-expand"
          onClick={(evt) => {
            evt.stopPropagation()
            onToggleExpand?.()
          }}
        >
          {isExpanded ? <ChevronUp size={12} /> : <ChevronRight size={12} />}
        </div>
      )}
      {children}
      {showDeleteButton && (
        <div
          className="smtcmp-chat-user-input-file-badge-delete"
          onClick={(evt) => {
            evt.stopPropagation()
            onDelete()
          }}
        >
          <X size={12} />
        </div>
      )}
    </div>
  )
}

function FileBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  isExpanded,
  onToggleExpand,
  showDeleteButton,
}: {
  mentionable: MentionableFile
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  isExpanded?: boolean
  onToggleExpand?: () => void
  showDeleteButton?: boolean
}) {
  const Icon = getMentionableIcon(mentionable)
  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      showExpandButton={true}
      showDeleteButton={showDeleteButton}
    >
      <div className="smtcmp-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="smtcmp-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.file.name}</span>
      </div>
    </BadgeBase>
  )
}

function FolderBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  showDeleteButton,
}: {
  mentionable: MentionableFolder
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  showDeleteButton?: boolean
}) {
  const Icon = getMentionableIcon(mentionable)
  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      showExpandButton={false}
      showDeleteButton={showDeleteButton}
    >
      <div className="smtcmp-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="smtcmp-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.folder.name}</span>
      </div>
    </BadgeBase>
  )
}

function VaultBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  showDeleteButton,
}: {
  mentionable: MentionableVault
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  showDeleteButton?: boolean
}) {
  const Icon = getMentionableIcon(mentionable)
  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      showExpandButton={false}
      showDeleteButton={showDeleteButton}
    >
      <div className="smtcmp-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="smtcmp-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>Vault</span>
      </div>
    </BadgeBase>
  )
}

function CurrentFileBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  isExpanded,
  onToggleExpand,
  showDeleteButton,
}: {
  mentionable: MentionableCurrentFile
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  isExpanded?: boolean
  onToggleExpand?: () => void
  showDeleteButton?: boolean
}) {
  const app = useApp()

  const Icon = getMentionableIcon(mentionable)
  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      showExpandButton={true}
      showDeleteButton={showDeleteButton}
    >
      <div className="smtcmp-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="smtcmp-chat-user-input-file-badge-name-icon"
          />
        )}
        <span className={cx(!mentionable.file && 'smtcmp-excluded-content')}>
          {mentionable.file?.name ??
            app.workspace.getActiveFile()?.name ??
            'Current file'}
        </span>
      </div>
      <div
        className={cx(
          'smtcmp-chat-user-input-file-badge-name-suffix',
          !mentionable.file && 'smtcmp-excluded-content',
        )}
      >
        {' (Current file)'}
      </div>
    </BadgeBase>
  )
}

function BlockBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  isExpanded,
  onToggleExpand,
  showDeleteButton,
}: {
  mentionable: MentionableBlock
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  isExpanded?: boolean
  onToggleExpand?: () => void
  showDeleteButton?: boolean
}) {
  const Icon = getMentionableIcon(mentionable)
  const { t } = useLanguage()
  const content = mentionable.content ?? ''
  const trimmedContent = content.trim()
  const hasCjk = /[\u3400-\u9fff]/.test(content)
  const hasNonCjkWord = /[A-Za-z0-9]/.test(content)
  const fallbackWordCount = (text: string) => {
    const SegmenterCtor = (
      Intl as typeof Intl & {
        Segmenter?: new (
          locales?: string | string[],
          options?: { granularity: 'word' | 'sentence' | 'grapheme' },
        ) => {
          segment: (
            input: string,
          ) => Iterable<{ isWordLike?: boolean; segment: string }>
        }
      }
    ).Segmenter
    if (SegmenterCtor) {
      const segmenter = new SegmenterCtor(undefined, { granularity: 'word' })
      let total = 0
      for (const segment of segmenter.segment(text)) {
        if (segment.isWordLike) {
          const segmentHasCjk = /[\u3400-\u9fff]/.test(segment.segment)
          if (segmentHasCjk) {
            total += Array.from(
              segment.segment.replace(/[^\u3400-\u9fff]/g, ''),
            ).length
          } else {
            total += 1
          }
        }
      }
      return total
    }
    const matches = text.match(/[\p{L}\p{N}]+/gu)
    if (!matches) return 0
    return matches.reduce((sum, match) => {
      if (/[\u3400-\u9fff]/.test(match)) {
        return sum + Array.from(match.replace(/[^\u3400-\u9fff]/g, '')).length
      }
      return sum + 1
    }, 0)
  }
  const count =
    trimmedContent.length === 0 ? 0 : fallbackWordCount(trimmedContent)
  const unitLabel =
    hasCjk && hasNonCjkWord
      ? t('common.wordsCharacters', 'words/characters')
      : hasCjk
        ? t('common.characters', 'chars')
        : t('common.words', 'words')
  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      showExpandButton={true}
      showDeleteButton={showDeleteButton}
    >
      <div className="smtcmp-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="smtcmp-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.file.name}</span>
      </div>
      <div className="smtcmp-chat-user-input-file-badge-name-suffix">
        {` (${count} ${unitLabel})`}
      </div>
    </BadgeBase>
  )
}

function UrlBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  showDeleteButton,
}: {
  mentionable: MentionableUrl
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  showDeleteButton?: boolean
}) {
  const Icon = getMentionableIcon(mentionable)
  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      showExpandButton={false}
      showDeleteButton={showDeleteButton}
    >
      <div className="smtcmp-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="smtcmp-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.url}</span>
      </div>
    </BadgeBase>
  )
}

function ImageBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  isExpanded,
  onToggleExpand,
  showDeleteButton,
}: {
  mentionable: MentionableImage
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  isExpanded?: boolean
  onToggleExpand?: () => void
  showDeleteButton?: boolean
}) {
  const Icon = getMentionableIcon(mentionable)
  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      showExpandButton={true}
      showDeleteButton={showDeleteButton}
    >
      <div className="smtcmp-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="smtcmp-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.name}</span>
      </div>
    </BadgeBase>
  )
}

export default function MentionableBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused = false,
  isExpanded,
  onToggleExpand,
  showDeleteButton = true,
}: {
  mentionable: Mentionable
  onDelete: () => void
  onClick: () => void
  isFocused?: boolean
  isExpanded?: boolean
  onToggleExpand?: () => void
  showDeleteButton?: boolean
}) {
  switch (mentionable.type) {
    case 'file':
      return (
        <FileBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          isExpanded={isExpanded}
          onToggleExpand={onToggleExpand}
          showDeleteButton={showDeleteButton}
        />
      )
    case 'folder':
      return (
        <FolderBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          showDeleteButton={showDeleteButton}
        />
      )
    case 'vault':
      return (
        <VaultBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          showDeleteButton={showDeleteButton}
        />
      )
    case 'current-file':
      return (
        <CurrentFileBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          isExpanded={isExpanded}
          onToggleExpand={onToggleExpand}
          showDeleteButton={showDeleteButton}
        />
      )
    case 'block':
      return (
        <BlockBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          isExpanded={isExpanded}
          onToggleExpand={onToggleExpand}
          showDeleteButton={showDeleteButton}
        />
      )
    case 'url':
      return (
        <UrlBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          showDeleteButton={showDeleteButton}
        />
      )
    case 'image':
      return (
        <ImageBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          isExpanded={isExpanded}
          onToggleExpand={onToggleExpand}
          showDeleteButton={showDeleteButton}
        />
      )
  }
}
