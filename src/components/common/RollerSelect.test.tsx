import { renderToStaticMarkup } from 'react-dom/server'

import RollerSelect from './RollerSelect'
import { createRollerSelectHandlers } from './RollerSelect'

const options = [
  { value: 'agent', label: 'Agent' },
  { value: 'cli', label: 'CLI' },
]

describe('RollerSelect actions', () => {
  it('keeps visible-value and menu activation handlers isolated', () => {
    const onValueClick = jest.fn()
    const onActivate = jest.fn()
    const handlers = createRollerSelectHandlers({ onValueClick, onActivate })

    handlers.onValueClick()
    expect(onValueClick).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()

    handlers.onMenuActivate()
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onValueClick).toHaveBeenCalledTimes(1)
  })

  it('renders separately named value and menu controls', () => {
    const html = renderToStaticMarkup(
      <RollerSelect
        value="agent"
        options={options}
        onChange={() => {}}
        onValueClick={() => {}}
        valueAriaLabel="Switch to CLI"
        ariaLabel="Choose chat mode"
      />,
    )

    expect(html).toContain('aria-label="Switch to CLI"')
    expect(html).toContain('aria-label="Choose chat mode"')
    expect(html).toContain('yolo-roller-select-value-button')
    expect(html).toContain('yolo-roller-select-caret-button')
  })

  it('disables both the shortcut and menu controls', () => {
    const html = renderToStaticMarkup(
      <RollerSelect
        value="agent"
        options={options}
        onChange={() => {}}
        onValueClick={() => {}}
        valueAriaLabel="Switch to CLI"
        ariaLabel="Choose chat mode"
        disabled
      />,
    )

    expect(html).toMatch(
      /<button[^>]*yolo-roller-select-value-button[^>]*disabled=""/,
    )
    expect(html).toContain(
      'data-disabled="" disabled="" class="yolo-roller-select-trigger yolo-roller-select-caret-button"',
    )
  })
})
