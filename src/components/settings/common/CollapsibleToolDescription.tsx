import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'

type Props = {
  description: string | undefined
  name?: string
}

export function CollapsibleToolDescription({ description, name }: Props) {
  const { t } = useLanguage()
  const textRef = useRef<HTMLDivElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const el = textRef.current
    if (!el) return
    const check = () => {
      setOverflowing(el.scrollHeight - el.clientHeight > 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [description])

  const showToggle = overflowing || expanded

  const toggleButton = showToggle ? (
    <button
      type="button"
      className={
        'smtcmp-mcp-tool-description-toggle clickable-icon' +
        (expanded ? ' is-expanded' : '')
      }
      onClick={() => setExpanded((v) => !v)}
      aria-label={
        expanded
          ? t('settings.agent.collapseDescription', 'Collapse')
          : t('settings.agent.expandDescription', 'Expand')
      }
      title={
        expanded
          ? t('settings.agent.collapseDescription', 'Collapse')
          : t('settings.agent.expandDescription', 'Expand')
      }
    >
      <ChevronDown size={14} />
    </button>
  ) : null

  return (
    <div className="smtcmp-mcp-tool-description">
      {name !== undefined && (
        <div className="smtcmp-mcp-tool-description-header">
          <div className="smtcmp-mcp-tool-name">{name}</div>
          {toggleButton}
        </div>
      )}
      <div
        ref={textRef}
        className={
          'smtcmp-mcp-tool-description-text' +
          (expanded ? ' is-expanded' : ' is-clamped')
        }
      >
        {description}
      </div>
      {name === undefined && toggleButton}
    </div>
  )
}
