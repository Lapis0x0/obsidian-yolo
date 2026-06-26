import type {
  ProjectEventBus,
  SyntheticLearningEventInput,
} from './projectEventBus'
import type { Chapter, KnowledgePoint, LearningEvent, Relation } from './types'

/**
 * Distributive Omit — required because LearningEvent is a discriminated
 * union, and a non-distributive `Omit<U, K>` would collapse the union to its
 * shared keys only.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never

type SyntheticLearningEvent = DistributiveOmit<
  LearningEvent,
  'sequence' | 'timestamp' | 'projectId'
>

/**
 * Mock replay tool for the Knowledge Graph.
 *
 * Purpose
 * ───────
 * Lets the graph component (and whoever is designing its growth animation)
 * iterate on visuals WITHOUT a real agent running. Pre-baked event sequences
 * are pushed through ProjectEventBus at a configurable cadence; the graph
 * subscribes to the bus and animates exactly the same way it will in
 * production.
 *
 * Design notes
 * ────────────
 * - We synthesize a "from scratch" project: one `project_initialized` (with
 *   an empty Project), then a series of chapter / knowledge-point / relation
 *   events. This mimics the real "agent generates from nothing" experience.
 * - Inter-event delays are baked into the script so the cadence feels right
 *   (chapters appear in bursts; knowledge points within a chapter come more
 *   slowly; relations resolve last). Tweak these numbers when designing the
 *   animation curves — they are the rhythm.
 * - The script intentionally focuses different knowledge points along the
 *   way to exercise the `knowledge_point_focused` micro-pulse affordance.
 */

export type MockScript = {
  /** Stable ID used for both the project and as the basis for child IDs. */
  projectId: string
  topic: string
  /** Sequence of (event, delayMs) entries. Delay is BEFORE the event fires. */
  steps: ReadonlyArray<{
    delayMs: number
    event: SyntheticLearningEvent
  }>
}

export type MockReplayController = {
  cancel: () => void
  /** Promise that resolves when the script finishes (or is cancelled). */
  done: Promise<void>
}

export function startMockReplay(
  bus: ProjectEventBus,
  script: MockScript,
): MockReplayController {
  let cancelled = false
  let pendingHandle: ReturnType<typeof setTimeout> | null = null
  let resolveDone: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  bus.beginMockSession()

  const run = async () => {
    for (const step of script.steps) {
      if (cancelled) break
      await new Promise<void>((resolve) => {
        pendingHandle = setTimeout(() => {
          pendingHandle = null
          resolve()
        }, step.delayMs)
      })
      if (cancelled) break
      bus.emitSynthetic({
        ...step.event,
        projectId: script.projectId,
      } as SyntheticLearningEventInput)
    }
    bus.endMockSession()
    resolveDone()
  }

  void run()

  return {
    cancel: () => {
      cancelled = true
      if (pendingHandle) {
        clearTimeout(pendingHandle)
        pendingHandle = null
      }
      bus.endMockSession()
      resolveDone()
    },
    done,
  }
}

/**
 * A worked example: the agent is asked to teach Rust ownership, starts from
 * an empty project, and progressively materializes chapters, knowledge
 * points, and relations.
 *
 * Use this as both a smoke test for the bus and a fixture for animation
 * design. The cadence here is deliberately legible (300–800ms between most
 * events) — tighten or stretch when iterating on motion design.
 */
export const RUST_OWNERSHIP_MOCK_SCRIPT: MockScript =
  buildRustOwnershipMockScript()

