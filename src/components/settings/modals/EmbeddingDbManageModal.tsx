import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import cx from 'clsx'
import dayjs from 'dayjs'
import { RefreshCw, Trash2 } from 'lucide-react'
import { App, Notice } from 'obsidian'

import { AppProvider } from '../../../contexts/app-context'
import {
  DatabaseProvider,
  useDatabase,
} from '../../../contexts/database-context'
import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { getEmbeddingModelClient } from '../../../core/rag/embedding'
import type YoloPlugin from '../../../main'
import { KnowledgeBase } from '../../../settings/schema/setting.types'
import {
  EmbeddingDbStats,
  EmbeddingModelClient,
} from '../../../types/embedding'
import { ReactModal } from '../../common/ReactModal'

type EmbeddingDbManagerModalComponentWrapperProps = {
  app: App
  plugin: YoloPlugin
}

// The in-memory VectorIndex always stores int8 rows (1 byte/dimension) plus
// a 4-byte float32 scale per row (see `src/database/vector-store/vectorIndex.ts`);
// this estimates that footprint from the model's configured dimension. Not
// derived from `getEmbeddingStats` (which reports on-disk float32 bytes), so
// there's no reason to touch that contract for this purely-local estimate.
// Exported so `RAGSection.tsx`'s knowledge base cards use the exact same
// formula for their "index size" estimate rather than a second one derived
// from on-disk `vectorBytes`.
export const inMemoryIndexMb = (
  rowCount: number,
  dimension: number | undefined,
): number | null => {
  if (dimension === undefined) return null
  return (rowCount * (dimension + 4)) / 1000 / 1000
}

export class EmbeddingDbManageModal extends ReactModal<EmbeddingDbManagerModalComponentWrapperProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app: app,
      Component: EmbeddingDbManagerModalComponentWrapper,
      props: { app, plugin },
      options: {
        title: plugin.t(
          'settings.knowledgeBases.manageDataTitle',
          '管理索引数据',
        ),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function EmbeddingDbManagerModalComponentWrapper({
  app,
  plugin,
  onClose,
}: EmbeddingDbManagerModalComponentWrapperProps & { onClose: () => void }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 0, // Immediately garbage collect queries. It prevents memory leak on ChatView close.
      },
      mutations: {
        gcTime: 0, // Immediately garbage collect mutations. It prevents memory leak on ChatView close.
      },
    },
  })

  return (
    <AppProvider app={app}>
      <SettingsProvider
        settings={plugin.settings}
        setSettings={(newSettings) => plugin.setSettings(newSettings)}
        addSettingsChangeListener={(listener) =>
          plugin.addSettingsChangeListener(listener)
        }
      >
        <DatabaseProvider getDatabaseManager={() => plugin.getDbManager()}>
          <QueryClientProvider client={queryClient}>
            <EmbeddingDbManageModalComponent onClose={onClose} />
          </QueryClientProvider>
        </DatabaseProvider>
      </SettingsProvider>
    </AppProvider>
  )
}

