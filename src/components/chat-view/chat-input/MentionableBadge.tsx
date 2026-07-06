import { X } from 'lucide-react'
import { PropsWithChildren } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  Mentionable,
  MentionableAssistantQuote,
  MentionableBlock,
  MentionableFile,
  MentionableFolder,
  MentionableImage,
  MentionableModel,
  MentionableOffice,
  MentionablePDF,
  MentionableTextAttachment,
  MentionableUrl,
  MentionableWebSelection,
} from '../../../types/mentionable'
import { getBlockMentionableCountInfo } from '../../../utils/chat/mentionable'

import { getMentionableIcon } from './utils/get-metionable-icon'

function BadgeBase({
  children,
  onDelete,
  onClick,
  isFocused,
  title,
  isExpanded: _isExpanded,
  onToggleExpand,
  showExpandButton = false,
  showDeleteButton = true,
}: PropsWithChildren<{
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  title?: string
  isExpanded?: boolean
  onToggleExpand?: () => void
  showExpandButton?: boolean
  showDeleteButton?: boolean
}>) {
  return (
    <div
      className={`yolo-chat-user-input-file-badge ${isFocused ? 'yolo-chat-user-input-file-badge-focused' : ''}`}
      onClick={onClick}
      title={title}
    >
      {showExpandButton && (
        <div
          className="yolo-chat-user-input-file-badge-expand"
          onClick={(evt) => {
            evt.stopPropagation()
            onToggleExpand?.()
          }}
        />
      )}
      {children}
      {showDeleteButton && (
        <div
          className="yolo-chat-user-input-file-badge-delete"
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
      showExpandButton={false}
      showDeleteButton={showDeleteButton}
    >
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
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
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.folder.name}</span>
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
  const info = getBlockMentionableCountInfo(mentionable.content)
  const count = mentionable.contentCount ?? info.count
  const unit = mentionable.contentUnit ?? info.unit
  const unitLabel = t(`common.${unit}`, unit)

  // PDF selection: show "Page N" instead of character count
  const suffix =
    mentionable.pageNumber !== undefined
      ? ` (${t('mentionable.pdfPage', 'Page {{page}}').replace('{{page}}', String(mentionable.pageNumber))})`
      : ` (${count} ${unitLabel})`

  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      showExpandButton={false}
      showDeleteButton={showDeleteButton}
    >
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.file.name}</span>
      </div>
      <div className="yolo-chat-user-input-file-badge-name-suffix">
        {suffix}
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
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.url}</span>
      </div>
    </BadgeBase>
  )
}

function WebSelectionBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  showDeleteButton,
}: {
  mentionable: MentionableWebSelection
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  showDeleteButton?: boolean
}) {
  const Icon = getMentionableIcon(mentionable)
  const { t } = useLanguage()
  const info = getBlockMentionableCountInfo(mentionable.content)
  const count = mentionable.contentCount ?? info.count
  const unit = mentionable.contentUnit ?? info.unit
  const unitLabel = t(`common.${unit}`, unit)
  const title = mentionable.title.trim() || mentionable.url

  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      showExpandButton={false}
      showDeleteButton={showDeleteButton}
      title={`${title}\n${mentionable.url}\n\n${mentionable.content}`}
    >
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{title}</span>
      </div>
      <div className="yolo-chat-user-input-file-badge-name-suffix">
        {` (${count} ${unitLabel})`}
      </div>
    </BadgeBase>
  )
}

function AssistantQuoteBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  showDeleteButton,
}: {
  mentionable: MentionableAssistantQuote
  onDelete: () => void
  onClick: () => void
  isFocused: boolean
  showDeleteButton?: boolean
}) {
  const Icon = getMentionableIcon(mentionable)
  const { t } = useLanguage()
  const info = getBlockMentionableCountInfo(mentionable.content)
  const count = mentionable.contentCount ?? info.count
  const unit = mentionable.contentUnit ?? info.unit
  const unitLabel = t(`common.${unit}`, unit)
  const quoteLabel = t('chat.assistantQuote.badge', '回复引用')

  return (
    <BadgeBase
      onDelete={onDelete}
      onClick={onClick}
      isFocused={isFocused}
      showExpandButton={false}
      showDeleteButton={showDeleteButton}
      title={mentionable.content}
    >
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{quoteLabel}</span>
      </div>
      <div className="yolo-chat-user-input-file-badge-name-suffix">
        {` (${count} ${unitLabel})`}
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
      showExpandButton={false}
      showDeleteButton={showDeleteButton}
    >
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.name}</span>
      </div>
    </BadgeBase>
  )
}

function PdfBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  showDeleteButton,
}: {
  mentionable: MentionablePDF
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
      title={mentionable.name}
    >
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.name}</span>
      </div>
    </BadgeBase>
  )
}

function OfficeBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  showDeleteButton,
}: {
  mentionable: MentionableOffice
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
      title={mentionable.name}
    >
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.name}</span>
      </div>
    </BadgeBase>
  )
}

function TextAttachmentBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  showDeleteButton,
}: {
  mentionable: MentionableTextAttachment
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
      title={mentionable.name}
    >
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
          />
        )}
        <span>{mentionable.name}</span>
      </div>
    </BadgeBase>
  )
}

function ModelBadge({
  mentionable,
  onDelete,
  onClick,
  isFocused,
  showDeleteButton,
}: {
  mentionable: MentionableModel
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
      <div className="yolo-chat-user-input-file-badge-name">
        {Icon && (
          <Icon
            size={12}
            className="yolo-chat-user-input-file-badge-name-icon"
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
    case 'assistant-quote':
      return (
        <AssistantQuoteBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
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
    case 'web-selection':
      return (
        <WebSelectionBadge
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
    case 'pdf':
      return (
        <PdfBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          showDeleteButton={showDeleteButton}
        />
      )
    case 'office':
      return (
        <OfficeBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          showDeleteButton={showDeleteButton}
        />
      )
    case 'text-attachment':
      return (
        <TextAttachmentBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          showDeleteButton={showDeleteButton}
        />
      )
    case 'model':
      return (
        <ModelBadge
          mentionable={mentionable}
          onDelete={onDelete}
          onClick={onClick}
          isFocused={isFocused}
          showDeleteButton={showDeleteButton}
        />
      )
  }
}
