import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import * as Popover from '@radix-ui/react-popover'
import { Check, Plus, Search, Sparkles, Zap } from 'lucide-react'
import {
  type CSSProperties,
  type MutableRefObject,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import type { LiteSkillEntry } from '../../../core/skills/liteSkills'
import { humanizeSkillName } from '../../../core/skills/liteSkills'
import {
  type SnippetEntry,
  parseSnippets,
} from '../../../core/snippets/snippetsManager'
import { DEFAULT_SNIPPETS_TEMPLATE } from '../../../core/snippets/templates'
import {
  type ChatQuickAccessEntry,
  DEFAULT_CHAT_QUICK_ACCESS_ENTRIES,
  getChatQuickAccessEntryKey,
} from '../../../settings/chatQuickAccess'
import { YoloPopoverContent } from '../../common/popover/YoloPopoverContent'

type ChatQuickAccessProps = {
  skills: LiteSkillEntry[]
  snippets: SnippetEntry[]
  onSelectSkill: (skill: LiteSkillEntry) => void
  onSelectSnippet: (snippet: SnippetEntry) => void
  onPopoverOpenChange?: (isOpen: boolean) => void
}

type ResolvedQuickAccessEntry = {
  entry: ChatQuickAccessEntry
  key: string
  label: string
  description?: string
}

const DEFAULT_SNIPPETS = parseSnippets(DEFAULT_SNIPPETS_TEMPLATE)

function SortableQuickAccessButton({
  item,
  onSelect,
  suppressClickRef,
}: {
  item: ResolvedQuickAccessEntry
  onSelect: (entry: ChatQuickAccessEntry) => void
  suppressClickRef: MutableRefObject<number>
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.key })
  const Icon = item.entry.type === 'skill' ? Sparkles : Zap
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`yolo-chat-quick-access-entry${
        isDragging ? ' is-dragging' : ''
      }`}
      data-type={item.entry.type}
      style={style}
      title={item.description || item.label}
      onClick={() => {
        if (Date.now() < suppressClickRef.current) return
        onSelect(item.entry)
      }}
      {...attributes}
      {...listeners}
    >
      <Icon size={14} strokeWidth={2} />
      <span>{item.label}</span>
    </button>
  )
}