function buildRustOwnershipMockScript(): MockScript {
  const projectId = '__mock__/rust-ownership'

  const chapters: Chapter[] = [
    makeChapter(projectId, 'ownership-basics', '所有权基础'),
    makeChapter(projectId, 'borrowing', '借用与引用'),
    makeChapter(projectId, 'lifetimes', '生命周期'),
  ]

  const kps: KnowledgePoint[] = [
    makeKp(projectId, 'ownership-basics', 'value-and-binding', '值与绑定'),
    makeKp(projectId, 'ownership-basics', 'move-semantics', 'Move 语义'),
    makeKp(projectId, 'ownership-basics', 'copy-vs-clone', 'Copy 与 Clone'),
    makeKp(projectId, 'ownership-basics', 'drop-trait', 'Drop trait'),
    makeKp(projectId, 'borrowing', 'shared-borrow', '共享借用 &T'),
    makeKp(projectId, 'borrowing', 'mutable-borrow', '可变借用 &mut T'),
    makeKp(projectId, 'borrowing', 'aliasing-xor-mutability', '别名异或可变'),
    makeKp(projectId, 'lifetimes', 'lifetime-annotation', '生命周期标注'),
    makeKp(projectId, 'lifetimes', 'elision-rules', '省略规则'),
    makeKp(projectId, 'lifetimes', 'static-lifetime', "'static 生命周期"),
  ]

  const kpById = new Map(kps.map((kp) => [kp.id, kp]))
  const id = (chapter: string, kp: string) => `${projectId}/${chapter}/${kp}` // matches makeKp() folder-path id

  type StepInput = {
    delayMs: number
    event: SyntheticLearningEvent
  }
  const steps: StepInput[] = []

  // 1. project initialized — empty shell
  steps.push({
    delayMs: 200,
    event: {
      type: 'project_initialized',
      snapshot: {
        id: projectId,
        slug: 'rust-ownership',
        topic: 'Rust 所有权',
        status: 'outlining',
        folderPath: projectId,
        indexFilePath: `${projectId}/index.md`,
        chapters: [],
        knowledgePoints: [],
      },
    },
  })

  // 2. chapters land in quick succession (outline phase)
  for (const chapter of chapters) {
    steps.push({
      delayMs: 600,
      event: { type: 'chapter_added', chapter },
    })
  }

  // 3. knowledge points appear chapter-by-chapter, with the agent "focusing"
  //    each one momentarily — this drives the micro-pulse on the active node.
  for (const kp of kps) {
    steps.push({
      delayMs: 500,
      event: {
        type: 'knowledge_point_focused',
        knowledgePointId: kp.id,
      },
    })
    steps.push({
      delayMs: 400,
      event: { type: 'knowledge_point_added', knowledgePoint: kp },
    })
  }

  // 4. Clear focus before relations phase
  steps.push({
    delayMs: 600,
    event: {
      type: 'knowledge_point_focused',
      knowledgePointId: null,
    },
  })

  // 5. Relations emerge last — these are the edges that turn a list of
  //    points into a graph. Order is "from foundation outward".
  const relationsByKp: Array<{
    sourceId: string
    relation: Relation
  }> = [
    {
      sourceId: id('ownership-basics', 'move-semantics'),
      relation: {
        targetId: id('ownership-basics', 'value-and-binding'),
        type: 'prereq',
      },
    },
    {
      sourceId: id('ownership-basics', 'copy-vs-clone'),
      relation: {
        targetId: id('ownership-basics', 'move-semantics'),
        type: 'related',
      },
    },
    {
      sourceId: id('ownership-basics', 'drop-trait'),
      relation: {
        targetId: id('ownership-basics', 'move-semantics'),
        type: 'related',
      },
    },
    {
      sourceId: id('borrowing', 'shared-borrow'),
      relation: {
        targetId: id('ownership-basics', 'move-semantics'),
        type: 'prereq',
      },
    },
    {
      sourceId: id('borrowing', 'mutable-borrow'),
      relation: {
        targetId: id('borrowing', 'shared-borrow'),
        type: 'related',
      },
    },
    {
      sourceId: id('borrowing', 'aliasing-xor-mutability'),
      relation: {
        targetId: id('borrowing', 'shared-borrow'),
        type: 'prereq',
      },
    },
    {
      sourceId: id('borrowing', 'aliasing-xor-mutability'),
      relation: {
        targetId: id('borrowing', 'mutable-borrow'),
        type: 'prereq',
      },
    },
    {
      sourceId: id('lifetimes', 'lifetime-annotation'),
      relation: {
        targetId: id('borrowing', 'shared-borrow'),
        type: 'prereq',
      },
    },
    {
      sourceId: id('lifetimes', 'elision-rules'),
      relation: {
        targetId: id('lifetimes', 'lifetime-annotation'),
        type: 'related',
      },
    },
    {
      sourceId: id('lifetimes', 'static-lifetime'),
      relation: {
        targetId: id('lifetimes', 'lifetime-annotation'),
        type: 'related',
      },
    },
  ]

  for (const entry of relationsByKp) {
    if (!kpById.has(entry.sourceId) || !kpById.has(entry.relation.targetId)) {
      // Defensive: skip relations referring to non-existent KPs.
      continue
    }
    steps.push({
      delayMs: 350,
      event: {
        type: 'relation_established',
        sourceId: entry.sourceId,
        relation: entry.relation,
      },
    })
  }

  return { projectId, topic: 'Rust 所有权', steps }
}

function makeChapter(projectId: string, slug: string, title: string): Chapter {
  const id = `${projectId}/${slug}`
  return {
    id,
    projectId,
    slug,
    title,
    folderPath: id,
    knowledgePointIds: [],
  }
}

function makeKp(
  projectId: string,
  chapterSlug: string,
  slug: string,
  title: string,
): KnowledgePoint {
  const folderPath = `${projectId}/${chapterSlug}/${slug}`
  return {
    id: folderPath,
    projectId,
    chapterId: `${projectId}/${chapterSlug}`,
    slug,
    title,
    knowledgeFilePath: `${folderPath}/knowledge.md`,
    folderPath,
    relations: [],
    hasCards: false,
    hasExercises: false,
    mtime: 0,
  }
}
