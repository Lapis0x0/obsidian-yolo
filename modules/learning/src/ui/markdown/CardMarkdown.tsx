import { useEffect, useRef } from 'react'

import {
  type CardMarkdownService,
  mountCardMarkdown,
} from './cardMarkdownLifecycle'

export type {
  CardMarkdownRenderer,
  CardMarkdownService,
} from './cardMarkdownLifecycle'

export function CardMarkdown({
  service,
  markdown,
  sourcePath,
  className,
}: {
  service: CardMarkdownService
  markdown: string
  sourcePath: string
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    return mountCardMarkdown(service, container, markdown, sourcePath)
  }, [markdown, service, sourcePath])

  return <div ref={containerRef} className={className} />
}
