import { Component, MarkdownRenderer, MarkdownView } from 'obsidian'
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { ApplyViewState } from '../../ApplyView'
import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import {
  DiffBlock,
  InlineDiffLine,
  InlineDiffToken,
  createDiffBlocks,
} from '../../utils/chat/diff'

// Decision type for each diff block
type BlockDecision = 'pending' | 'incoming' | 'current'

export default function ApplyViewRoot({
  state,
  close,
}: {
  state: ApplyViewState
  close: () => void
}) {
  const [, setCurrentDiffIndex] = useState(0)
  const diffBlockRefs = useRef<(HTMLDivElement | null)[]>([])
  const scrollerRef = useRef<HTMLDivElement>(null)

  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()

  const diff = useMemo(
    () =>
      splitDiffBlocksByLine(
        createDiffBlocks(state.originalContent, state.newContent),
      ),
    [state.newContent, state.originalContent],
  )

  // Track decisions for each modified block
  const [decisions, setDecisions] = useState<Map<number, BlockDecision>>(
    () => new Map(),
  )

  const modifiedBlockIndices = useMemo(
    () =>
      diff.reduce<number[]>((acc, block, index) => {
        if (block.type !== 'unchanged') {
          acc.push(index)
        }
        return acc
      }, []),
    [diff],
  )

  // Count of decided and pending blocks
  const decidedCount = useMemo(
    () =>
      modifiedBlockIndices.filter(
        (idx) => decisions.get(idx) && decisions.get(idx) !== 'pending',
      ).length,
    [decisions, modifiedBlockIndices],
  )
  const totalModifiedBlocks = modifiedBlockIndices.length

  // Generate final content based on decisions
  const generateFinalContent = useCallback(
    (defaultDecision: 'incoming' | 'current' = 'current') => {
      return diff
        .map((block, index) => {
          if (block.type === 'unchanged') return block.value
          const original = block.originalValue
          const incoming = block.modifiedValue
          const decision = decisions.get(index) ?? defaultDecision
          const resolveIncoming = () =>
            incoming !== undefined ? incoming : (original ?? '')
          const resolveCurrent = () => original ?? ''

          switch (decision) {
            case 'incoming':
              return resolveIncoming()
            case 'current':
            case 'pending':
              return decision === 'pending' && defaultDecision === 'incoming'
                ? resolveIncoming()
                : resolveCurrent()
            default:
              return resolveCurrent()
          }
        })
        .join('\n')
    },
    [diff, decisions],
  )

  const applyAndClose = async () => {
    const newContent = generateFinalContent('current')
    await app.vault.modify(state.file, newContent)

    // Try to focus an existing leaf showing this file to avoid duplicates
    const targetLeaf = app.workspace
      .getLeavesOfType('markdown')
      .find((leaf) => {
        const view = leaf.view
        return (
          view instanceof MarkdownView && view.file?.path === state.file.path
        )
      })

    close()

    if (targetLeaf) {
      app.workspace.setActiveLeaf(targetLeaf, { focus: true })
      return
    }

    // If no existing leaf, open the file once
    const leaf = app.workspace.getLeaf(true)
    await leaf.openFile(state.file)
    app.workspace.setActiveLeaf(leaf, { focus: true })
  }

  // Individual block decisions (don't close, just mark decision)
  const makeDecision = useCallback((index: number, decision: BlockDecision) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      next.set(index, decision)
      return next
    })
  }, [])

  const acceptIncomingBlock = useCallback(
    (index: number) => {
      makeDecision(index, 'incoming')
    },
    [makeDecision],
  )

  const acceptCurrentBlock = useCallback(
    (index: number) => {
      makeDecision(index, 'current')
    },
    [makeDecision],
  )

  // Undo a decision
  const undoDecision = useCallback((index: number) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      next.delete(index)
      return next
    })
  }, [])

  // Global actions
  const acceptAllIncoming = useCallback(() => {
    const newDecisions = new Map<number, BlockDecision>()
    modifiedBlockIndices.forEach((idx) => {
      newDecisions.set(idx, 'incoming')
    })
    setDecisions(newDecisions)
  }, [modifiedBlockIndices])

  const acceptAllCurrent = useCallback(() => {
    const newDecisions = new Map<number, BlockDecision>()
    modifiedBlockIndices.forEach((idx) => {
      newDecisions.set(idx, 'current')
    })
    setDecisions(newDecisions)
  }, [modifiedBlockIndices])

  const resetAllDecisions = useCallback(() => {
    setDecisions(new Map())
  }, [])

  const updateCurrentDiffFromScroll = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const scrollerRect = scroller.getBoundingClientRect()
    const scrollerTop = scrollerRect.top
    const visibleThreshold = 10 // pixels from top to consider element "visible"

    // Find the first visible diff block
    for (let i = 0; i < modifiedBlockIndices.length; i++) {
      const element = diffBlockRefs.current[modifiedBlockIndices[i]]
      if (!element) continue

      const rect = element.getBoundingClientRect()
      const relativeTop = rect.top - scrollerTop

      // If element is visible (slightly below the top of the viewport)
      if (relativeTop >= -visibleThreshold) {
        setCurrentDiffIndex(i)
        break
      }
    }
  }, [modifiedBlockIndices])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const handleScroll = () => {
      updateCurrentDiffFromScroll()
    }

    scroller.addEventListener('scroll', handleScroll)
    return () => scroller.removeEventListener('scroll', handleScroll)
  }, [updateCurrentDiffFromScroll])

  return (
    <div id="smtcmp-apply-view">
      <div className="view-header">
        <div className="view-header-title-container mod-at-start">
          <div className="view-header-title">
            {t('applyView.applying', 'Applying')}: {state?.file?.name ?? ''}
          </div>
        </div>
      </div>

      <div className="view-content">
        <div className="markdown-source-view cm-s-obsidian mod-cm6 node-insert-event is-readable-line-width is-live-preview is-folding show-properties">
          <div className="cm-editor">
            <div className="cm-scroller" ref={scrollerRef}>
              <div className="cm-sizer">
                <div className="smtcmp-apply-content">
                  <div className="inline-title smtcmp-inline-title">
                    {state?.file?.name
                      ? state.file.name.replace(/\.[^/.]+$/, '')
                      : ''}
                  </div>

                  {diff.map((block, index) => (
                    <DiffBlockView
                      key={index}
                      block={block}
                      decision={decisions.get(index)}
                      sourcePath={state.file.path}
                      onAcceptIncoming={() => acceptIncomingBlock(index)}
                      onAcceptCurrent={() => acceptCurrentBlock(index)}
                      onUndo={() => undoDecision(index)}
                      t={t}
                      pluginComponent={plugin}
                      ref={(el) => {
                        diffBlockRefs.current[index] = el
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Global actions toolbar (bottom) */}
      <div className="smtcmp-apply-toolbar smtcmp-apply-toolbar-bottom">
        <div className="smtcmp-apply-toolbar-left">
          <span className="smtcmp-apply-progress">
            {decidedCount} / {totalModifiedBlocks}{' '}
            {t('applyView.changesResolved', 'changes resolved')}
          </span>
        </div>
        <div className="smtcmp-apply-toolbar-right">
          <button
            onClick={acceptAllIncoming}
            className="smtcmp-toolbar-btn smtcmp-accept"
            title={t(
              'applyView.acceptAllIncoming',
              'Accept all incoming changes',
            )}
          >
            {t('applyView.acceptAllIncoming', 'Accept All Incoming')}
          </button>
          <button
            onClick={acceptAllCurrent}
            className="smtcmp-toolbar-btn smtcmp-exclude"
            title={t(
              'applyView.rejectAll',
              'Reject all changes (keep original)',
            )}
          >
            {t('applyView.rejectAll', 'Reject All')}
          </button>
          {decidedCount > 0 && (
            <button
              onClick={resetAllDecisions}
              className="smtcmp-toolbar-btn"
              title={t('applyView.reset', 'Reset all decisions')}
            >
              {t('applyView.reset', 'Reset')}
            </button>
          )}
          <button
            onClick={() => void applyAndClose()}
            className="smtcmp-toolbar-btn smtcmp-apply-btn"
            title={t('applyView.applyAndClose', 'Apply changes and close')}
          >
            {t('applyView.applyAndClose', 'Apply & Close')}
          </button>
        </div>
      </div>
    </div>
  )
}

const DiffBlockView = forwardRef<
  HTMLDivElement,
  {
    block: DiffBlock
    decision?: BlockDecision
    sourcePath: string
    onAcceptIncoming: () => void
    onAcceptCurrent: () => void
    onUndo: () => void
    t: (keyPath: string, fallback?: string) => string
    pluginComponent: Component
  }
>(
  (
    {
      block: part,
      decision,
      sourcePath,
      onAcceptIncoming,
      onAcceptCurrent,
       
      onUndo: _onUndo,
      t,
      pluginComponent,
    },
    ref,
  ) => {
    const inlineLines = part.type === 'modified' ? part.inlineLines : undefined
    const modifiedValue =
      part.type === 'modified' ? part.modifiedValue : undefined
    const originalValue =
      part.type === 'modified' ? part.originalValue : undefined
    const inlineMarkdown = useMemo(() => {
      if (part.type !== 'modified') return ''
      const markdown = buildInlineDiffMarkdown(inlineLines ?? [])
      if (markdown.trim().length > 0) return markdown
      return modifiedValue ?? originalValue ?? ''
    }, [inlineLines, modifiedValue, originalValue, part.type])
    const inlineParagraphs = useMemo<ApplyParagraph[]>(() => {
      if (part.type !== 'modified') return []
      return splitInlineLinesIntoParagraphs(inlineLines ?? [])
    }, [inlineLines, part.type])

    if (part.type === 'unchanged') {
      return (
        <div className="smtcmp-diff-block">
          <div className="smtcmp-diff-block-content">
            <ApplyMarkdownContent
              content={part.value}
              component={pluginComponent}
              sourcePath={sourcePath}
              className="smtcmp-apply-markdown"
            />
          </div>
        </div>
      )
    } else if (part.type === 'modified') {
      const isDecided = decision && decision !== 'pending'

      // Show preview of the decision result
      const getDecisionPreview = () => {
        if (!isDecided) return null
        const original = part.originalValue
        const incoming = part.modifiedValue
        const resolveIncoming = () =>
          incoming !== undefined ? incoming : (original ?? '')
        const resolveCurrent = () => original ?? ''

        switch (decision) {
          case 'incoming':
            return resolveIncoming()
          case 'current':
            return resolveCurrent()
          default:
            return null
        }
      }

      return (
        <div className="smtcmp-diff-block-container" ref={ref}>
          {isDecided ? (
            // Show resolved content only
            <>
              <div className="smtcmp-diff-block smtcmp-diff-block--resolved">
                <div className="smtcmp-diff-block-content">
                  <ApplyMarkdownContent
                    content={getDecisionPreview() ?? ''}
                    component={pluginComponent}
                    sourcePath={sourcePath}
                    className="smtcmp-apply-markdown smtcmp-apply-markdown-preview"
                  />
                </div>
              </div>
            </>
          ) : (
            // Show original diff view with actions
            <>
              <div className="smtcmp-diff-block smtcmp-diff-block--inline">
                {inlineParagraphs.length > 0 ? (
                  inlineParagraphs.map((paragraph, paragraphIndex) => {
                    const paragraphContent = paragraph.isEmpty
                      ? ''
                      : buildInlineDiffMarkdown(paragraph.lines)
                    return (
                      <div
                        key={`${paragraphIndex}-${paragraph.isEmpty ? 'empty' : 'content'}`}
                        className={`smtcmp-apply-paragraph${
                          paragraph.isEmpty ? ' is-empty' : ''
                        }${paragraph.hasChanges ? ' has-changes' : ''}`}
                      >
                        <div className="smtcmp-diff-block-content">
                          {paragraph.isEmpty ? (
                            <div className="smtcmp-apply-empty-line" />
                          ) : (
                            <ApplyMarkdownContent
                              content={paragraphContent}
                              component={pluginComponent}
                              sourcePath={sourcePath}
                              className="smtcmp-apply-markdown smtcmp-apply-inline-markdown"
                            />
                          )}
                        </div>
                        {paragraph.hasChanges && (
                          <span className="smtcmp-apply-paragraph-indicator" />
                        )}
                        {paragraph.hasChanges && (
                          <div className="smtcmp-diff-block-actions">
                            <button
                              onClick={onAcceptIncoming}
                              className="smtcmp-apply-action smtcmp-apply-action-accept"
                              title={t(
                                'applyView.acceptIncoming',
                                'Accept incoming',
                              )}
                              aria-label={t(
                                'applyView.acceptIncoming',
                                'Accept incoming',
                              )}
                            >
                              <span
                                className="smtcmp-apply-action-icon"
                                aria-hidden="true"
                              >
                                ✓
                              </span>
                            </button>
                            <button
                              onClick={onAcceptCurrent}
                              className="smtcmp-apply-action smtcmp-apply-action-reject"
                              title={t(
                                'applyView.acceptCurrent',
                                'Accept current',
                              )}
                              aria-label={t(
                                'applyView.acceptCurrent',
                                'Accept current',
                              )}
                            >
                              <span
                                className="smtcmp-apply-action-icon"
                                aria-hidden="true"
                              >
                                ×
                              </span>
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })
                ) : (
                  <div className="smtcmp-apply-paragraph has-changes">
                    <div className="smtcmp-diff-block-content">
                      <ApplyMarkdownContent
                        content={inlineMarkdown}
                        component={pluginComponent}
                        sourcePath={sourcePath}
                        className="smtcmp-apply-markdown smtcmp-apply-inline-markdown"
                      />
                    </div>
                    <span className="smtcmp-apply-paragraph-indicator" />
                    <div className="smtcmp-diff-block-actions">
                      <button
                        onClick={onAcceptIncoming}
                        className="smtcmp-apply-action smtcmp-apply-action-accept"
                        title={t('applyView.acceptIncoming', 'Accept incoming')}
                        aria-label={t(
                          'applyView.acceptIncoming',
                          'Accept incoming',
                        )}
                      >
                        <span
                          className="smtcmp-apply-action-icon"
                          aria-hidden="true"
                        >
                          ✓
                        </span>
                      </button>
                      <button
                        onClick={onAcceptCurrent}
                        className="smtcmp-apply-action smtcmp-apply-action-reject"
                        title={t('applyView.acceptCurrent', 'Accept current')}
                        aria-label={t(
                          'applyView.acceptCurrent',
                          'Accept current',
                        )}
                      >
                        <span
                          className="smtcmp-apply-action-icon"
                          aria-hidden="true"
                        >
                          ×
                        </span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )
    }
  },
)

DiffBlockView.displayName = 'DiffBlockView'

function ApplyMarkdownContent({
  content,
  component,
  sourcePath,
  className,
}: {
  content: string
  component: Component
  sourcePath: string
  className?: string
}) {
  const app = useApp()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    containerRef.current.replaceChildren()
    void MarkdownRenderer.render(
      app,
      content,
      containerRef.current,
      sourcePath,
      component,
    )
  }, [app, component, content, sourcePath])

  return (
    <div
      ref={containerRef}
      className={`markdown-rendered smtcmp-markdown-rendered ${className ?? ''}`}
    />
  )
}

type ApplyParagraph = {
  lines: InlineDiffLine[]
  hasChanges: boolean
  isEmpty: boolean
}

function splitInlineLinesIntoParagraphs(
  lines: InlineDiffLine[],
): ApplyParagraph[] {
  if (lines.length === 0) return []

  const paragraphs: ApplyParagraph[] = lines.map((line) => {
    const isEmpty = isInlineLineEmpty(line)
    return {
      lines: isEmpty ? [] : [line],
      hasChanges: lineHasChanges(line),
      isEmpty,
    }
  })
  const hasAnyChanges = paragraphs.some(
    (paragraph) => !paragraph.isEmpty && paragraph.hasChanges,
  )
  if (!hasAnyChanges) {
    const firstContentParagraph = paragraphs.find(
      (paragraph) => !paragraph.isEmpty,
    )
    if (firstContentParagraph) {
      firstContentParagraph.hasChanges = true
    }
  }
  return paragraphs
}

function isInlineLineEmpty(line: InlineDiffLine): boolean {
  const content = line.tokens.map((token) => token.text).join('')
  return content.trim().length === 0
}

function lineHasChanges(line: InlineDiffLine): boolean {
  if (line.type === 'added' || line.type === 'removed') return true
  return line.tokens.some(
    (token) => token.type === 'add' || token.type === 'del',
  )
}

function splitDiffBlocksByLine(blocks: DiffBlock[]): DiffBlock[] {
  const lineBlocks: DiffBlock[] = []

  blocks.forEach((block) => {
    if (block.type === 'unchanged') {
      lineBlocks.push(block)
      return
    }

    if (block.inlineLines.length === 0) {
      lineBlocks.push(block)
      return
    }

    block.inlineLines.forEach((line) => {
      if (line.type === 'unchanged') {
        lineBlocks.push({
          type: 'unchanged',
          value: inlineLineToText(line, 'original'),
        })
        return
      }

      const originalLine =
        line.type === 'added' ? undefined : inlineLineToText(line, 'original')
      const modifiedLine =
        line.type === 'removed' ? undefined : inlineLineToText(line, 'modified')

      lineBlocks.push({
        type: 'modified',
        originalValue: originalLine,
        modifiedValue: modifiedLine,
        inlineLines: [line],
      })
    })
  })

  return mergeAdjacentUnchangedBlocks(lineBlocks)
}

function mergeAdjacentUnchangedBlocks(blocks: DiffBlock[]): DiffBlock[] {
  const merged: DiffBlock[] = []
  blocks.forEach((block) => {
    const last = merged[merged.length - 1]
    if (block.type === 'unchanged' && last?.type === 'unchanged') {
      last.value = `${last.value}\n${block.value}`
      return
    }
    merged.push(block)
  })
  return merged
}

function inlineLineToText(
  line: InlineDiffLine,
  variant: 'original' | 'modified',
): string {
  return inlineTokensToText(line.tokens, variant)
}

function inlineTokensToText(
  tokens: InlineDiffToken[],
  variant: 'original' | 'modified',
): string {
  return tokens
    .filter((token) =>
      variant === 'original' ? token.type !== 'add' : token.type !== 'del',
    )
    .map((token) => token.text)
    .join('')
}

function buildInlineDiffMarkdown(lines: InlineDiffLine[]): string {
  return lines.map((line) => inlineTokensToMarkdown(line.tokens)).join('\n')
}

function inlineTokensToMarkdown(tokens: InlineDiffToken[]): string {
  return tokens
    .map((token) => {
      const text = escapeHtml(token.text)
      if (token.type === 'add') {
        return `<span class="smtcmp-inline-diff smtcmp-inline-diff-add">${text}</span>`
      }
      if (token.type === 'del') {
        return `<span class="smtcmp-inline-diff smtcmp-inline-diff-del">${text}</span>`
      }
      return text
    })
    .join('')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
