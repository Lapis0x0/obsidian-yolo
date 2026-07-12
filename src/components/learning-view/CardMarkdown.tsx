import { useEffect, useRef } from 'react'

import { useApp } from '../../contexts/app-context'

import { mountCardMarkdown } from './cardMarkdownLifecycle'

export function CardMarkdown({
  markdown,
  sourcePath,
  className,
}: {
  markdown: string
  sourcePath: string
  className?: string
}) {
  const app = useApp()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    return mountCardMarkdown(app, container, markdown, sourcePath)
  }, [app, markdown, sourcePath])

  return <div ref={containerRef} className={className} />
}
