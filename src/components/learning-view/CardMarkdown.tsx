import { useEffect, useRef } from 'react'

import { mountCardMarkdown } from './cardMarkdownLifecycle'
import { useLearningUiHost } from './LearningUiHost'

export function CardMarkdown({
  markdown,
  sourcePath,
  className,
}: {
  markdown: string
  sourcePath: string
  className?: string
}) {
  const bridge = useLearningUiHost().bridge
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    return mountCardMarkdown(bridge, container, markdown, sourcePath)
  }, [bridge, markdown, sourcePath])

  return <div ref={containerRef} className={className} />
}
