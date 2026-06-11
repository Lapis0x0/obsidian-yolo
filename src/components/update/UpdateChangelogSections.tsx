import { Fragment } from 'react'

import type { ChangelogSection } from '../../core/update/updateChecker'

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <>
      {parts.map((part, index) =>
        part.length > 1 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={index} className="yolo-update-toast-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  )
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
