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
import { DiffBlock, createDiffBlocks } from '../../utils/chat/diff'

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

  const diff = useMemo(
    () => createDiffBlocks(state.originalContent, state.newContent),
    [state.newContent, state.originalContent],
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

  const scrollToDiffBlock = useCallback(
    (index: number) => {
      if (index >= 0 && index < modifiedBlockIndices.length) {
        const element = diffBlockRefs.current[modifiedBlockIndices[index]]
        if (element) {
          element.scrollIntoView({ block: 'start' })
          setCurrentDiffIndex(index)
        }
      }
    },
    [modifiedBlockIndices],
  )

  const applyContentAndClose = async (newContent: string) => {
    await app.vault.modify(state.file, newContent)
    close()
  }

  const acceptCurrentBlock = () => {
    // Immediately apply: keep current (original) for all blocks
    const newContent = diff
      .map((block) => {
        if (block.type === 'unchanged') return block.value
        return block.originalValue ?? ''
      })
      .join('\n')
    void applyContentAndClose(newContent)
  }

  const acceptIncomingBlock = (index: number) => {
    // Immediately apply: accept incoming for the chosen block, keep others as current
    const newContent = diff
      .map((block, i) => {
        if (block.type === 'unchanged') return block.value
        const original = block.originalValue ?? ''
        const incoming = block.modifiedValue ?? ''
        if (i === index) return incoming || original
        // keep others as current (no change)
        return original
      })
      .join('\n')
    void applyContentAndClose(newContent)
  }

  const acceptBothBlocks = (index: number) => {
    // Immediately apply: for the chosen block, merge both; others keep current
    const newContent = diff
      .map((block, i) => {
        if (block.type === 'unchanged') return block.value
        const original = block.originalValue ?? ''
        const incoming = block.modifiedValue ?? ''
        if (i === index) return [original, incoming].filter(Boolean).join('\n')
        return original
      })
      .join('\n')
    void applyContentAndClose(newContent)
  }

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

  useEffect(() => {
    if (modifiedBlockIndices.length > 0) {
      scrollToDiffBlock(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div id="smtcmp-apply-view">
      <div className="view-header">
        <div className="view-header-title-container mod-at-start">
          <div className="view-header-title">
            Applying: {state?.file?.name ?? ''}
          </div>
        </div>
      </div>

      <div className="view-content">
        <div className="markdown-source-view cm-s-obsidian mod-cm6 node-insert-event is-readable-line-width is-live-preview is-folding show-properties">
          <div className="cm-editor">
            <div className="cm-scroller" ref={scrollerRef}>
              <div className="cm-sizer">
                <div className="smtcmp-inline-title">
                  {state?.file?.name
                    ? state.file.name.replace(/\.[^/.]+$/, '')
                    : ''}
                </div>

                {diff.map((block, index) => (
                  <DiffBlockView
                    key={index}
                    block={block}
                    onAcceptIncoming={() => acceptIncomingBlock(index)}
                    onAcceptCurrent={acceptCurrentBlock}
                    onAcceptBoth={() => acceptBothBlocks(index)}
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
  )
}

const DiffBlockView = forwardRef<
  HTMLDivElement,
  {
    block: DiffBlock
    onAcceptIncoming: () => void
    onAcceptCurrent: () => void
    onAcceptBoth: () => void
  }
>(({ block: part, onAcceptIncoming, onAcceptCurrent, onAcceptBoth }, ref) => {
  if (part.type === 'unchanged') {
    return (
      <div className="smtcmp-diff-block">
        <div className="smtcmp-diff-block-content">{part.value}</div>
      </div>
    )
  } else if (part.type === 'modified') {
    return (
      <div className="smtcmp-diff-block-container" ref={ref}>
        {part.originalValue && part.originalValue.length > 0 && (
          <div className="smtcmp-diff-block removed">
            <div className="smtcmp-diff-block-content">
              {part.originalValue}
            </div>
          </div>
        )}
        {part.modifiedValue && part.modifiedValue.length > 0 && (
          <div className="smtcmp-diff-block added">
            <div className="smtcmp-diff-block-content">
              {part.modifiedValue}
            </div>
          </div>
        )}
        <div className="smtcmp-diff-block-actions">
          <button onClick={onAcceptIncoming} className="smtcmp-accept">
            Accept Incoming
          </button>
          <button onClick={onAcceptCurrent} className="smtcmp-exclude">
            Accept Current
          </button>
          <button onClick={onAcceptBoth}>Accept Both</button>
        </div>
      </div>
    )
  }
})

DiffBlockView.displayName = 'DiffBlockView'
