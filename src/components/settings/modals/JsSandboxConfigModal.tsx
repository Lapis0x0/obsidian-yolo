import {
  Database,
  FileCode2,
  FolderOpen,
  Globe2,
  Timer,
  TriangleAlert,
} from 'lucide-react'
import { App } from 'obsidian'
import { type ReactNode, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  type JsSandboxSettings,
  normalizeJsSandboxConfig,
} from '../../../core/mcp/jsSandboxSettings'
import {
  JS_SANDBOX_BROWSER_READ_DEFAULT_MAX_KB,
  JS_SANDBOX_BROWSER_READ_HARD_MAX_KB,
  JS_SANDBOX_BROWSER_READ_MIN_KB,
  JS_SANDBOX_DEFAULT_OUTPUT_MAX_BYTES,
  JS_SANDBOX_DEFAULT_TIMEOUT_MS,
  JS_SANDBOX_HARD_MAX_OUTPUT_BYTES,
  JS_SANDBOX_HARD_MAX_TIMEOUT_MS,
  JS_SANDBOX_MIN_OUTPUT_BYTES,
  JS_SANDBOX_MIN_TIMEOUT_MS,
  JS_SANDBOX_VAULT_READ_DEFAULT_MAX_KB,
  JS_SANDBOX_VAULT_READ_HARD_MAX_KB,
  JS_SANDBOX_VAULT_READ_MIN_KB,
} from '../../../core/mcp/jsSandboxTool'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'
import { ConfirmModal } from '../../modals/ConfirmModal'

type JsSandboxConfigModalProps = {
  app: App
  value?: JsSandboxSettings
  onChange: (next: JsSandboxSettings) => void
}

type CapKey =
  | 'allowFetch'
  | 'allowVaultRead'
  | 'allowDbQuery'
  | 'allowBrowserRead'
  | 'allowExternalScripts'

export class JsSandboxConfigModal extends ReactModal<JsSandboxConfigModalProps> {
  constructor(
    app: App,
    options: {
      title: string
      value?: JsSandboxSettings
      onChange: (next: JsSandboxSettings) => void
    },
  ) {
    super({
      app,
      Component: JsSandboxConfigModalContent,
      props: {
        app,
        value: options.value,
        onChange: options.onChange,
      },
      options: { title: options.title, className: 'yolo-js-exec-modal' },
    })
  }
}

