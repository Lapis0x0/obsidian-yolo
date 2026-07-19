import { LearningCardFileStore, scanProjectCards } from '../../domain/cardFile'
import {
  createHostLearningVaultReadApi,
  createHostLearningVaultWriteApi,
} from '../../domain/hostVaultAdapter'
import type { LearningVaultWriteApi } from '../../domain/learningVaultWriteApi'
import { ProjectEventBus } from '../../domain/projectEventBus'
import { scanProject, scanProjects } from '../../domain/projectScanner'
import { LearningGenerationAbortError } from '../../generation/abortError'
import { generateCardsParallel } from '../../generation/cardGenerator'
import type {
  LearningGenerationActivity,
  LearningGenerationHost,
} from '../../generation/host'
import { generateKnowledgePointsForChapter } from '../../generation/knowledgePointGenerator'
import { createLearningGenerationAgent } from '../../generation/moduleAgentAdapter'
import { generateOutline } from '../../generation/outlineGenerator'
import {
  appendKnowledgePointDraft,
  createProjectScaffold,
  markProjectStudying,
} from '../../generation/projectWriter'
import {
  validateReferenceFile,
  writeReferenceToStaging,
} from '../../generation/referenceStaging'
import type { CardsViewServices } from '../../ui/cards/CardsView'
import type { ExercisesViewServices } from '../../ui/exercises/ExercisesView'
import type { HomeProjectActions } from '../../ui/home/HomeView'
import type { LearningWorkspaceGenerationEvents } from '../../ui/LearningWorkspace'
import type { OutlineBuilderWorkflow } from '../../ui/outline/OutlineBuilder'
import type { OutlineViewHost } from '../../ui/outline/OutlineView'
import type { WizardReferenceHost } from '../../ui/wizard/Wizard'
import type { HostLearningRuntimeAdapter } from '../runtime'

type Runtime = HostLearningRuntimeAdapter['runtime']

export type LearningUiProjectGenerationPort = Readonly<{
  /** Called after knowledge files are complete and the project enters studying. */
  onProjectReady?(projectPath: string): void | Promise<void>
  /** Card generation is supported by the module, but callers may disable it. */
  generateCards?: boolean
  /** Opens the generated project's cards without coupling this host adapter to navigation. */
  openProjectCards?(
    projectPath: string,
    mode: '学习' | '浏览',
  ): void | Promise<void>
}>

export type CreateLearningUiServicesOptions = Readonly<{
  runtime: Runtime
  ownerDocument: Document
  generation?: LearningUiProjectGenerationPort
  getGenerationModelId?: () => string | undefined
  isGenerationDebugEnabled?: () => boolean
  reportError?: (message: string, error: unknown) => void
}>

export type LearningUiServices = Readonly<{
  ownerDocument: Document
  homeProjectActions: HomeProjectActions
  wizardReferences: WizardReferenceHost
  createOutlineBuilderWorkflow(
    events?: LearningWorkspaceGenerationEvents,
  ): OutlineBuilderWorkflow
  /** Compatibility workflow for callers that do not consume generation events. */
  outlineBuilderWorkflow: OutlineBuilderWorkflow
  outlineViewHost: OutlineViewHost
  cardsViewServices: CardsViewServices
  exercisesViewServices: ExercisesViewServices
  eventBus: ProjectEventBus
  scanProjects(): ReturnType<typeof scanProjects>
  scanProject(projectPath: string): ReturnType<typeof scanProject>
  getLearningBaseDir(): string
  dispose(): void
}>

type ProjectWriterPort = Pick<
  LearningVaultWriteApi,
  'ensureFolder' | 'listChildNames' | 'createText' | 'writeText'
>

let stagingSequence = 0

/**
 * Closes the migrated Learning UI over Host 1.1 and the module runtime.
 * Every managed-root lookup is live so host path changes do not stale closures.
 */
