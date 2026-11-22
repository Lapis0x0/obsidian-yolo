import { renderToStaticMarkup } from 'react-dom/server'

type CapturedRollerProps = {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  onValueClick: () => void
}

let mockRollerProps: CapturedRollerProps | null = null

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('../common/RollerSelect', () => ({
  __esModule: true,
  default: (props: CapturedRollerProps) => {
    mockRollerProps = props
    return <button data-roller-value={props.value}>Roller</button>
  },
}))

import ViewToggle from './ViewToggle'

describe('ViewToggle chat surface hierarchy', () => {
  beforeEach(() => {
    mockRollerProps = null
  })

  it('uses the original header roller for the Chat and CLI top-level modes', () => {
    const onChangeChatSurface = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        activeChatSurface="chat"
        onChangeChatSurface={onChangeChatSurface}
        showCliMode
      />,
    )

    expect(mockRollerProps?.value).toBe('chat')
    expect(mockRollerProps?.options.map((option) => option.value)).toEqual([
      'chat',
      'cli',
    ])

    mockRollerProps?.onChange('cli')
    expect(onChangeChatSurface).toHaveBeenCalledWith('cli')
  })

  it('switches from Agent to CLI when the visible mode is clicked', () => {
    const onChangeChatSurface = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        activeChatSurface="chat"
        onChangeChatSurface={onChangeChatSurface}
        showCliMode
      />,
    )

    mockRollerProps?.onValueClick()

    expect(onChangeChatSurface).toHaveBeenCalledWith('cli')
  })

  it('switches from CLI to Agent when the visible mode is clicked', () => {
    const onChangeChatSurface = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        activeChatSurface="cli"
        onChangeChatSurface={onChangeChatSurface}
        showCliMode
      />,
    )

    mockRollerProps?.onValueClick()

    expect(onChangeChatSurface).toHaveBeenCalledWith('chat')
  })

  it('renders a fixed Chat entry when CLI is unavailable', () => {
    const html = renderToStaticMarkup(
      <ViewToggle
        activeChatSurface="chat"
        onChangeChatSurface={() => {}}
        showCliMode={false}
      />,
    )

    expect(mockRollerProps).toBeNull()
    expect(html).toContain('>Agent<')
    expect(html).not.toContain('data-roller-value')
  })
})
