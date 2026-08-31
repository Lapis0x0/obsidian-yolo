import { useLanguage } from '../../../contexts/language-context'

import {
  ScopePathKind,
  ScopeRule,
  ScopeRuleCounts,
  ScopeVariant,
  describeScope,
} from './scopeRules'

export type ScopeStatusTextProps = {
  rules: readonly ScopeRule[]
  variant: ScopeVariant
  pathKind: (path: string) => ScopePathKind
  estimate: { matched: number; total: number }
}

/**
 * The single sentence that answers "what is in scope, what is kept out, how
 * much is left" — rendered identically in the settings summary and at the top
 * of the editor modal so the two can never disagree.
 */
export function ScopeStatusText({
  rules,
  variant,
  pathKind,
  estimate,
}: ScopeStatusTextProps) {
  const { t } = useLanguage()
  const description = describeScope(rules, pathKind)

  const formatItems = (counts: ScopeRuleCounts): string => {
    const parts: string[] = []
    if (counts.folders > 0) {
      parts.push(
        t('settings.scope.status.folders', '{{n}} 个文件夹').replace(
          '{{n}}',
          String(counts.folders),
        ),
      )
    }
    if (counts.files > 0) {
      parts.push(
        t('settings.scope.status.files', '{{n}} 个文件').replace(
          '{{n}}',
          String(counts.files),
        ),
      )
    }
    return parts.join(t('settings.scope.status.joiner', '、'))
  }

  const main = description.hasInclude
    ? t(
        `settings.scope.status.${variant}.only`,
        variant === 'rag' ? '仅索引 {{items}}' : '仅开放 {{items}}',
      ).replace('{{items}}', formatItems(description.include))
    : t(
        `settings.scope.status.${variant}.all`,
        variant === 'rag' ? '索引整个库' : '整个库可用',
      )

  const excludeSuffix =
    description.exclude.total > 0
      ? t(
          description.hasInclude
            ? 'settings.scope.status.excludeWithinSuffix'
            : 'settings.scope.status.excludeSuffix',
          description.hasInclude ? '，其中排除 {{items}}' : '，排除 {{items}}',
        ).replace('{{items}}', formatItems(description.exclude))
      : ''

  const estimateText = t(
    `settings.scope.status.estimate.${variant}`,
    variant === 'rag'
      ? '约 {{n}} / {{total}} 篇'
      : '可访问 {{n}} / {{total}} 个文件',
  )
    .replace('{{n}}', String(estimate.matched))
    .replace('{{total}}', String(estimate.total))

  return (
    <>
      <b className="yolo-scope-status-main">{main}</b>
      {excludeSuffix ? <span>{excludeSuffix}</span> : null}
      <span className="yolo-scope-status-dot"> · </span>
      <span className="yolo-scope-status-estimate">{estimateText}</span>
    </>
  )
}
