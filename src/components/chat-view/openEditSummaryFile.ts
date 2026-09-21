import { type App, Notice, TFile } from 'obsidian'

import { readEditReviewSnapshot } from '../../database/edit-review/editReviewSnapshotStore'
import type { ApplyViewState } from '../../types/apply-view.types'
import type { GroupEditSummaryPathItem } from '../../utils/chat/editSummary'

import { isOutsideVaultEditPath, usableSnapshotPair } from './editTargetIo'

/**
 * What clicking a file in an assistant turn's edit summary does — the same
 * for the YOLO chat and a CLI chat, whose only differences are the arguments:
 * which conversation the review snapshots are keyed under, and whether that
 * conversation's agent is still running.
 *
 * With both review snapshots at hand (the first and the latest edit of this
 * file in the turn) and the file still exactly as the latest edit left it,
 * the file opens in the editor's diff review overlay. Otherwise it simply
 * opens, with a notice saying why there is no review where one would have
 * been expected.
 */
export const openEditSummaryFile = async ({
  app,
  openApplyReview,
  t,
  conversationId,
  isRunActive,
  file: { path, firstRoundId, latestRoundId, undoStatus },
}: {
  app: App
  openApplyReview: (state: ApplyViewState) => Promise<boolean>
  t: (keyPath: string, fallback?: string) => string
  /** The key review snapshots are stored under; `null` = none exist. */
  conversationId: string | null
  /** The conversation's agent is running, awaiting approval, or in a tool. */
  isRunActive: boolean
  file: GroupEditSummaryPathItem
}): Promise<void> => {
  // 评审是 Obsidian 编辑器视图上的 diff 覆盖层，只能开在 vault 里的
  // Markdown 文件上。vault 外的文件没有 `TFile`，也就没有可覆盖的编辑器。
  if (isOutsideVaultEditPath(path)) {
    new Notice(
      t(
        'chat.editSummary.reviewOutsideVault',
        '该文件在 vault 之外，无法在编辑器中评审。',
      ),
    )
    return
  }

  const targetEntry = app.vault.getAbstractFileByPath(path)
  const targetFile = targetEntry instanceof TFile ? targetEntry : null
  const openTargetFile = async (): Promise<boolean> => {
    if (!targetFile) {
      new Notice(t('chat.editSummary.fileMissing', '文件不存在或已被移动。'))
      return false
    }
    await app.workspace.getLeaf(false).openFile(targetFile)
    return true
  }

  if (!conversationId) {
    await openTargetFile()
    return
  }

  const [firstSnapshot, latestSnapshot] = await Promise.all([
    readEditReviewSnapshot({
      app,
      conversationId,
      roundId: firstRoundId,
      filePath: path,
    }),
    readEditReviewSnapshot({
      app,
      conversationId,
      roundId: latestRoundId,
      filePath: path,
    }),
  ])

  const snapshots = usableSnapshotPair(firstSnapshot, latestSnapshot)
  if (!snapshots) {
    if (!(await openTargetFile())) return
    // 卡片还在，快照不在：这台设备没做过这次编辑，或者文件大到没留正文。
    // 写入方从没提供过撤销（CLI agent 自己写盘，`undoStatus` 恒为
    // `unavailable`）时，本来就可能没有快照——不存在「本该有却缺了」这回事，
    // 打开文件即可，不作解释。
    if (undoStatus !== 'unavailable') {
      new Notice(
        t(
          'chat.editSummary.snapshotUnavailable',
          '本设备没有这次编辑的快照，无法撤销或评审（快照只保存在本机，不随笔记同步）。',
        ),
      )
    }
    return
  }

  // 覆盖层没有监听文件改动：agent 若在审阅期间再次写同一文件，跨越
  // suggestion 边界的待决块会被未经用户确认地判定为已结算。所以本对话的
  // agent 仍在运行（含等待审批）时不打开修订视图。
  if (isRunActive) {
    new Notice(
      t(
        'chat.editSummary.reviewWhileRunning',
        'Agent 仍在运行，可能继续修改文件。请等它结束后再评审。',
      ),
    )
    return
  }

  if (!snapshots.latest.afterExists) {
    new Notice(
      t('chat.editSummary.fileDeleted', '文件已被删除，可使用撤销进行恢复。'),
    )
    return
  }

  if (!targetFile) {
    new Notice(t('chat.editSummary.fileMissing', '文件不存在或已被移动。'))
    return
  }

  // 覆盖层比的是改前全文与编辑器里的当前内容；文件若在最后一次修改之后又被
  // 改过，那样画出来的 diff 就混进了不属于这一轮的改动。
  const currentContent = await app.vault.read(targetFile)
  if (currentContent !== snapshots.latest.afterContent) {
    await app.workspace.getLeaf(false).openFile(targetFile)
    new Notice(
      t(
        'chat.editSummary.reviewContentChanged',
        '文件在这次修改之后又被改动过，无法打开修订视图。',
      ),
    )
    return
  }

  await openApplyReview({
    file: targetFile,
    originalContent: snapshots.first.beforeContent,
    newContent: snapshots.latest.afterContent,
    viewMode: 'applied-review',
    reviewMode: 'full',
  })
}