export function createLearningUiServices(
  host: YoloModuleHostApiV1,
  options: CreateLearningUiServicesOptions,
): LearningUiServices {
  const vault = createHostLearningVaultReadApi(host.vault)
  const hostWriter = createHostLearningVaultWriteApi(host.vault)
  const cardFiles = new LearningCardFileStore(vault, hostWriter)
  const eventBus = new ProjectEventBus(vault)
  const getLearningBaseDir = () =>
    normalizePath(host.paths.getSnapshot().contentRoot)
  const getSrs = () => options.runtime.getSrsStore()
  const generationHost: LearningGenerationHost = {
    vault,
    // The generation code only consumes the CAS subset. Host 1.1 deliberately
    // does not implement LearningVaultWriteApi's permanent-removal operations.
    vaultWriter: hostWriter as LearningVaultWriteApi,
    agent: createLearningGenerationAgent(host.agent),
    isDebugEnabled: () => options.isGenerationDebugEnabled?.() ?? false,
  }

  const markdown = {
    createRenderer: () => host.ui.createMarkdownRenderer(),
  }

  const homeProjectActions: HomeProjectActions = {
    setPaused: async (project, paused) => {
      if (paused) await getSrs().pauseProject(project.slug, new Date())
      else await getSrs().resumeProject(project.slug, new Date())
    },
    deleteProject: async (project) => {
      assertCurrentProjectPath(project.folderPath, getLearningBaseDir())
      const entry = host.vault.getEntry(project.folderPath)
      if (entry?.kind !== 'folder') {
        throw new Error(
          `Learning project folder not found: ${project.folderPath}`,
        )
      }
      const srs = getSrs()
      const wasPaused = await srs.isProjectPaused(project.slug)
      if (!wasPaused) await srs.pauseProject(project.slug, new Date())
      try {
        const trashed = await host.vault.trashPath(entry.path)
        if (!trashed) {
          throw new Error(`Learning project folder not found: ${entry.path}`)
        }
      } catch (error) {
        if (!wasPaused) {
          try {
            await srs.resumeProject(project.slug, new Date())
          } catch (resumeError) {
            options.reportError?.(
              'Failed to restore Learning project pause state',
              resumeError,
            )
          }
        }
        throw error
      }
      try {
        await srs.deleteProjectState(project.slug)
        return 'deleted'
      } catch (error) {
        options.reportError?.('Failed to delete Learning SRS state', error)
        return 'deleted-state-failed'
      }
    },
    confirmDelete: (project, onConfirm) => {
      void host.ui
        .confirm({
          title: '删除学习项目？',
          message: `“${project.topic}”及其复习数据将移入回收站。`,
          ctaText: '删除',
          cancelText: '取消',
        })
        .then((confirmed) => {
          if (confirmed) onConfirm()
        })
        .catch((error: unknown) => {
          options.reportError?.(
            'Failed to confirm Learning project deletion',
            error,
          )
        })
    },
    showNotice: (message) => host.ui.notice(message),
    reportError: options.reportError,
  }

  const wizardReferences: WizardReferenceHost = {
    createStagingDir: async () => {
      const root = getLearningBaseDir()
      const path = `${root}/_staging/${Date.now().toString(36)}-${(stagingSequence++).toString(
        36,
      )}`
      await host.vault.ensureFolder(path)
      return path
    },
    validateFile: validateReferenceFile,
    writeFile: async (stagingDir, file) => {
      assertPathInRoot(stagingDir, getLearningBaseDir(), '_staging')
      return writeReferenceToStaging(
        hostWriter as LearningVaultWriteApi,
        stagingDir,
        file.name,
        file.contents,
      )
    },
    removeFile: async (path) => {
      assertPathInRoot(path, getLearningBaseDir(), '_staging')
      if (!(await host.vault.removeFileExact(path))) {
        throw new Error(`Staged reference not found: ${path}`)
      }
    },
    cleanup: async (stagingDir) => {
      assertPathInRoot(stagingDir, getLearningBaseDir(), '_staging')
      await host.vault.trashPath(stagingDir)
    },
  }

  const outlineViewHost: OutlineViewHost = {
    readText: async (path) =>
      host.vault.getEntry(path)?.kind === 'file'
        ? host.vault.readText(path)
        : null,
    openMarkdownAtLine: (path, line) => {
      void host.ui
        .openFileAt({ path, ...(line == null ? {} : { line }) })
        .catch((error: unknown) => {
          options.reportError?.('Failed to open Learning markdown', error)
        })
    },
    createMarkdownRenderer: () => host.ui.createMarkdownRenderer(),
    htmlToMarkdown: (html) => host.ui.htmlToMarkdown(html),
    openLinkText: (linktext, sourcePath, newLeaf) =>
      host.ui.openLink(linktext, sourcePath, newLeaf),
    isModEvent: (event) => host.ui.isModEvent(event),
    triggerHoverLink: ({ event, targetEl, linktext, sourcePath }) => {
      const HTMLElementConstructor =
        options.ownerDocument.defaultView?.HTMLElement
      if (
        !HTMLElementConstructor ||
        !(targetEl instanceof HTMLElementConstructor)
      ) {
        return
      }
      host.ui.hoverLink({ event, targetEl, linktext, sourcePath })
    },
  }

  const cardsViewServices: CardsViewServices = {
    vault,
    scanProjectCards: (projectPath, expectedCardPaths) =>
      scanProjectCards(vault, projectPath, expectedCardPaths),
    srs: getSrs(),
    cardFiles,
    markdown,
    showNotice: (message) => host.ui.notice(message),
  }

  const createWorkflow = (events?: LearningWorkspaceGenerationEvents) =>
    buildOutlineBuilderWorkflow({
      host,
      runtime: options.runtime,
      generationHost,
      eventBus,
      getLearningBaseDir,
      getModelId: () =>
        options.getGenerationModelId?.() ??
        host.settings.getModelSnapshot().defaultModelId,
      projectGeneration: options.generation,
      events,
    })
  const outlineBuilderWorkflow = createWorkflow()

  let disposed = false
  return Object.freeze({
    ownerDocument: options.ownerDocument,
    homeProjectActions,
    wizardReferences,
    createOutlineBuilderWorkflow: createWorkflow,
    outlineBuilderWorkflow,
    outlineViewHost,
    cardsViewServices,
    exercisesViewServices: { vault } satisfies ExercisesViewServices,
    eventBus,
    scanProjects: () => scanProjects(vault, getLearningBaseDir()),
    scanProject: (projectPath) => {
      assertCurrentProjectPath(projectPath, getLearningBaseDir())
      return scanProject(vault, projectPath)
    },
    getLearningBaseDir,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (options.runtime.getEventBus() === eventBus) {
        options.runtime.setEventBus(null)
      }
      eventBus.dispose()
    },
  })
}

