import { Plus, X } from 'lucide-react'
import { useState } from 'react'

export type StringListInputProps = {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  addLabel?: string
  removeLabel?: string
}

export function StringListInput({
  value,
  onChange,
  placeholder,
  addLabel = 'Add',
  removeLabel = 'Remove',
}: StringListInputProps) {
  const [draft, setDraft] = useState('')

  const addDraft = () => {
    const nextItem = draft.trim()
    if (!nextItem || value.includes(nextItem)) {
      setDraft('')
      return
    }
    onChange([...value, nextItem])
    setDraft('')
  }

  const removeAt = (index: number) => {
    const next = value.slice()
    next.splice(index, 1)
    onChange(next)
  }

  return (
    <div className="yolo-string-list-input">
      <div className="yolo-string-list-input-row">
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addDraft()
            }
          }}
        />
        <button
          type="button"
          className="clickable-icon yolo-string-list-input-add"
          aria-label={addLabel}
          title={addLabel}
          onClick={addDraft}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="yolo-string-list-input-list">
        {value.map((item, index) => (
          <span key={`${item}-${index}`} className="yolo-string-list-chip">
            <span className="yolo-string-list-chip-label">{item}</span>
            <button
              type="button"
              className="clickable-icon yolo-string-list-chip-remove"
              aria-label={`${removeLabel}: ${item}`}
              title={`${removeLabel}: ${item}`}
              onClick={() => removeAt(index)}
            >
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}
