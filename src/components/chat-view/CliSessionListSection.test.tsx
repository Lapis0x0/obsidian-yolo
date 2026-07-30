jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          'common.retry': 'Retry',
          'sidebar.runtimeSelector.claudeCodeLabel': 'Claude Code',
          'sidebar.runtimeSelector.codexLabel': 'Codex',
          'sidebar.cliSessions.sectionLabel': 'CLI sessions',
          'sidebar.cliSessions.title': 'Local CLI sessions',
          'sidebar.cliSessions.loading': 'Loading CLI sessions…',
          'sidebar.cliSessions.empty': 'No Claude Code or Codex sessions found',
          'sidebar.cliSessions.current': 'Current',
          'sidebar.cliSessions.pin': 'Pin in YOLO',
          'sidebar.cliSessions.unpin': 'Unpin in YOLO',
          'sidebar.cliSessions.forgetFromYolo': 'Forget from YOLO',
          'sidebar.cliSessions.retryProvider': 'Retry {provider}',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

import { Platform } from 'obsidian'
import {
  Children,
  type ReactElement,
  type ReactNode,
  isValidElement,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  CliRuntimeId,
  CliSessionDiscoveryResult,
  CliSessionListItem,
} from '../../core/cli-runtime'

import {
  CliSessionListSection,
  type CliSessionListSectionProps,
} from './CliSessionListSection'

const claudeSession: CliSessionListItem = {
  ref: {
    runtimeId: 'claude-code',
    nativeSessionId: 'shared/id',
  },
  title: 'Claude native title',
  preview: 'Claude native preview',
  updatedAt: 200,
  isPinned: true,
}

const codexSession: CliSessionListItem = {
  ref: {
    runtimeId: 'codex',
    nativeSessionId: 'shared/id',
  },
  title: 'Codex native title',
  preview: 'Codex native preview',
  updatedAt: 100,
  isPinned: false,
}

const discoveryResult: CliSessionDiscoveryResult = {
  sessions: [claudeSession, codexSession],
  errors: {},
}

const createProps = (
  overrides: Partial<CliSessionListSectionProps> = {},
): CliSessionListSectionProps => ({
  discoveryResult,
  loading: false,
  currentRef: codexSession.ref,
  onSelect: jest.fn(),
  onTogglePinned: jest.fn(),
  onRequestForgetOverlay: jest.fn(),
  onRetryProvider: jest.fn(),
  ...overrides,
})

const walkElements = (node: ReactNode): ReactElement[] => {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<{ children?: ReactNode }>
  return [
    element,
    ...Children.toArray(element.props.children).flatMap(walkElements),
  ]
}

const renderComponentTree = (
  props: CliSessionListSectionProps,
): ReactElement => {
  const element = CliSessionListSection(props)
  if (!element) throw new Error('Expected desktop section to render')
  return element
}

const findSessionRow = (
  root: ReactElement,
  runtimeId: CliRuntimeId,
): ReactElement => {
  const rowComponent = walkElements(root).find(
    (element) =>
      typeof element.type === 'function' &&
      (element.props as { session?: CliSessionListItem }).session?.ref
        .runtimeId === runtimeId,
  )
  if (!rowComponent) throw new Error(`Missing ${runtimeId} session row`)

  const rowProps = rowComponent.props
  return (rowComponent.type as (props: typeof rowProps) => ReactElement)(
    rowProps,
  )
}

const findAction = (row: ReactElement, action: string): ReactElement => {
  const button = walkElements(row).find(
    (element) =>
      element.type === 'button' &&
      (element.props as { 'data-action'?: string })['data-action'] === action,
  )
  if (!button) throw new Error(`Missing ${action} action`)
  return button
}

