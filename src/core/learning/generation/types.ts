export type OutlineChapter = {
  title: string
  contract: string
}

export type Outline = {
  projectName: string
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

export type GenerationProgress = {
  chapterIndex: number
  chapterTitle: string
  status: 'pending' | 'generating' | 'completed' | 'error'
  currentKnowledgePointTitle?: string
  error?: string
}
