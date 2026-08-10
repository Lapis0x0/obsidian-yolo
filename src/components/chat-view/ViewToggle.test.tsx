import { renderToStaticMarkup } from 'react-dom/server'

type CapturedRollerProps = {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  onValueClick: () => void
  onActivate: () => void
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
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        activeView="chat"
        onChangeView={onChangeView}
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
    expect(onChangeView).toHaveBeenCalledWith('chat')
  })

  it('switches from Agent to CLI when the visible mode is clicked', () => {
    const onChangeChatSurface = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        activeView="chat"
        onChangeView={onChangeView}
        activeChatSurface="chat"
        onChangeChatSurface={onChangeChatSurface}
        showCliMode
      />,
    )

    mockRollerProps?.onValueClick()

    expect(onChangeChatSurface).toHaveBeenCalledWith('cli')
    expect(onChangeView).toHaveBeenCalledWith('chat')
  })

  it('switches from CLI to Agent when the visible mode is clicked', () => {
    const onChangeChatSurface = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        activeView="chat"
        onChangeView={onChangeView}
        activeChatSurface="cli"
        onChangeChatSurface={onChangeChatSurface}
        showCliMode
      />,
    )

    mockRollerProps?.onValueClick()

    expect(onChangeChatSurface).toHaveBeenCalledWith('chat')
    expect(onChangeView).toHaveBeenCalledWith('chat')
  })

  it('only enters Agent without changing runtime when clicked from composer', () => {
    const onChangeChatSurface = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        activeView="composer"
        onChangeView={onChangeView}
        activeChatSurface="chat"
        onChangeChatSurface={onChangeChatSurface}
        showCliMode
      />,
    )

    mockRollerProps?.onValueClick()

    expect(onChangeChatSurface).not.toHaveBeenCalled()
    expect(onChangeView).toHaveBeenCalledWith('chat')
  })

  it('keeps the caret activation separate from the shortcut switch', () => {
    const onChangeChatSurface = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        activeView="chat"
        onChangeView={onChangeView}
        activeChatSurface="chat"
        onChangeChatSurface={onChangeChatSurface}
        showCliMode
      />,
    )

    mockRollerProps?.onActivate()

    expect(onChangeChatSurface).not.toHaveBeenCalled()
    expect(onChangeView).toHaveBeenCalledWith('chat')
  })

  it('renders a fixed Chat entry when CLI is unavailable', () => {
    const html = renderToStaticMarkup(
      <ViewToggle
        activeView="chat"
        onChangeView={() => {}}
        activeChatSurface="chat"
        onChangeChatSurface={() => {}}
        showCliMode={false}
        showComposer={false}
      />,
    )

    expect(mockRollerProps).toBeNull()
    expect(html).toContain('>Agent<')
    expect(html).not.toContain('data-roller-value')
  })
})