describe('CliSessionListSection', () => {
  const originalIsDesktop = Platform.isDesktop

  beforeEach(() => {
    Platform.isDesktop = true
  })

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  it('shows provider-native titles and previews with clear runtime badges', () => {
    const html = renderToStaticMarkup(
      <CliSessionListSection {...createProps()} />,
    )

    expect(html).toContain('data-runtime-id="claude-code"')
    expect(html).toContain('>Claude Code<')
    expect(html).toContain('Claude native title')
    expect(html).toContain('Claude native preview')
    expect(html).toContain('data-runtime-id="codex"')
    expect(html).toContain('>Codex<')
    expect(html).toContain('Codex native title')
    expect(html).toContain('Codex native preview')
  })

  it('keeps the same native id stable and distinct across providers', () => {
    const html = renderToStaticMarkup(
      <CliSessionListSection {...createProps()} />,
    )

    expect(html).toContain('data-session-key="claude-code:shared%2Fid"')
    expect(html).toContain('data-session-key="codex:shared%2Fid"')
    expect(html.match(/data-session-key=/g)).toHaveLength(2)
  })

  it('routes select, pin, and confirmation-boundary forget callbacks by full ref', () => {
    const onSelect = jest.fn()
    const onTogglePinned = jest.fn()
    const onRequestForgetOverlay = jest.fn()
    const root = renderComponentTree(
      createProps({ onSelect, onTogglePinned, onRequestForgetOverlay }),
    )
    const codexRow = findSessionRow(root, 'codex')

    ;(findAction(codexRow, 'select').props as { onClick: () => void }).onClick()
    ;(
      findAction(codexRow, 'toggle-pin').props as { onClick: () => void }
    ).onClick()
    ;(
      findAction(codexRow, 'request-forget-overlay').props as {
        onClick: () => void
      }
    ).onClick()

    expect(onSelect).toHaveBeenCalledWith(codexSession.ref)
    expect(onTogglePinned).toHaveBeenCalledWith(codexSession.ref, true)
    expect(onRequestForgetOverlay).toHaveBeenCalledWith(codexSession.ref)
  })

  it('surfaces provider errors independently and retries the matching provider', () => {
    const onRetryProvider = jest.fn()
    const props = createProps({
      discoveryResult: {
        sessions: [],
        errors: {
          'claude-code': 'Claude command unavailable',
          codex: 'Codex index unreadable',
        },
      },
      onRetryProvider,
    })
    const root = renderComponentTree(props)
    const html = renderToStaticMarkup(<CliSessionListSection {...props} />)
    const retryButtons = walkElements(root).filter(
      (element) =>
        element.type === 'button' &&
        (element.props as { 'data-action'?: string })['data-action'] ===
          'retry-provider',
    )

    expect(html).toContain('Claude command unavailable')
    expect(html).toContain('Codex index unreadable')
    expect(retryButtons).toHaveLength(2)
    ;(
      retryButtons[1].props as {
        onClick: () => void
      }
    ).onClick()
    expect(onRetryProvider).toHaveBeenCalledWith('codex')
  })

  it('renders loading and empty states without native transcript actions', () => {
    const loadingHtml = renderToStaticMarkup(
      <CliSessionListSection
        {...createProps({ discoveryResult: undefined, loading: true })}
      />,
    )
    const emptyHtml = renderToStaticMarkup(
      <CliSessionListSection
        {...createProps({
          discoveryResult: { sessions: [], errors: {} },
        })}
      />,
    )
    const listHtml = renderToStaticMarkup(
      <CliSessionListSection {...createProps()} />,
    ).toLowerCase()

    expect(loadingHtml).toContain('Loading CLI sessions…')
    expect(emptyHtml).toContain('No Claude Code or Codex sessions found')
    expect(listHtml).toContain('forget from yolo')
    expect(listHtml).not.toContain('delete')
    expect(listHtml).not.toContain('transcript')
  })

  it('renders nothing on mobile', () => {
    Platform.isDesktop = false

    const html = renderToStaticMarkup(
      <CliSessionListSection {...createProps()} />,
    )

    expect(html).toBe('')
    expect(html).not.toContain('yolo-cli-session-list')
  })
})