export function ChatQuickAccess({
  skills,
  snippets,
  onSelectSkill,
  onSelectSnippet,
  onPopoverOpenChange,
}: ChatQuickAccessProps) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const suppressClickUntilRef = useRef(0)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  )

  const entries: ChatQuickAccessEntry[] =
    settings.chatOptions.quickAccessEntries ??
    DEFAULT_CHAT_QUICK_ACCESS_ENTRIES

  const skillByName = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill] as const)),
    [skills],
  )
  const selectableSnippets = useMemo(() => {
    const byId = new Map(
      DEFAULT_SNIPPETS.map((snippet) => [snippet.id, snippet] as const),
    )
    snippets.forEach((snippet) => byId.set(snippet.id, snippet))
    return [...byId.values()]
  }, [snippets])
  const snippetById = useMemo(
    () =>
      new Map(
        selectableSnippets.map((snippet) => [snippet.id, snippet] as const),
      ),
    [selectableSnippets],
  )

  const resolvedEntries = useMemo(
    () =>
      entries.flatMap((entry): ResolvedQuickAccessEntry[] => {
        if (entry.type === 'skill') {
          const skill = skillByName.get(entry.name)
          return skill
            ? [
                {
                  entry,
                  key: getChatQuickAccessEntryKey(entry),
                  label: humanizeSkillName(skill.name),
                  description: skill.description,
                },
              ]
            : []
        }

        const snippet = snippetById.get(entry.id)
        return snippet
          ? [
              {
                entry,
                key: getChatQuickAccessEntryKey(entry),
                label: snippet.trigger,
                description: snippet.description,
              },
            ]
          : []
      }),
    [entries, skillByName, snippetById],
  )
  const selectedKeys = useMemo(
    () => new Set(entries.map(getChatQuickAccessEntryKey)),
    [entries],
  )

  const persistEntries = useCallback(
    (nextEntries: ChatQuickAccessEntry[]) => {
      void setSettings({
        ...settings,
        chatOptions: {
          ...settings.chatOptions,
          quickAccessEntries: nextEntries,
        },
      })
    },
    [setSettings, settings],
  )

  const handleSelectEntry = useCallback(
    (entry: ChatQuickAccessEntry) => {
      if (entry.type === 'skill') {
        const skill = skillByName.get(entry.name)
        if (skill) onSelectSkill(skill)
        return
      }
      const snippet = snippetById.get(entry.id)
      if (snippet) onSelectSnippet(snippet)
    },
    [onSelectSkill, onSelectSnippet, skillByName, snippetById],
  )

  const handleToggleEntry = useCallback(
    (entry: ChatQuickAccessEntry) => {
      const key = getChatQuickAccessEntryKey(entry)
      persistEntries(
        selectedKeys.has(key)
          ? entries.filter(
              (current) => getChatQuickAccessEntryKey(current) !== key,
            )
          : [...entries, entry],
      )
    },
    [entries, persistEntries, selectedKeys],
  )

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      suppressClickUntilRef.current = Date.now() + 250
      if (!over || active.id === over.id) return
      const oldIndex = entries.findIndex(
        (entry) => getChatQuickAccessEntryKey(entry) === active.id,
      )
      const newIndex = entries.findIndex(
        (entry) => getChatQuickAccessEntryKey(entry) === over.id,
      )
      if (oldIndex < 0 || newIndex < 0) return
      persistEntries(arrayMove(entries, oldIndex, newIndex))
    },
    [entries, persistEntries],
  )

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const matchesQuery = (label: string, description?: string) =>
    normalizedQuery.length === 0 ||
    label.toLocaleLowerCase().includes(normalizedQuery) ||
    description?.toLocaleLowerCase().includes(normalizedQuery)
  const filteredSkills = skills.filter((skill) =>
    matchesQuery(humanizeSkillName(skill.name), skill.description),
  )
  const filteredSnippets = selectableSnippets.filter((snippet) =>
    matchesQuery(snippet.trigger, snippet.description),
  )
  const hasResults = filteredSkills.length > 0 || filteredSnippets.length > 0

  const renderPickerRow = (
    entry: ChatQuickAccessEntry,
    label: string,
    description: string | undefined,
  ) => {
    const selected = selectedKeys.has(getChatQuickAccessEntryKey(entry))
    const Icon = entry.type === 'skill' ? Sparkles : Zap
    return (
      <button
        key={getChatQuickAccessEntryKey(entry)}
        type="button"
        className="yolo-chat-quick-access-picker-row"
        data-type={entry.type}
        data-selected={selected ? 'true' : 'false'}
        aria-pressed={selected}
        onClick={() => handleToggleEntry(entry)}
      >
        <Icon size={15} strokeWidth={2} />
        <span className="yolo-chat-quick-access-picker-row__text">
          <span className="yolo-chat-quick-access-picker-row__label">
            {label}
          </span>
          {description ? (
            <span className="yolo-chat-quick-access-picker-row__description">
              {description}
            </span>
          ) : null}
        </span>
        <span className="yolo-chat-quick-access-picker-row__check">
          {selected ? <Check size={15} strokeWidth={2.4} /> : null}
        </span>
      </button>
    )
  }

  return (
    <div className="yolo-chat-quick-access">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={resolvedEntries.map((item) => item.key)}
          strategy={rectSortingStrategy}
        >
          {resolvedEntries.map((item) => (
            <SortableQuickAccessButton
              key={item.key}
              item={item}
              onSelect={handleSelectEntry}
              suppressClickRef={suppressClickUntilRef}
            />
          ))}
        </SortableContext>
      </DndContext>

      <Popover.Root
        open={isPopoverOpen}
        onOpenChange={(open) => {
          setIsPopoverOpen(open)
          if (!open) setSearchQuery('')
          onPopoverOpenChange?.(open)
        }}
      >
        <Popover.Trigger asChild>
          <button
            ref={addButtonRef}
            type="button"
            className="yolo-chat-quick-access-add"
            aria-label={t('chat.quickAccess.manage', '管理常用入口')}
            title={t('chat.quickAccess.manage', '管理常用入口')}
          >
            <Plus size={17} strokeWidth={2} />
          </button>
        </Popover.Trigger>
        <YoloPopoverContent
          anchorRef={addButtonRef}
          variant="default"
          minWidth={300}
          maxWidth={360}
          maxHeight={440}
          side="bottom"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          className="yolo-chat-quick-access-picker"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="yolo-chat-quick-access-picker-search">
            <Search size={15} strokeWidth={2} />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={t(
                'chat.quickAccess.searchPlaceholder',
                '搜索 Skills 或快捷指令',
              )}
              aria-label={t(
                'chat.quickAccess.searchPlaceholder',
                '搜索 Skills 或快捷指令',
              )}
            />
          </div>
          <div className="yolo-chat-quick-access-picker-list">
            {filteredSkills.length > 0 ? (
              <section className="yolo-chat-quick-access-picker-section">
                <div className="yolo-chat-quick-access-picker-section__title">
                  {t('chat.quickAccess.skills', 'Skills')}
                </div>
                {filteredSkills.map((skill) =>
                  renderPickerRow(
                    { type: 'skill', name: skill.name },
                    humanizeSkillName(skill.name),
                    skill.description,
                  ),
                )}
              </section>
            ) : null}
            {filteredSnippets.length > 0 ? (
              <section className="yolo-chat-quick-access-picker-section">
                <div className="yolo-chat-quick-access-picker-section__title">
                  {t('chat.quickAccess.snippets', '快捷指令')}
                </div>
                {filteredSnippets.map((snippet) =>
                  renderPickerRow(
                    { type: 'snippet', id: snippet.id },
                    snippet.trigger,
                    snippet.description,
                  ),
                )}
              </section>
            ) : null}
            {!hasResults ? (
              <div className="yolo-chat-quick-access-picker-empty">
                {t('chat.quickAccess.empty', '没有匹配项')}
              </div>
            ) : null}
          </div>
        </YoloPopoverContent>
      </Popover.Root>
    </div>
  )
}
