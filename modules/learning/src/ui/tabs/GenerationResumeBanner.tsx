import { AlertTriangle, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { GenerationResumePort } from '../LearningWorkspace'
import type { LearningTranslate } from '../wizard/Wizard'

type BannerState =
  | { kind: 'hidden' }
  | { kind: 'resumable'; completed: number; total: number }
  | { kind: 'resuming'; completed: number; total: number }
  | { kind: 'error'; message: string }

/**
 * Shown at the top of a project's workspace when it has a generation task
 * that started but never finished — e.g. Obsidian was closed mid-run. Reads
 * its state purely from {@link GenerationResumePort.inspectResumability} and
 * live task events; it never assumes a task is running just because this
 * project is currently open.
 */
export function GenerationResumeBanner({
  projectId,
  resume,
  t,
  onResumed,
}: {
  projectId: string
  resume: GenerationResumePort
  t: LearningTranslate
  onResumed: () => void
}) {
  const [state, setState] = useState<BannerState>({ kind: 'hidden' })

  useEffect(() => {
    let cancelled = false
    const current = resume.getCurrentTask()
    if (
      current &&
      current.projectId === projectId &&
      (current.status === 'knowledge-points' || current.status === 'cards')
    ) {
      setState({ kind: 'resuming', ...chapterCounts(current.chapters) })
      return
    }
    setState({ kind: 'hidden' })
    resume
      .inspectResumability(projectId)
      .then((inspection) => {
        if (cancelled) return
        setState(
          inspection.resumable
            ? {
                kind: 'resumable',
                completed: inspection.completedChapters,
                total: inspection.totalChapters,
              }
            : { kind: 'hidden' },
        )
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'hidden' })
      })
    return () => {
      cancelled = true
    }
  }, [projectId, resume])

  useEffect(
    () =>
      resume.subscribe((event) => {
        if (event.snapshot.projectId !== projectId) return
        switch (event.type) {
          case 'completed':
          case 'aborted':
            setState({ kind: 'hidden' })
            onResumed()
            break
          case 'error':
            setState({
              kind: 'error',
              message: event.snapshot.error ?? 'unknown error',
            })
            onResumed()
            break
          default:
            setState({
              kind: 'resuming',
              ...chapterCounts(event.snapshot.chapters),
            })
        }
      }),
    [projectId, resume, onResumed],
  )

  const handleResume = () => {
    void resume
      .resumeProjectGeneration(projectId)
      .then((snapshot) => {
        setState({ kind: 'resuming', ...chapterCounts(snapshot.chapters) })
      })
      .catch((error) => {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  if (state.kind === 'hidden') return null

  return (
    <div className="yolo-learning-workspace-resume-banner" role="status">
      <AlertTriangle size={14} aria-hidden />
      <div className="yolo-learning-workspace-resume-banner-text">
        <span className="yolo-learning-workspace-resume-banner-title">
          {state.kind === 'error'
            ? t(
                'learning.generation.resumeFailed',
                'Failed to resume: {error}',
              ).replace('{error}', state.message)
            : t(
                'learning.generation.resumeBannerTitle',
                'Generation unfinished',
              )}
        </span>
        {state.kind !== 'error' ? (
          <span className="yolo-learning-workspace-resume-banner-detail">
            {t(
              'learning.generation.resumeBannerDetail',
              '{completed}/{total} chapters generated',
            )
              .replace('{completed}', String(state.completed))
              .replace('{total}', String(state.total))}
          </span>
        ) : null}
      </div>
      <button
        className="yolo-learning-workspace-resume-banner-action"
        disabled={state.kind === 'resuming'}
        onClick={handleResume}
        type="button"
      >
        {state.kind === 'resuming' ? (
          <Loader2
            aria-hidden
            className="yolo-learning-outline-builder-pulse"
            size={14}
          />
        ) : null}
        {state.kind === 'resuming'
          ? t('learning.generation.resumeInProgress', 'Resuming…')
          : t(
              'learning.generation.resumeAction',
              'Continue from where it stopped',
            )}
      </button>
    </div>
  )
}

function chapterCounts(chapters: readonly { status: string }[]): {
  completed: number
  total: number
} {
  return {
    completed: chapters.filter((chapter) => chapter.status === 'completed')
      .length,
    total: chapters.length,
  }
}