function JsSandboxConfigModalContent({
  app,
  value,
  onChange,
}: JsSandboxConfigModalProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const [config, setConfig] = useState<JsSandboxSettings>(() =>
    normalizeJsSandboxConfig(value ?? {}),
  )

  const update = (next: JsSandboxSettings) => {
    const normalized = normalizeJsSandboxConfig(next)
    setConfig(normalized)
    onChange(normalized)
  }

  const handleCapToggle = (
    cap: CapKey,
    requested: boolean,
    confirmMessage: string,
  ) => {
    if (!requested) {
      if (cap === 'allowFetch' && config.allowExternalScripts) {
        update({ ...config, allowFetch: true })
        return
      }
      update({ ...config, [cap]: false })
      return
    }
    const snapshot = config
    new ConfirmModal(app, {
      title: t(
        'settings.agent.jsSandboxConfirmEnableTitle',
        'Enable extension capability',
      ),
      message: confirmMessage,
      ctaText: t('common.confirm', 'Confirm'),
      cancelText: t('common.cancel', 'Cancel'),
      onConfirm: () => update({ ...snapshot, [cap]: true }),
      onCancel: () =>
        setConfig((current) =>
          normalizeJsSandboxConfig({ ...current, [cap]: false }),
        ),
    }).open()
  }

  return (
    <div className="yolo-js-exec-config">
      <section className="yolo-js-exec-section">
        <div className="yolo-js-exec-section-head">
          <div>
            <h3>
              {t('settings.agent.jsSandboxExtTitle', 'Extension capabilities')}
            </h3>
          </div>
        </div>

        <div className="yolo-js-exec-cap-list">
          <CapabilityCard
            icon={<Database size={17} />}
            title={t(
              'settings.agent.jsSandboxAllowDbQuery',
              'Allow Knowledge Base Query',
            )}
            description={t(
              'settings.agent.jsSandboxAllowDbQueryDesc',
              'Let scripts query indexed vault content with semantic search and read Markdown/text content by known path. This capability is not constrained by the agent directory scope.',
            )}
            enabled={Boolean(config.allowDbQuery)}
            onToggle={(v) =>
              handleCapToggle(
                'allowDbQuery',
                v,
                t(
                  'settings.agent.jsSandboxAllowDbQueryConfirm',
                  'Enabling knowledge base query lets AI-generated scripts search indexed content and read Markdown/text content by known path. Continue?',
                ),
              )
            }
          >
            <div className="yolo-js-exec-nested">
              <ObsidianSetting
                className="yolo-js-exec-setting yolo-js-exec-textarea-header"
                name={t(
                  'settings.agent.jsSandboxDbMaxLimit',
                  'Max semantic rows',
                )}
                desc={t(
                  'settings.agent.jsSandboxDbMaxLimitDesc',
                  'Upper bound on semantic search results. Path reads are not affected. Range 1–100.',
                )}
              >
                <ObsidianTextInput
                  type="number"
                  value={String(config.dbQueryMaxLimit ?? '')}
                  placeholder="20"
                  onChange={(raw) => {
                    const parsed = Number.parseInt(raw, 10)
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                      update({ ...config, dbQueryMaxLimit: undefined })
                      return
                    }
                    update({
                      ...config,
                      dbQueryMaxLimit: Math.min(100, Math.max(1, parsed)),
                    })
                  }}
                />
              </ObsidianSetting>
            </div>
          </CapabilityCard>

          <CapabilityCard
            icon={<FolderOpen size={17} />}
            title={t(
              'settings.agent.jsSandboxAllowVaultRead',
              'Allow Vault Read',
            )}
            description={t(
              'settings.agent.jsSandboxAllowVaultReadDesc',
              'Let scripts list vault paths and read any vault file by path. This capability is not constrained by the agent directory scope. Risk: scripts could pass note contents to external services.',
            )}
            enabled={Boolean(config.allowVaultRead)}
            onToggle={(v) =>
              handleCapToggle(
                'allowVaultRead',
                v,
                t(
                  'settings.agent.jsSandboxAllowVaultReadConfirm',
                  "Enabling vault read lets AI-generated scripts list vault paths and read any file in the vault by path. This data passes through the LLM context. Only enable if you trust this agent's scripts. Continue?",
                ),
              )
            }
          >
            <div className="yolo-js-exec-nested">
              <ObsidianSetting
                className="yolo-js-exec-setting yolo-js-exec-textarea-header"
                name={t(
                  'settings.agent.jsSandboxVaultReadMaxKb',
                  'Max read size (KB)',
                )}
                desc={t(
                  'settings.agent.jsSandboxVaultReadMaxKbDesc',
                  'Per-call read limit. Larger text is shortened with a notice; larger binary files are refused. Range {min}–{max} KB.',
                )
                  .replace('{min}', String(JS_SANDBOX_VAULT_READ_MIN_KB))
                  .replace('{max}', String(JS_SANDBOX_VAULT_READ_HARD_MAX_KB))}
              >
                <ObsidianTextInput
                  type="number"
                  value={String(config.vaultReadMaxKb ?? '')}
                  placeholder={String(JS_SANDBOX_VAULT_READ_DEFAULT_MAX_KB)}
                  onChange={(raw) => {
                    const parsed = Number.parseInt(raw, 10)
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                      update({ ...config, vaultReadMaxKb: undefined })
                      return
                    }
                    update({
                      ...config,
                      vaultReadMaxKb: Math.min(
                        JS_SANDBOX_VAULT_READ_HARD_MAX_KB,
                        Math.max(JS_SANDBOX_VAULT_READ_MIN_KB, parsed),
                      ),
                    })
                  }}
                />
              </ObsidianSetting>
            </div>
          </CapabilityCard>

          <CapabilityCard
            icon={<Globe2 size={17} />}
            title={t(
              'settings.agent.jsSandboxAllowBrowserRead',
              'Allow Open Web Page Read',
            )}
            description={t(
              'settings.agent.jsSandboxAllowBrowserReadDesc',
              'Let scripts read the full HTML of web pages already open in Obsidian by page ID. This can include logged-in or private page content.',
            )}
            riskWarning={t(
              'settings.agent.jsSandboxAllowBrowserReadRisk',
              'Risk: scripts can read the full page DOM from pages you have opened in Obsidian, including hidden fields, embedded state, and private or logged-in content. Only enable for agents you fully trust.',
            )}
            enabled={Boolean(config.allowBrowserRead)}
            onToggle={(v) =>
              handleCapToggle(
                'allowBrowserRead',
                v,
                t(
                  'settings.agent.jsSandboxAllowBrowserReadConfirm',
                  'Enabling open web page read lets AI-generated scripts read full HTML from web pages already open in Obsidian by page ID. This content passes through the LLM context. Continue?',
                ),
              )
            }
          >
            <div className="yolo-js-exec-nested">
              <ObsidianSetting
                className="yolo-js-exec-setting yolo-js-exec-textarea-header"
                name={t(
                  'settings.agent.jsSandboxBrowserReadMaxKb',
                  'Max page HTML size (KB)',
                )}
                desc={t(
                  'settings.agent.jsSandboxBrowserReadMaxKbDesc',
                  'Per-call full HTML limit. Larger pages are refused instead of shortened. Range 1–1048576 KB. Leave blank to use the default.',
                )}
              >
                <ObsidianTextInput
                  type="number"
                  value={String(config.browserReadMaxKb ?? '')}
                  placeholder={String(JS_SANDBOX_BROWSER_READ_DEFAULT_MAX_KB)}
                  onChange={(raw) => {
                    const parsed = Number.parseInt(raw, 10)
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                      update({ ...config, browserReadMaxKb: undefined })
                      return
                    }
                    update({
                      ...config,
                      browserReadMaxKb: Math.min(
                        JS_SANDBOX_BROWSER_READ_HARD_MAX_KB,
                        Math.max(JS_SANDBOX_BROWSER_READ_MIN_KB, parsed),
                      ),
                    })
                  }}
                />
              </ObsidianSetting>
            </div>
          </CapabilityCard>

          <CapabilityCard
            icon={<Globe2 size={17} />}
            title={t(
              'settings.agent.jsSandboxAllowFetch',
              'Allow Network Fetch',
            )}
            description={t(
              'settings.agent.jsSandboxAllowFetchDesc',
              'Allow browser network requests, plus a separate $fetch helper for requests that need YOLO to bypass cross-origin limits. Also enabled automatically when external scripts are enabled.',
            )}
            riskWarning={t(
              'settings.agent.jsSandboxAllowFetchRisk',
              'Risk: scripts can reach any URL the browser can — public APIs, your local network, internal services, and the LLM provider itself. Data in the script (including vault contents you pass in) can be exfiltrated. Only enable for agents you fully trust.',
            )}
            enabled={Boolean(config.allowFetch || config.allowExternalScripts)}
            disabled={Boolean(config.allowExternalScripts)}
            onToggle={(v) =>
              handleCapToggle(
                'allowFetch',
                v,
                t(
                  'settings.agent.jsSandboxAllowFetchConfirm',
                  'Enabling network requests lets scripts contact browser-accessible addresses and use a separate YOLO host request helper when browser cross-origin limits block a response. Only enable this for an agent you trust. Continue?',
                ),
              )
            }
          />

          <CapabilityCard
            icon={<FileCode2 size={17} />}
            title={t(
              'settings.agent.jsSandboxAllowExternalScripts',
              'Allow External Scripts',
            )}
            description={t(
              'settings.agent.jsSandboxAllowExternalScriptsDesc',
              'Allow scripts to load and run remote JavaScript, and open the broader browser capabilities needed by those scripts.',
            )}
            riskWarning={t(
              'settings.agent.jsSandboxAllowExternalScriptsRisk',
              'EXTREME RISK: the agent can pull in and execute arbitrary remote JavaScript with the same privileges as your browser tab. This is functionally equivalent to running untrusted code from the internet. Anything in the vault that you pass into a script can be exfiltrated. Only enable for agents and code sources you fully trust.',
            )}
            enabled={Boolean(config.allowExternalScripts)}
            onToggle={(v) =>
              handleCapToggle(
                'allowExternalScripts',
                v,
                t(
                  'settings.agent.jsSandboxAllowExternalScriptsConfirm',
                  'Enabling external scripts lets the agent load and run remote JavaScript inside Obsidian. This is powerful and risky: only continue if you fully trust this agent and the code source.',
                ),
              )
            }
          />
        </div>
      </section>

      <section className="yolo-js-exec-section">
        <ObsidianSetting
          className="yolo-js-exec-setting yolo-js-exec-timeout"
          name={t(
            'settings.agent.jsSandboxTimeoutMs',
            'Execution timeout (ms)',
          )}
          nameExtra={
            <span className="yolo-js-exec-setting-icon" aria-hidden="true">
              <Timer size={14} />
            </span>
          }
          desc={t(
            'settings.agent.jsSandboxTimeoutMsDesc',
            'Maximum runtime for a single script call. Range {min}–{max}.',
          )
            .replace('{min}', String(JS_SANDBOX_MIN_TIMEOUT_MS))
            .replace('{max}', String(JS_SANDBOX_HARD_MAX_TIMEOUT_MS))}
        >
          <ObsidianTextInput
            type="number"
            value={
              typeof config.timeoutMs === 'number' &&
              Number.isFinite(config.timeoutMs)
                ? String(config.timeoutMs)
                : ''
            }
            placeholder={String(JS_SANDBOX_DEFAULT_TIMEOUT_MS)}
            onChange={(raw) => {
              const parsed = Number.parseInt(raw, 10)
              if (!Number.isFinite(parsed) || parsed <= 0) {
                update({ ...config, timeoutMs: undefined })
                return
              }
              const clamped = Math.min(
                JS_SANDBOX_HARD_MAX_TIMEOUT_MS,
                Math.max(JS_SANDBOX_MIN_TIMEOUT_MS, parsed),
              )
              update({ ...config, timeoutMs: clamped })
            }}
          />
        </ObsidianSetting>
        <ObsidianSetting
          className="yolo-js-exec-setting yolo-js-exec-timeout"
          name={t(
            'settings.agent.jsSandboxOutputMaxKb',
            'Max tool result size (KB)',
          )}
          desc={t(
            'settings.agent.jsSandboxOutputMaxKbDesc',
            'Upper bound on the JSON result returned to the model. Larger output is truncated to a prefix. Oversized responses consume model context tokens and can exceed the context window, driving up cost. Range {min}–{max} KB.',
          )
            .replace(
              '{min}',
              String(
                Math.max(1, Math.floor(JS_SANDBOX_MIN_OUTPUT_BYTES / 1024)),
              ),
            )
            .replace(
              '{max}',
              String(Math.floor(JS_SANDBOX_HARD_MAX_OUTPUT_BYTES / 1024)),
            )}
        >
          <ObsidianTextInput
            type="number"
            value={String(config.outputMaxKb ?? '')}
            placeholder={String(
              Math.floor(JS_SANDBOX_DEFAULT_OUTPUT_MAX_BYTES / 1024),
            )}
            onChange={(raw) => {
              const parsed = Number.parseInt(raw, 10)
              if (!Number.isFinite(parsed) || parsed <= 0) {
                update({ ...config, outputMaxKb: undefined })
                return
              }
              const hardMaxKb = Math.floor(
                JS_SANDBOX_HARD_MAX_OUTPUT_BYTES / 1024,
              )
              const minKb = Math.max(
                1,
                Math.floor(JS_SANDBOX_MIN_OUTPUT_BYTES / 1024),
              )
              update({
                ...config,
                outputMaxKb: Math.min(hardMaxKb, Math.max(minKb, parsed)),
              })
            }}
          />
        </ObsidianSetting>
      </section>
    </div>
  )
}

function CapabilityCard({
  icon,
  title,
  description,
  riskWarning,
  enabled,
  onToggle,
  disabled,
  children,
}: {
  icon: ReactNode
  title: string
  description: string
  riskWarning?: string
  enabled: boolean
  onToggle: (value: boolean) => void
  disabled?: boolean
  children?: ReactNode
}) {
  return (
    <div className={`yolo-js-exec-cap-card${enabled ? ' is-enabled' : ''}`}>
      <div className="yolo-js-exec-cap-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="yolo-js-exec-cap-body">
        <ObsidianSetting
          className="yolo-js-exec-cap-setting"
          name={title}
          desc={description}
        >
          <ObsidianToggle
            value={enabled}
            onChange={onToggle}
            disabled={disabled}
          />
        </ObsidianSetting>
        {riskWarning ? (
          <div className="yolo-js-exec-cap-risk" role="note">
            <TriangleAlert size={13} aria-hidden="true" />
            <span>{riskWarning}</span>
          </div>
        ) : null}
        {enabled && children}
      </div>
    </div>
  )
}
