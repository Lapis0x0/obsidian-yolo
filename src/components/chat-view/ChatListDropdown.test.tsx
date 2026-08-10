let mockSearchQuery = ''

jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react')
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: () => undefined,
    useId: () => 'test-id',
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initialValue: T) => ({ current: initialValue }),
    useState: <T,>(initialValue: T | (() => T)) => {
      const resolvedValue =
        typeof initialValue === 'function'
          ? (initialValue as () => T)()
          : initialValue
      return [resolvedValue === '' ? mockSearchQuery : resolvedValue, jest.fn()]
    },
  }
})

// 这些用例把 ChatListItem 当普通函数调用，拿不到 framer-motion 需要的 React
// dispatcher；动效不在断言范围内，直接退化成原生标签即可。
jest.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: unknown }) => children,
  motion: { li: 'li' },
  useIsPresent: () => true,
  useReducedMotion: () => false,
}))

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('../../hooks/useJsonManagers', () => ({
  useChatManager: () => ({ findById: jest.fn() }),
}))

jest.mock('../../hooks/useChatHistory', () => ({
  getConversationDisplayTitle: (title: string, fallback: string) =>
    title.trim() || fallback,
}))

import {
  Children,
  type ReactElement,
  type ReactNode,
  isValidElement,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatConversationMetadata } from '../../database/json/chat/types'

import { ChatListDropdown } from './ChatListDropdown'

const chat = (
  id: string,
  title: string,
  cliSession?: ChatConversationMetadata['cliSession'],
): ChatConversationMetadata => ({
  id,
  title,
  updatedAt: 100,
  schemaVersion: 1,
  cliSession,
})

const walkElements = (node: ReactNode): ReactElement[] => {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<{ children?: ReactNode }>
  return [
    element,
    ...Children.toArray(element.props.children).flatMap(walkElements),
  ]
}

const createTree = (
  chatList: ChatConversationMetadata[],
  onSelect = jest.fn(),
) =>
  ChatListDropdown({
    chatList,
    currentConversationId: '',
    runSummariesByConversationId: new Map(),
    onSelect,
    onDelete: jest.fn(),
    onUpdateTitle: jest.fn(),
    onTogglePinned: jest.fn(),
    onRetryTitle: jest.fn(),
    onExportConversation: jest.fn(),
    children: <span>History</span>,
  })

const historyRows = (tree: ReactElement) =>
  walkElements(tree).filter(
    (element) =>
      typeof element.type === 'function' &&
      element.type.name === 'ChatListItem',
  )

describe('ChatListDropdown', () => {
  beforeEach(() => {
    mockSearchQuery = ''
  })

  it('keeps title filtering and selection on the unified history list', async () => {
    mockSearchQuery = 'alpha'
    const onSelect = jest.fn()
    const rows = historyRows(
      createTree(
        [
          chat('alpha', 'Alpha conversation'),
          chat('beta', 'Beta conversation'),
        ],
        onSelect,
      ),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.props.title).toBe('Alpha conversation')
    ;(rows[0]?.props.onSelect as () => void)()
    await Promise.resolve()
    expect(onSelect).toHaveBeenCalledWith('alpha')
  })

  it('shows compact runtime badges only for YOLO-owned CLI conversations', () => {
    const rows = historyRows(
      createTree([
        chat('yolo', 'Normal'),
        chat('cc', 'Claude task', {
          runtimeId: 'claude-code',
          nativeSessionId: 'session-1',
        }),
        chat('codex', 'Codex task', {
          runtimeId: 'codex',
          nativeSessionId: 'thread-1',
        }),
      ]),
    )
    const html = rows
      .map((row) =>
        renderToStaticMarkup(
          (row.type as (props: typeof row.props) => ReactElement)(row.props),
        ),
      )
      .join('')

    expect(html).toContain('data-runtime-id="claude-code"')
    expect(html).toContain('>CC<')
    expect(html).toContain('aria-label="Claude Code"')
    expect(html).toContain('data-runtime-id="codex"')
    expect(html).toContain('>Codex<')
    expect(html.match(/data-runtime-id=/g)).toHaveLength(2)
  })
})
