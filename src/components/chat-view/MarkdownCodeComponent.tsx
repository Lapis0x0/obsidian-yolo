import { Check, CopyIcon, Loader2, Play } from 'lucide-react'
import {
  PropsWithChildren,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import DotLoader from '../common/DotLoader'
import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import {
  getStreamingTextEditPlanPreviewContent,
  getTextEditPlanPreviewContent,
  parseTextEditPlan,
} from '../../core/edits/textEditPlan'
import { openMarkdownFile } from '../../utils/obsidian'

import { ObsidianMarkdown } from './ObsidianMarkdown'

const PLAN_CONTENT_TRANSITION_MS = 260

const trimLeadingBlankLines = (value: string): string => {
  return value.replace(/^(?:\r?\n)+/, '')
}

export default function MarkdownCodeComponent({
  onApply,
  isApplying,
  activeApplyRequestKey,
  filename,
  language,
  generationState,
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
  language?: string
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
}>) {
  const app = useApp()
  const { t } = useLanguage()
  const applyRequestKeyBase = useId()

  const [copied, setCopied] = useState(false)
  const [isTransitioningToContent, setIsTransitioningToContent] =
    useState(false)
  const applyRequestKey = `${applyRequestKeyBase}:apply`
  const isBlockApplying =
    isApplying && activeApplyRequestKey === applyRequestKey
  const transitionTimeoutRef = useRef<number | null>(null)
  const previousStreamingStatusVisibleRef = useRef(false)

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

  const isPartialJsonPreviewBlock =
    (generationState === 'streaming' ||
      generationState === 'aborted' ||
      generationState === 'error') &&
    language === 'json'

  const streamingPreviewContent = useMemo(() => {
    if (!isPartialJsonPreviewBlock || parsedPlan) {
      return ''
    }

    return getStreamingTextEditPlanPreviewContent(codeContent)
  }, [codeContent, isPartialJsonPreviewBlock, parsedPlan])

  const isStreamingPlanStatusVisible =
    generationState === 'streaming' &&
    isPartialJsonPreviewBlock &&
    !parsedPlan &&
    streamingPreviewContent.length === 0

  const previewContent = useMemo(() => {
    if (streamingPreviewContent.length > 0) {
      return streamingPreviewContent
    }

    if (!parsedPlan) {
      return codeContent
    }

    const rendered = getTextEditPlanPreviewContent(parsedPlan)
    return rendered || ''
  }, [codeContent, parsedPlan, streamingPreviewContent])

  const streamingStatusLabel = useMemo(() => {
    return t('chat.codeBlock.locatingTarget', '正在定位待替换内容...')
  }, [t])

  useEffect(() => {
    const wasStreamingStatusVisible = previousStreamingStatusVisibleRef.current

    if (transitionTimeoutRef.current !== null) {
      window.clearTimeout(transitionTimeoutRef.current)
      transitionTimeoutRef.current = null
    }

    if (isStreamingPlanStatusVisible) {
      setIsTransitioningToContent(false)
    } else if (wasStreamingStatusVisible) {
      setIsTransitioningToContent(true)
      transitionTimeoutRef.current = window.setTimeout(() => {
        setIsTransitioningToContent(false)
        transitionTimeoutRef.current = null
      }, PLAN_CONTENT_TRANSITION_MS)
    }

    previousStreamingStatusVisibleRef.current = isStreamingPlanStatusVisible

    return () => {
      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current)
        transitionTimeoutRef.current = null
      }
    }
  }, [isStreamingPlanStatusVisible])

  const shouldOverlayPlanPanels =
    isStreamingPlanStatusVisible || isTransitioningToContent
  const renderedPreviewContent =
    parsedPlan && previewContent.length === 0
      ? t('chat.codeBlock.emptyPlanPreview', 'This plan removes content')
      : previewContent

  const handleCopy = async () => {
    const copyPayload = parsedPlan
      ? trimLeadingBlankLines(previewContent)
      : streamingPreviewContent.length > 0
        ? trimLeadingBlankLines(streamingPreviewContent)
        : codeContent

    try {
      await navigator.clipboard.writeText(copyPayload)
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
          <button
            type="button"
            className="smtcmp-code-block-header-filename"
            onClick={handleOpenFile}
          >
            {filename}
          </button>
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
      <div
        className={`smtcmp-code-block-obsidian-markdown${
          shouldOverlayPlanPanels ? ' is-plan-transitioning' : ''
        }`}
      >
        {(isStreamingPlanStatusVisible || isTransitioningToContent) && (
          <div
            className={`smtcmp-plan-preview-panel smtcmp-plan-preview-panel--streaming${
              isTransitioningToContent ? ' is-exiting' : ''
            }`}
            aria-live="polite"
          >
            <div className="smtcmp-plan-streaming-preview">
              <div className="smtcmp-plan-streaming-preview-header">
                <span className="smtcmp-plan-streaming-preview-status-dot" />
                <span className="smtcmp-plan-streaming-preview-title">
                  {streamingStatusLabel}
                </span>
                <DotLoader
                  variant="dots"
                  className="smtcmp-plan-streaming-preview-loader"
                />
              </div>
              <div className="smtcmp-plan-streaming-preview-body" aria-hidden>
                <span className="smtcmp-plan-streaming-preview-line is-wide" />
                <span className="smtcmp-plan-streaming-preview-line is-short" />
              </div>
            </div>
          </div>
        )}
        {(!isStreamingPlanStatusVisible || isTransitioningToContent) && (
          <div
            className={`smtcmp-plan-preview-panel smtcmp-plan-preview-panel--resolved${
              isTransitioningToContent ? ' is-entering' : ''
            }`}
          >
            <ObsidianMarkdown content={renderedPreviewContent} scale="sm" />
          </div>
        )}
      </div>
    </div>
  )
}
