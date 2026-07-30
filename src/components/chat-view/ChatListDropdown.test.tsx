let mockSearchQuery = ''
let mockActiveSection: 'user' | 'task' | undefined

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
      const value =
        resolvedValue === ''
          ? mockSearchQuery
          : resolvedValue === 'user' || resolvedValue === 'task'
            ? (mockActiveSection ?? resolvedValue)
            : resolvedValue
      return [value, jest.fn()]
    },
  }
})

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('../../hooks/useJsonManagers', () => ({
  useChatManager: () => ({
    findById: jest.fn(),
  }),
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

import type { ChatConversationMetadata } from '../../database/json/chat/types'
import { YoloPopoverContent } from '../common/popover'

import { ChatListDropdown } from './ChatListDropdown'

const userChat = (id: string, title: string): ChatConversationMetadata => ({
  id,
  title,
  updatedAt: 100,
  schemaVersion: 1,
})

const walkElements = (node: ReactNode): ReactElement[] => {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<{ children?: ReactNode }>
  return [
    element,
    ...Children.toArray(element.props.children).flatMap(walkElements),
  ]
}

const createTree = ({
  chatList = [],
  additionalHistorySections,
  onSelect = jest.fn(),
}: {
  chatList?: ChatConversationMetadata[]
  additionalHistorySections?: ReactNode
  onSelect?: jest.Mock
} = {}) =>
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
    additionalHistorySections,
    children: <span>History</span>,
  })

const findPopoverContent = (root: ReactElement): ReactElement => {
  const content = walkElements(root).find(
    (element) => element.type === YoloPopoverContent,
  )
  if (!content) throw new Error('Missing history popover content')
  return content
}

describe('ChatListDropdown additional history sections', () => {
  beforeEach(() => {
    mockSearchQuery = ''
    mockActiveSection = undefined
  })

  it('renders the slot in the same popover content after the YOLO user list', () => {
    const content = findPopoverContent(
      createTree({
        chatList: [userChat('chat-1', 'YOLO conversation')],
        additionalHistorySections: (
          <section data-testid="additional-history">CLI sessions</section>
        ),
      }),
    )
    const contentChildren = Children.toArray(
      (content.props as { children?: ReactNode }).children,
    )
    const yoloListIndex = contentChildren.findIndex(
      (child) =>
        isValidElement(child) &&
        child.type === 'ul' &&
        child.props.className === 'yolo-model-select-list',
    )
    const slotIndex = contentChildren.findIndex(
      (child) =>
        isValidElement(child) &&
        child.props['data-testid'] === 'additional-history',
    )

    expect(yoloListIndex).toBeGreaterThan(-1)
    expect(slotIndex).toBe(yoloListIndex + 1)
  })

  it('keeps the slot visible when the YOLO list is empty or has no search matches', () => {
    const slot = (
      <section data-testid="additional-history">CLI sessions</section>
    )
    const emptyTree = createTree({ additionalHistorySections: slot })

    expect(
      walkElements(emptyTree).some(
        (element) => element.props['data-testid'] === 'additional-history',
      ),
    ).toBe(true)

    mockSearchQuery = 'missing'
    const noMatchesTree = createTree({
      chatList: [userChat('chat-1', 'Unrelated title')],
      additionalHistorySections: slot,
    })
    const elements = walkElements(noMatchesTree)

    expect(
      elements.some(
        (element) => element.props['data-testid'] === 'additional-history',
      ),
    ).toBe(true)
    expect(
      elements.some(
        (element) =>
          typeof element.type === 'function' &&
          element.type.name === 'ChatListItem',
      ),
    ).toBe(false)
  })

  it('omits the slot when no content is supplied or task history is active', () => {
    expect(
      walkElements(createTree()).some(
        (element) => element.props['data-testid'] === 'additional-history',
      ),
    ).toBe(false)

    mockActiveSection = 'task'
    const taskTree = createTree({
      additionalHistorySections: (
        <section data-testid="additional-history">CLI sessions</section>
      ),
    })

    expect(
      walkElements(taskTree).some(
        (element) => element.props['data-testid'] === 'additional-history',
      ),
    ).toBe(false)
  })

  it('preserves YOLO title filtering and selection callbacks', async () => {
    mockSearchQuery = 'alpha'
    const onSelect = jest.fn()
    const tree = createTree({
      chatList: [
        userChat('alpha', 'Alpha conversation'),
        userChat('beta', 'Beta conversation'),
      ],
      additionalHistorySections: (
        <section data-testid="additional-history">CLI sessions</section>
      ),
      onSelect,
    })
    const rows = walkElements(tree).filter(
      (element) =>
        typeof element.type === 'function' &&
        element.type.name === 'ChatListItem',
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.props.title).toBe('Alpha conversation')
    ;(rows[0]?.props.onSelect as () => void)()
    await Promise.resolve()

    expect(onSelect).toHaveBeenCalledWith('alpha')
  })
})
