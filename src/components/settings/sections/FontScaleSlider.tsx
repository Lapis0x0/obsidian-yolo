import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useObsidianSetting } from '../../common/ObsidianSetting'

type FontScaleSliderProps = {
  value: number
  onChange: (value: number) => void
}

const FONT_SCALE_MIN = 0.7
const FONT_SCALE_MAX = 1.5
const FONT_SCALE_STEP = 0.05

export function FontScaleSlider({ value, onChange }: FontScaleSliderProps) {
  const { setting } = useObsidianSetting()
  const onChangeRef = useRef(onChange)
  const [localValue, setLocalValue] = useState(value)
  const isDragging = useRef(false)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // Sync from external when not dragging
  useEffect(() => {
    if (!isDragging.current) {
      setLocalValue(value)
    }
  }, [value])

  if (!setting) return null

  const percent = Math.round(localValue * 100)
  const parseValue = (rawValue: string) =>
    Math.round(parseFloat(rawValue) * 100) / 100
  const commitValue = (nextValue: number) => {
    setLocalValue(nextValue)
    onChangeRef.current(nextValue)
  }

  return createPortal(
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <input
        type="range"
        min={FONT_SCALE_MIN}
        max={FONT_SCALE_MAX}
        step={FONT_SCALE_STEP}
        value={localValue}
        onPointerDown={() => {
          isDragging.current = true
        }}
        onChange={(e) => {
          const raw = parseValue(e.target.value)
          setLocalValue(raw)
        }}
        onPointerUp={(e) => {
          isDragging.current = false
          commitValue(parseValue(e.currentTarget.value))
        }}
        onBlur={(e) => {
          isDragging.current = false
          commitValue(parseValue(e.currentTarget.value))
        }}
        onKeyUp={(e) => {
          commitValue(parseValue(e.currentTarget.value))
        }}
      />
      <span style={{ minWidth: '36px', textAlign: 'right' }}>{percent}%</span>
    </div>,
    setting.controlEl,
  )
}