function KnowledgeBaseStatsTable({ kb }: { kb: KnowledgeBase }) {
  const { getVectorManager } = useDatabase()
  const { settings } = useSettings()
  const { t } = useLanguage()

  const {
    data: stats = [],
    isLoading,
    isFetching,
    refetch,
    dataUpdatedAt,
  } = useQuery<EmbeddingDbStats[]>({
    queryKey: ['embedding-db-stats', kb.id],
    queryFn: async () => {
      const dbStats = await (await getVectorManager(kb.id)).getEmbeddingStats()
      const statsMap = new Map(dbStats.map((stat) => [stat.model, stat]))
      return settings.embeddingModels
        .map((embeddingModel) => ({
          model: embeddingModel.id,
          rowCount: statsMap.get(embeddingModel.id)?.rowCount ?? 0,
          vectorBytes: statsMap.get(embeddingModel.id)?.vectorBytes ?? 0,
        }))
        .filter((stat) => stat.rowCount > 0)
    },
  })

  const handleRemoveIndex = (modelId: string) => {
    void (async () => {
      // Created inside the `try` (nullable outside it) — `getEmbeddingModelClient`
      // throws synchronously for a stale/removed model (e.g. a `yolo-local`
      // catalog entry that's been deleted), and that must still land on the
      // same `catch`/`finally` as every other failure here instead of
      // skipping the user-facing Notice and the stats refetch.
      let embeddingModel: EmbeddingModelClient | null = null
      try {
        embeddingModel = getEmbeddingModelClient({
          settings,
          embeddingModelId: modelId,
        })
        await (await getVectorManager(kb.id)).clearAllVectors(embeddingModel)
      } catch (error) {
        console.error(error)
        new Notice(
          t('settings.knowledgeBases.removeIndexFailed', '移除索引失败'),
        )
      } finally {
        // Scoped to this one call — for `yolo-local` it holds a
        // runtime-component lease that must be released here rather than
        // left to the 10-minute idle timeout.
        await embeddingModel?.dispose?.()
        await refetch().catch((error) => {
          console.error('Failed to refresh embedding DB stats:', error)
        })
      }
    })()
  }

  if (isLoading) {
    return <div>{t('common.loading', 'Loading...')}</div>
  }

  return (
    <div className="yolo-settings-embedding-db-manage-kb">
      <div className="yolo-settings-embedding-db-manage-kb-head">
        <span className="yolo-settings-embedding-db-manage-kb-name">
          {kb.name}
        </span>
        <div className="yolo-settings-embedding-db-manage-header">
          <button
            className="clickable-icon"
            aria-label={t('settings.knowledgeBases.manageRefresh', '刷新')}
            onClick={() => {
              void refetch().catch((error) => {
                console.error('Failed to refresh embedding DB stats:', error)
              })
            }}
            disabled={isFetching}
          >
            <RefreshCw size={14} className={cx(isFetching && 'yolo-spinner')} />
          </button>
          <span className="yolo-settings-embedding-db-manage-last-updated">
            {dayjs(dataUpdatedAt).format('YYYY-MM-DD HH:mm:ss')}
          </span>
        </div>
      </div>
      {stats.length === 0 ? (
        <div className="yolo-settings-embedding-db-manage-empty">
          {t('settings.knowledgeBases.noIndexedData', '尚未建立索引')}
        </div>
      ) : (
        <table className="yolo-settings-embedding-db-manage-table">
          <thead>
            <tr>
              <th>{t('settings.knowledgeBases.manageModelColumn', '模型')}</th>
              <th>
                {t(
                  'settings.knowledgeBases.manageEmbeddingsColumn',
                  '嵌入总数',
                )}
              </th>
              <th>{t('settings.rag.vectorDataSize', 'Vector data (MB)')}</th>
              <th>
                {t(
                  'settings.rag.inMemoryIndexEstimate',
                  'In-memory index (MB)',
                )}
              </th>
              <th>
                {t('settings.knowledgeBases.manageActionsColumn', '操作')}
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.map((stat) => {
              const dimension = settings.embeddingModels.find(
                (embeddingModel) => embeddingModel.id === stat.model,
              )?.dimension
              const estimateMb = inMemoryIndexMb(stat.rowCount, dimension)
              return (
                <tr key={stat.model}>
                  <td>{stat.model}</td>
                  <td>{stat.rowCount}</td>
                  <td>{(stat.vectorBytes / 1e6).toFixed(2)}</td>
                  <td>{estimateMb === null ? '-' : estimateMb.toFixed(2)}</td>
                  <td className="yolo-settings-embedding-db-manage-actions">
                    <button
                      className="clickable-icon"
                      aria-label={t(
                        'settings.knowledgeBases.manageRemoveIndex',
                        '移除索引',
                      )}
                      onClick={() => handleRemoveIndex(stat.model)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

function EmbeddingDbManageModalComponent({
  onClose: _onClose,
}: {
  onClose: () => void
}) {
  const { settings } = useSettings()
  const { t } = useLanguage()

  if (settings.knowledgeBases.length === 0) {
    return (
      <div className="yolo-settings-embedding-db-manage-empty">
        {t('settings.knowledgeBases.emptyState', '还没有知识库')}
      </div>
    )
  }

  return (
    <div className="yolo-settings-embedding-db-manage-root">
      {settings.knowledgeBases.map((kb) => (
        <KnowledgeBaseStatsTable key={kb.id} kb={kb} />
      ))}
    </div>
  )
}
