import type { VectorSelect } from '../../core/runtime-components'
import DotLoader from '../common/DotLoader'

export type QueryProgressState =
  | {
      type: 'reading-mentionables'
    }
  | {
      type: 'indexing'
      indexProgress: IndexProgress
    }
  | {
      type: 'querying'
    }
  | {
      type: 'querying-done'
      queryResult: (VectorSelect & {
        similarity: number
      })[]
    }
  | {
      type: 'idle'
    }

export type IndexProgress = {
  completedChunks: number
  totalChunks: number
  totalFiles: number
  waitingForRateLimit?: boolean
  // 文件夹级别的进度信息（可选，向后兼容）
  currentFolder?: string
  currentFile?: string
  completedFiles?: number
  folderProgress?: Record<
    string,
    {
      completedFiles: number
      totalFiles: number
      completedChunks: number
      totalChunks: number
    }
  >
  // 文件分类统计
  newFilesCount?: number
  updatedFilesCount?: number
  removedFilesCount?: number
}

// TODO: Update style
export default function QueryProgress({
  state,
}: {
  state: QueryProgressState
}) {
  switch (state.type) {
    case 'idle':
      return null
    case 'reading-mentionables':
      return (
        <div className="yolo-query-progress">
          <p>
            Reading mentioned files
            <DotLoader variant="dots" />
          </p>
        </div>
      )
    case 'indexing':
      return (
        <div className="yolo-query-progress">
          <p>
            {`Indexing ${state.indexProgress.totalFiles} file`}
            <DotLoader variant="dots" />
          </p>
          <p className="yolo-query-progress-detail">{`${state.indexProgress.completedChunks}/${state.indexProgress.totalChunks} chunks indexed`}</p>
          {state.indexProgress.waitingForRateLimit && (
            <p className="yolo-query-progress-detail">
              Waiting for rate limit to reset...
            </p>
          )}
        </div>
      )
    case 'querying':
      return (
        <div className="yolo-query-progress">
          <p>
            Querying the vault
            <DotLoader variant="dots" />
          </p>
        </div>
      )
    case 'querying-done':
      return (
        <div className="yolo-query-progress">
          <p>
            Reading related files
            <DotLoader variant="dots" />
          </p>
          {state.queryResult.map((result) => (
            <div key={result.path}>
              <p>{result.path}</p>
              <p>{result.similarity}</p>
            </div>
          ))}
        </div>
      )
  }
}
