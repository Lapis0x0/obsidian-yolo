/**
 * Domain types for the YOLO Learning Mode.
 *
 * The vault is the single source of truth. These types are the in-memory
 * representation derived from scanning a project directory:
 *
 *   <vault>/<learningBaseDir>/<projectSlug>/
 *     index.md                                # project metadata + outline
 *     <chapterSlug>/
 *       knowledge.md                          # all knowledge points in this chapter
 *       cards.md                              # cards (optional)
 *       exercises.md                          # exercises (optional)
 *
 * Knowledge point IDs are `${chapterId}/${uuid}`. The uuid is stored in the
 * heading HTML comment inside chapter-level markdown files.
 */

export type ProjectStatus = 'outlining' | 'building' | 'studying'

export type RelationType = 'prereq' | 'parent' | 'related'

export type Relation = {
  targetId: string
  type: RelationType
  /** Optional short label for the edge ("依赖" / "包含" / "延伸阅读" ...). */
  label?: string
}

export type KnowledgePoint = {
  id: string
  projectId: string
  chapterId: string
  uuid: string
  title: string
  /** Vault path of `knowledge.md`. */
  knowledgeFilePath: string
  /** Relations declared for this knowledge point. */
  relations: Relation[]
  /** Whether `cards.md` exists. */
  hasCards: boolean
  /** Whether `exercises.md` exists. */
  hasExercises: boolean
  /** Last modification time (ms) of `knowledge.md`. */
  mtime: number
}

export type Chapter = {
  id: string
  projectId: string
  slug: string
  title: string
  /** Vault path of the chapter folder. */
  folderPath: string
  /** Knowledge point IDs in this chapter, ordered. */
  knowledgePointIds: string[]
}

export type Project = {
  id: string
  slug: string
  topic: string
  status: ProjectStatus
  /** Vault path of the project folder. */
  folderPath: string
  /** Vault path of `index.md`. */
  indexFilePath: string
  chapters: Chapter[]
  knowledgePoints: KnowledgePoint[]
}

/**
 * Domain events emitted as the project grows. The KnowledgeGraph component
 * subscribes to this stream and animates each event individually — this is
 * what drives the "growing graph" visual.
 *
 * Every event carries a monotonically increasing `sequence` and a `timestamp`
 * so replays can reproduce the exact emission cadence.
 */
export type LearningEventBase = {
  sequence: number
  timestamp: number
  projectId: string
}

export type ProjectInitializedEvent = LearningEventBase & {
  type: 'project_initialized'
  snapshot: Project
}

export type ChapterAddedEvent = LearningEventBase & {
  type: 'chapter_added'
  chapter: Chapter
}

export type ChapterUpdatedEvent = LearningEventBase & {
  type: 'chapter_updated'
  chapter: Chapter
}

export type ChapterRemovedEvent = LearningEventBase & {
  type: 'chapter_removed'
  chapterId: string
}

export type KnowledgePointAddedEvent = LearningEventBase & {
  type: 'knowledge_point_added'
  knowledgePoint: KnowledgePoint
}

export type KnowledgePointDraftedEvent = LearningEventBase & {
  type: 'knowledge_point_drafted'
  knowledgePoint: KnowledgePoint
}

export type KnowledgePointUpdatedEvent = LearningEventBase & {
  type: 'knowledge_point_updated'
  knowledgePoint: KnowledgePoint
  /** Fields whose value changed compared to the previous snapshot. */
  changedFields: ReadonlyArray<keyof KnowledgePoint>
}

export type KnowledgePointRemovedEvent = LearningEventBase & {
  type: 'knowledge_point_removed'
  knowledgePointId: string
}

export type RelationEstablishedEvent = LearningEventBase & {
  type: 'relation_established'
  sourceId: string
  relation: Relation
}

export type RelationRemovedEvent = LearningEventBase & {
  type: 'relation_removed'
  sourceId: string
  targetId: string
}

/**
 * Soft signal that the agent is currently working on a particular knowledge
 * point. Useful for the "micro pulse on active node" affordance. Not derived
 * from vault state — emitted explicitly by callers (the mock replay tool, or
 * later, the agent tool layer).
 */
export type KnowledgePointFocusEvent = LearningEventBase & {
  type: 'knowledge_point_focused'
  knowledgePointId: string | null
}

export type LearningEvent =
  | ProjectInitializedEvent
  | ChapterAddedEvent
  | ChapterUpdatedEvent
  | ChapterRemovedEvent
  | KnowledgePointAddedEvent
  | KnowledgePointDraftedEvent
  | KnowledgePointUpdatedEvent
  | KnowledgePointRemovedEvent
  | RelationEstablishedEvent
  | RelationRemovedEvent
  | KnowledgePointFocusEvent

export type LearningEventType = LearningEvent['type']

export type LearningEventListener = (event: LearningEvent) => void