function buildOutlineBuilderWorkflow({
  host,
  runtime,
  generationHost,
  eventBus,
  getLearningBaseDir,
  getModelId,
  projectGeneration,
  events,
}: {
  host: YoloModuleHostApiV1
  runtime: Runtime
  generationHost: LearningGenerationHost
  eventBus: ProjectEventBus
  getLearningBaseDir: () => string
  getModelId: () => string | undefined
  projectGeneration?: LearningUiProjectGenerationPort
  events?: LearningWorkspaceGenerationEvents
}): OutlineBuilderWorkflow {
  const vault = generationHost.vault
  const writer: ProjectWriterPort = {
    ensureFolder: (path) => host.vault.ensureFolder(path),
    listChildNames: async (path) =>
      host.vault.listChildren(path).map((entry) => entry.name),
    createText: (path, content) => host.vault.createText(path, content),
    writeText: (path, content) => host.vault.writeText(path, content),
  }

  return {
    generateOutline: async (input) => {
      const root = getLearningBaseDir()
      for (const reference of input.referenceFiles ?? []) {
        assertPathInRoot(reference.vaultPath, root, '_staging')
      }
      const workspaceScope = input.stagingDir
        ? scopedReferenceWorkspace(input.stagingDir, root)
        : undefined
      const result = await generateOutline({
        host: generationHost,
        modelId: getModelId(),
        topic: input.topic,
        level: input.level,
        goal: input.goal,
        referencesBlock: input.referencesBlock,
        referenceFiles: input.referenceFiles?.map(({ name, vaultPath }) => ({
          name,
          vaultPath,
        })),
        workspaceScope,
        abortSignal: input.signal,
        activity: generationActivity('正在生成学习项目大纲', input.topic),
        onOutline: input.onOutline,
        onProgress: () => input.onProgress(),
      })
      return result.outline
    },
    generateProject: async (input) => {
      const root = getLearningBaseDir()
      const projectWriter = writer as LearningVaultWriteApi
      const scaffold = await createProjectScaffold({
        writer: projectWriter,
        baseDir: root,
        topic: input.projectName || input.topic,
        goal: input.projectGoal || input.goal,
        chapters: [...input.chapters],
      })
      let referenceDir: string | undefined
      if (input.stagingDir && input.referenceFiles?.length) {
        referenceDir = await moveStagedReferences({
          host,
          root,
          stagingDir: input.stagingDir,
          projectPath: scaffold.projectPath,
        })
      }
      await eventBus.setActiveProject(root, scaffold.projectPath)
      runtime.setEventBus(eventBus)
      await input.onProjectStarted(scaffold.projectPath)

      const workspaceScope = referenceDir
        ? { enabled: true, include: [referenceDir], exclude: [] }
        : undefined
      const outcomes = await Promise.all(
        input.chapters.map(async (chapter, chapterIndex) => {
          const target = scaffold.chapters[chapterIndex]
          input.onChapterProgress({
            chapterIndex,
            chapterTitle: chapter.title,
            status: 'generating',
          })
          if (!target)
            return new Error(`Missing chapter target: ${chapter.title}`)
          try {
            const result = await generateKnowledgePointsForChapter({
              host: generationHost,
              modelId: getModelId(),
              chapterIndex,
              projectTopic: input.projectName || input.topic,
              chapterTitle: chapter.title,
              chapterContract: chapter.contract,
              level: input.level,
              workspaceScope,
              referenceDir,
              abortSignal: input.signal,
              activity: generationActivity('正在生成学习项目', chapter.title),
              onProgress: (_delta, fullText) => {
                input.onChapterProgress({
                  chapterIndex,
                  chapterTitle: chapter.title,
                  status: 'generating',
                  currentKnowledgePointTitle: lastMarkdownHeading(fullText),
                })
              },
              onKnowledgePoint: (point) =>
                appendKnowledgePointDraft({
                  vault,
                  writer: projectWriter,
                  projectPath: scaffold.projectPath,
                  chapter: target,
                  point,
                }).then(() => undefined),
            })
            if (result.drafts.length === 0) {
              throw new Error(`No knowledge points generated: ${chapter.title}`)
            }
            input.onChapterProgress({
              chapterIndex,
              chapterTitle: chapter.title,
              status: 'completed',
            })
            return null
          } catch (error) {
            input.onChapterProgress({
              chapterIndex,
              chapterTitle: chapter.title,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            })
            return error
          }
        }),
      )
      const failure = outcomes.find((outcome) => outcome !== null)
      if (failure) throw failure
      await markProjectStudying({
        vault,
        writer: projectWriter,
        indexPath: scaffold.indexPath,
      })
      await eventBus.refreshSnapshot({ emitInitial: false })
      await projectGeneration?.onProjectReady?.(scaffold.projectPath)
      input.onComplete(scaffold.projectPath)

      if (projectGeneration?.generateCards !== false) {
        const runId = `cards-${Date.now().toString(36)}`
        const projectId = scaffold.projectPath
        let failed = true
        events?.onCardGenerationStarted(runId, projectId)
        try {
          const results = await generateCardsParallel({
            host: generationHost,
            modelId: getModelId(),
            projectTopic: input.projectName || input.topic,
            projectPath: scaffold.projectPath,
            chapters: input.chapters.map((chapter, index) => ({
              ...chapter,
              knowledgePath: scaffold.chapters[index].knowledgePath,
              cardsPath: scaffold.chapters[index].cardsPath,
            })),
            level: input.level,
            workspaceScope,
            abortSignal: input.signal,
            activity: generationActivity(
              '正在生成学习卡片',
              input.projectName || input.topic,
            ),
            runId,
            projectId,
            onCard: (event) => events?.onCard(event),
            onChapterSettled: (result) =>
              events?.onChapterSettled(runId, projectId, result),
          })
          if (input.signal.aborted) {
            throw new LearningGenerationAbortError('Card generation aborted')
          }
          const outcome = getCardGenerationOutcome(results)
          failed = outcome !== 'success'
          await eventBus.refreshSnapshot({ emitInitial: false })
          showCardGenerationToast({
            host,
            projectGeneration,
            projectId,
            runId,
            outcome,
            cardCount: results.reduce(
              (total, result) => total + result.cards.length,
              0,
            ),
          })
        } catch (error) {
          if (!input.signal.aborted) {
            showCardGenerationToast({
              host,
              projectGeneration,
              projectId,
              runId,
              outcome: 'failed',
              cardCount: 0,
            })
          }
          throw error
        } finally {
          events?.onCardGenerationFinished(runId, projectId, failed)
        }
      }
    },
  }
}

