import {
  createHostLearningVaultReadApi,
  createHostLearningVaultWriteApi,
} from '../domain/hostVaultAdapter'
import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'
import { createLearningGenerationAgent } from '../generation/moduleAgentAdapter'
import {
  type ProjectGenerationBackgroundPort,
  type ProjectGenerationCardsOutcome,
  ProjectGenerationService,
} from '../generation/projectGenerationService'

import { createHostLearningTranslation } from './runtime'
import {
  assertCurrentProjectPath,
  assertPathInRoot,
  normalizePath,
} from './vaultPaths'

const BACKGROUND_ACTIVITY_ID = 'learning-project-generation'

/**
 * The generation code only consumes this subset for scaffolding and
 * knowledge-point writes (the CAS operations go through the full
 * `LearningVaultWriteApi` wired below as `generationHost.vaultWriter`).
 */
type ProjectWriterPort = Pick<
  LearningVaultWriteApi,
  'ensureFolder' | 'listChildNames' | 'createText' | 'writeText'
>

export type CreateLearningProjectGenerationServiceOptions = Readonly<{
  getModelId: () => string | undefined
  /** Card generation is supported by the module, but callers may disable it. */
  generateCards?: boolean
  /** Called after knowledge files are complete and the project enters studying. */
  onProjectReady?: (projectPath: string) => void | Promise<void>
  /** Opens the generated project's cards without coupling this adapter to navigation. */
  openProjectCards?: (
    projectPath: string,
    mode: '学习' | '浏览',
  ) => void | Promise<void>
}>

export function createHostLearningProjectGenerationService(
  host: YoloModuleHostApiV1,
  options: CreateLearningProjectGenerationServiceOptions,
): ProjectGenerationService {
  const t = createHostLearningTranslation(host)
  const vault = createHostLearningVaultReadApi(host.vault)
  const hostWriter = createHostLearningVaultWriteApi(host.vault)
  const getLearningBaseDir = () =>
    normalizePath(host.paths.getSnapshot().contentRoot)
  const writer: ProjectWriterPort = {
    ensureFolder: (path) => host.vault.ensureFolder(path),
    listChildNames: async (path) =>
      host.vault.listChildren(path).map((entry) => entry.name),
    createText: (path, content) => host.vault.createText(path, content),
    writeText: (path, content) => host.vault.writeText(path, content),
  }

  const background: ProjectGenerationBackgroundPort = {
    showRunning: (detail, projectId) => {
      host.background.upsert({
        id: BACKGROUND_ACTIVITY_ID,
        title: t('generation.backgroundTitle', 'Learning: generating project'),
        detail,
        status: 'running',
        onOpen: projectId
          ? () => options.openProjectCards?.(projectId, '浏览')
          : undefined,
      })
    },
    showFailed: (detail, projectId) => {
      host.background.upsert({
        id: BACKGROUND_ACTIVITY_ID,
        title: t('generation.backgroundTitle', 'Learning: generating project'),
        detail,
        status: 'failed',
        onOpen: projectId
          ? () => options.openProjectCards?.(projectId, '浏览')
          : undefined,
      })
    },
    clear: () => host.background.remove(BACKGROUND_ACTIVITY_ID),
  }

  return new ProjectGenerationService({
    generationHost: {
      vault,
      // The generation code only consumes the CAS subset. Host 1.1
      // deliberately does not implement LearningVaultWriteApi's
      // permanent-removal operations.
      vaultWriter: hostWriter as LearningVaultWriteApi,
      agent: createLearningGenerationAgent(host.agent),
    },
    writer: writer as LearningVaultWriteApi,
    getLearningBaseDir,
    getModelId: options.getModelId,
    shouldGenerateCards: () => options.generateCards !== false,
    moveStagedReferences: ({ stagingDir, projectPath }) =>
      moveStagedReferences({
        host,
        root: getLearningBaseDir(),
        stagingDir,
        projectPath,
      }),
    onProjectReady: options.onProjectReady,
    activities: {
      knowledgePoints: (detail) => ({
        title: t('generation.knowledgePointsActivity'),
        detail,
      }),
      cards: (detail) => ({
        title: t('generation.cardsActivity'),
        detail,
      }),
    },
    background,
    notifyCardsCompletion: (input) =>
      showCardGenerationToast({
        host,
        t,
        openProjectCards: options.openProjectCards,
        ...input,
      }),
    describeChapterProgress: (completed, total) =>
      t('generation.backgroundKnowledgeDetail', 'Chapter {current}/{total}')
        .replace('{current}', String(completed))
        .replace('{total}', String(total)),
    describeCardsProgress: () =>
      t('generation.backgroundCardsDetail', 'Generating cards'),
  })
}

async function moveStagedReferences({
  host,
  root,
  stagingDir,
  projectPath,
}: {
  host: YoloModuleHostApiV1
  root: string
  stagingDir: string
  projectPath: string
}): Promise<string> {
  assertPathInRoot(stagingDir, root, '_staging')
  assertCurrentProjectPath(projectPath, root)
  const referenceDir = `${projectPath}/ref`
  await host.vault.ensureFolder(referenceDir)
  for (const entry of host.vault.listChildren(stagingDir)) {
    if (entry.kind === 'file') {
      await host.vault.renamePath(entry.path, `${referenceDir}/${entry.name}`)
    }
  }
  const removed = await host.vault.removeEmptyFolderExact(stagingDir)
  if (!removed && host.vault.getEntry(stagingDir)?.kind === 'folder') {
    throw new Error(`Staging directory is not empty: ${stagingDir}`)
  }
  return referenceDir
}

function showCardGenerationToast({
  host,
  t,
  openProjectCards,
  taskId,
  projectId,
  outcome,
  cardCount,
  generatedCount,
  skippedCount,
  notFinishedCount,
}: {
  host: YoloModuleHostApiV1
  t: ReturnType<typeof createHostLearningTranslation>
  openProjectCards?: (
    projectPath: string,
    mode: '学习' | '浏览',
  ) => void | Promise<void>
  taskId: string
  projectId: string
  outcome: ProjectGenerationCardsOutcome
  cardCount: number
  generatedCount: number
  skippedCount: number
  notFinishedCount: number
}): void {
  const mode = outcome === 'success' ? '学习' : '浏览'
  const copy =
    outcome === 'success'
      ? skippedCount > 0
        ? {
            tone: 'success' as const,
            title: t('cards.generationCompleteTitle'),
            message: t('cards.generationExistingSummary')
              .replace('{chapters}', String(generatedCount + skippedCount))
              .replace('{cards}', String(cardCount)),
          }
        : {
            tone: 'success' as const,
            title: t('cards.generationCompleteTitle'),
            message: t('cards.generationCompleteSummary')
              .replace('{chapters}', String(generatedCount))
              .replace('{cards}', String(cardCount)),
          }
      : outcome === 'partial'
        ? {
            tone: 'warning' as const,
            title: t('cards.generationPartialTitle'),
            message: t('cards.generationPartialSummary')
              .replace('{cards}', String(cardCount))
              .replace('{count}', String(notFinishedCount)),
          }
        : {
            tone: 'error' as const,
            title: t('cards.generationFailedTitle'),
            message: t('cards.generationFailedSummary'),
          }
  host.ui.showActionToast({
    id: `card-generation-${taskId}`,
    ...copy,
    actionLabel:
      outcome === 'success' ? t('cards.startLearning') : t('cards.browseCards'),
    dismissLabel: t('common.close'),
    onAction: () => openProjectCards?.(projectId, mode),
  })
}
