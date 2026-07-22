export type OutlineChapter = {
  title: string
  contract: string
}

export type Outline = {
  projectName: string
  projectGoal: string
  chapters: OutlineChapter[]
  estimatedKnowledgePoints: number
}

export type KnowledgePointDraft = {
  title: string
  body: string
}

export type ChapterGenerationResult = {
  chapterIndex: number
  chapterTitle: string
  knowledgePoints: KnowledgePointDraft[]
  error?: string
}

export type CardDraft = {
  title: string
  kpUuid: string
  front: string
  back: string
  startLine: number
}

export type GeneratedCard = CardDraft & {
  cardUuid: string
}

export type CardGenerationEvent = {
  runId: string
  projectId: string
  chapterId: string
  chapterIndex: number
  cardIndex: number
  cardUuid: string
  card: GeneratedCard
}

export type CardGenerationResult = {
  chapterIndex: number
  chapterTitle: string
  cards: GeneratedCard[]
  status: 'generated' | 'partial' | 'failed' | 'skipped'
  discardedCount: number
  error?: string
}

export type GenerationProgress = {
  chapterIndex: number
  chapterTitle: string
  status: 'pending' | 'generating' | 'completed' | 'error'
  currentKnowledgePointTitle?: string
  error?: string
}