function generationActivity(
  title: string,
  detail: string,
): LearningGenerationActivity {
  return { title, detail }
}

function getCardGenerationOutcome(
  results: Awaited<ReturnType<typeof generateCardsParallel>>,
): 'success' | 'partial' | 'failed' {
  if (
    results.length === 0 ||
    results.every((result) => result.status === 'failed')
  ) {
    return 'failed'
  }
  return results.some(
    (result) => result.status === 'partial' || result.status === 'failed',
  )
    ? 'partial'
    : 'success'
}

function showCardGenerationToast({
  host,
  projectGeneration,
  projectId,
  runId,
  outcome,
  cardCount,
}: {
  host: YoloModuleHostApiV1
  projectGeneration?: LearningUiProjectGenerationPort
  projectId: string
  runId: string
  outcome: 'success' | 'partial' | 'failed'
  cardCount: number
}): void {
  const mode = outcome === 'success' ? '学习' : '浏览'
  const copy =
    outcome === 'success'
      ? {
          tone: 'success' as const,
          title: '学习卡片生成完成',
          message: `已生成 ${cardCount} 张卡片，可以开始学习。`,
        }
      : outcome === 'partial'
        ? {
            tone: 'warning' as const,
            title: '部分学习卡片生成完成',
            message: `已保留 ${cardCount} 张可用卡片，可先浏览生成结果。`,
          }
        : {
            tone: 'error' as const,
            title: '学习卡片生成失败',
            message: '未能生成可用卡片，请稍后重试。',
          }
  host.ui.showActionToast({
    id: `card-generation-${runId}`,
    ...copy,
    actionLabel: mode === '学习' ? '开始学习' : '浏览卡片',
    dismissLabel: '关闭',
    onAction: () => projectGeneration?.openProjectCards?.(projectId, mode),
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

function scopedReferenceWorkspace(stagingDir: string, root: string) {
  assertPathInRoot(stagingDir, root, '_staging')
  return { enabled: true, include: [stagingDir], exclude: [] }
}

function lastMarkdownHeading(markdown: string): string | undefined {
  return [...markdown.matchAll(/^##\s+(.+?)(?:\s+<!--|$)/gm)]
    .at(-1)?.[1]
    ?.trim()
}

function assertCurrentProjectPath(path: string, root: string): void {
  assertPathInRoot(path, root)
  if (normalizePath(path) === normalizePath(root)) {
    throw new Error(`Expected a project below Learning root: ${path}`)
  }
}

function assertPathInRoot(path: string, root: string, child?: string): void {
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(root)
  const requiredRoot = child ? `${normalizedRoot}/${child}` : normalizedRoot
  if (
    normalizedPath !== requiredRoot &&
    !normalizedPath.startsWith(`${requiredRoot}/`)
  ) {
    throw new Error(`Path is outside the current Learning root: ${path}`)
  }
}

function normalizePath(path: string): string {
  const segments: string[] = []
  for (const segment of path.trim().replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) throw new Error(`Invalid vault path: ${path}`)
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  if (segments.length === 0) throw new Error(`Invalid vault path: ${path}`)
  return segments.join('/')
}
