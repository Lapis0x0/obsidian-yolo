import { Check, CopyIcon, Loader2, Play } from 'lucide-react'
import { PropsWithChildren, useId, useMemo, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import {
  getTextEditPlanPreviewContent,
  parseTextEditPlan,
} from '../../core/edits/textEditPlan'
import { openMarkdownFile } from '../../utils/obsidian'

import { ObsidianMarkdown } from './ObsidianMarkdown'

export default function MarkdownCodeComponent({
  onApply,
  isApplying,
  activeApplyRequestKey,
  filename,
  children,
}: PropsWithChildren<{
  onApply: (
    blockToApply: string,
    applyRequestKey: string,
    targetFilePath?: string,
  ) => void
  isApplying: boolean
  activeApplyRequestKey: string | null
  filename?: string
}>) {
  const app = useApp()
  const { t } = useLanguage()
  const applyRequestKeyBase = useId()

  const [copied, setCopied] = useState(false)
  const applyRequestKey = `${applyRequestKeyBase}:apply`
  const isBlockApplying =
    isApplying && activeApplyRequestKey === applyRequestKey

  const codeContent = useMemo(() => {
    if (typeof children === 'string') {
      return children
    }
    if (typeof children === 'number' || typeof children === 'boolean') {
      return String(children)
    }
    if (Array.isArray(children)) {
      return children
        .map((child) => {
          if (typeof child === 'string') return child
          if (typeof child === 'number' || typeof child === 'boolean') {
            return String(child)
          }
          if (child && typeof child === 'object' && 'props' in child) {
            const nested = (child as { props?: { children?: unknown } }).props
              ?.children
            return typeof nested === 'string' ? nested : ''
          }
          return ''
        })
        .join('')
    }
    if (children && typeof children === 'object' && 'props' in children) {
      const nested = (children as { props?: { children?: unknown } }).props
        ?.children
      if (typeof nested === 'string') {
        return nested
      }
    }
    return ''
  }, [children])

  const parsedPlan = useMemo(() => {
    return parseTextEditPlan(codeContent, {
      requireDocumentType: true,
    })
  }, [codeContent])

  const previewContent = useMemo(() => {
    if (!parsedPlan) {
      return codeContent
    }

    const rendered = getTextEditPlanPreviewContent(parsedPlan)
    return rendered || ''
  }, [codeContent, parsedPlan])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy text: ', err)
    }
  }

  const handleOpenFile = () => {
    if (filename) {
      openMarkdownFile(app, filename)
    }
  }

  return (
    <div className="smtcmp-code-block">
      <div className="smtcmp-code-block-header">
        {filename && (
          <div
            className="smtcmp-code-block-header-filename"
            onClick={handleOpenFile}
          >
            {filename}
          </div>
        )}
        <div className="smtcmp-code-block-header-button-container">
          <button
            type="button"
            className="clickable-icon smtcmp-code-block-header-button"
            onClick={() => {
              void handleCopy()
            }}
          >
            {copied ? (
              <>
                <Check size={10} />
                <span>{t('chat.codeBlock.textCopied', 'Text copied')}</span>
              </>
            ) : (
              <>
                <CopyIcon size={10} />
                <span>{t('chat.codeBlock.copyText', 'Copy text')}</span>
              </>
            )}
          </button>
          <button
            type="button"
            className="clickable-icon smtcmp-code-block-header-button"
            onClick={
              parsedPlan && isApplying && !isBlockApplying
                ? undefined
                : () => {
                    if (!parsedPlan) {
                      return
                    }
                    onApply(codeContent, applyRequestKey, filename)
                  }
            }
            aria-disabled={parsedPlan ? isApplying && !isBlockApplying : true}
            hidden={!parsedPlan}
          >
            {isBlockApplying ? (
              <>
                <Loader2 className="smtcmp-spinner" size={14} />
                <span>{t('chat.codeBlock.stopApplying', 'Stop apply')}</span>
              </>
            ) : (
              <>
                <Play size={10} />
                <span>{t('chat.codeBlock.apply', 'Apply')}</span>
              </>
            )}
          </button>
        </div>
      </div>
      <div className="smtcmp-code-block-obsidian-markdown">
        <ObsidianMarkdown
          content={
            parsedPlan && previewContent.length === 0
              ? t(
                  'chat.codeBlock.emptyPlanPreview',
                  'This plan removes content',
                )
              : previewContent
          }
          scale="sm"
        />
      </div>
    </div>
  )
}
