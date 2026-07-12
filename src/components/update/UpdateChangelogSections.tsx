import type { ReactNode } from 'react'

import type { ChangelogSection } from '../../core/update/updateChecker'

function renderInlineMarkdown(text: string, allowBold = true): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0

  while (cursor < text.length) {
    const codeStart = text.indexOf('`', cursor)
    const boldStart = allowBold ? text.indexOf('**', cursor) : -1
    const starts = [codeStart, boldStart].filter((index) => index >= 0)
    const start = starts.length ? Math.min(...starts) : -1

    if (start < 0) {
      nodes.push(text.slice(cursor))
      break
    }
    if (start > cursor) nodes.push(text.slice(cursor, start))

    if (start === codeStart) {
      const end = text.indexOf('`', start + 1)
      if (end < 0) {
        nodes.push(text.slice(start))
        break
      }
      nodes.push(
        <code key={key++} className="yolo-update-toast-code">
          {text.slice(start + 1, end)}
        </code>,
      )
      cursor = end + 1
      continue
    }

    const end = text.indexOf('**', start + 2)
    if (end < 0) {
      nodes.push(text.slice(start))
      break
    }
    nodes.push(
      <strong key={key++} className="yolo-update-toast-strong">
        {renderInlineMarkdown(text.slice(start + 2, end), false)}
      </strong>,
    )
    cursor = end + 2
  }

  return nodes
}

function InlineText({ text }: { text: string }) {
  return <>{renderInlineMarkdown(text)}</>
}

type UpdateChangelogSectionsProps = {
  sections: ChangelogSection[]
  separator: string
}

export function UpdateChangelogSections({
  sections,
  separator,
}: UpdateChangelogSectionsProps) {
  return (
    <div className="yolo-update-toast-sections">
      {sections.map((section, si) => (
        <div className="yolo-update-toast-section" key={si}>
          {section.name ? (
            <div className="yolo-update-toast-section-head">
              <span
                className={`yolo-update-toast-dot yolo-update-toast-dot--${section.tone}`}
                aria-hidden
              />
              <span>{section.name}</span>
            </div>
          ) : null}
          <ul className="yolo-update-toast-items">
            {section.items.map((item, ii) => (
              <li className="yolo-update-toast-item" key={ii}>
                <span className="yolo-update-toast-bullet" aria-hidden>
                  —
                </span>
                <span className="yolo-update-toast-item-text">
                  {item.title ? (
                    <span className="yolo-update-toast-item-title">
                      {item.title}
                    </span>
                  ) : null}
                  {item.ref ? (
                    <span className="yolo-update-toast-item-ref">
                      {item.ref}
                    </span>
                  ) : null}
                  {item.title && item.body ? <span>{separator}</span> : null}
                  <InlineText text={item.body} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
