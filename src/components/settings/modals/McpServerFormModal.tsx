import * as Tooltip from '@radix-ui/react-tooltip'
import { Info } from 'lucide-react'
import { App, Notice } from '../../../runtime/react-compat'
import { useCallback, useEffect, useState } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import * as z from 'zod'

import { useLanguage } from '../../../contexts/language-context'
import { validateServerName } from '../../../core/mcp/tool-name-utils'
import SmartComposerPlugin from '../../../main'
import {
  McpServerParameters,
  getMcpServerNamesFromInput,
  mcpServerParametersSchema,
  normalizeMcpServerParameters,
} from '../../../types/mcp.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'

type McpServerFormComponentProps = {
  plugin: SmartComposerPlugin
  serverId?: string
}

export class AddMcpServerModal extends ReactModal<McpServerFormComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app: app,
      Component: McpServerFormComponent,
      props: { plugin },
      options: {
        title: plugin.t('settings.mcp.addServerTitle', 'Add server'),
      },
      plugin: plugin,
    })
  }
}

export class EditMcpServerModal extends ReactModal<McpServerFormComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin, editServerId: string) {
    super({
      app: app,
      Component: McpServerFormComponent,
      props: { plugin, serverId: editServerId },
      options: {
        title: plugin.t('settings.mcp.editServerTitle', 'Edit server'),
      },
      plugin: plugin,
    })
  }
}

function McpServerFormComponent({
  plugin,
  onClose,
  serverId,
}: McpServerFormComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const existingServer = serverId
    ? plugin.settings.mcp.servers.find((server) => server.id === serverId)
    : undefined

  const [name, setName] = useState(existingServer?.id ?? '')
  const [isNameManuallyEdited, setIsNameManuallyEdited] = useState(
    existingServer !== undefined,
  )
  const [parameters, setParameters] = useState(
    existingServer ? JSON.stringify(existingServer.parameters, null, 2) : '',
  )
  const [validationError, setValidationError] = useState<string | null>(null)

  const PARAMETERS_PLACEHOLDER = JSON.stringify(
    {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '<YOUR_TOKEN>',
      },
    },
    null,
    2,
  )

  const handleSubmit = async () => {
    try {
      const serverName = name.trim()
      if (serverName.length === 0) {
        throw new Error(
          t('settings.mcp.serverNameRequired', 'Name is required'),
        )
      }
      validateServerName(serverName)

      if (
        plugin.settings.mcp.servers.find(
          (server) =>
            server.id === serverName && server.id !== existingServer?.id,
        )
      ) {
        throw new Error(
          t(
            'settings.mcp.serverAlreadyExists',
            'Server with same name already exists',
          ),
        )
      }

      if (parameters.trim().length === 0) {
        throw new Error(
          t('settings.mcp.parametersRequired', 'Parameters are required'),
        )
      }
      let parsedParameters: unknown
      try {
        parsedParameters = JSON.parse(parameters)
      } catch {
        throw new Error(
          t(
            'settings.mcp.parametersMustBeValidJson',
            'Parameters must be valid JSON',
          ),
        )
      }
      const validatedParameters: McpServerParameters =
        normalizeMcpServerParameters({
          value: parsedParameters,
          serverName,
        })

      const newSettings = {
        ...plugin.settings,
        mcp: {
          ...plugin.settings.mcp,
          servers: existingServer
            ? plugin.settings.mcp.servers.map((server) =>
                server.id === existingServer.id
                  ? {
                      ...server,
                      id: serverName,
                      parameters: validatedParameters,
                    }
                  : server,
              )
            : [
                ...plugin.settings.mcp.servers,
                {
                  id: serverName,
                  parameters: validatedParameters,
                  toolOptions: {},
                  enabled: true,
                },
              ],
        },
      }

      await plugin.setSettings(newSettings)

      onClose()
    } catch (error) {
      if (error instanceof Error) {
        new Notice(error.message)
      } else {
        console.error(error)
        new Notice(
          t('settings.mcp.failedToAddServer', 'Failed to add MCP server.'),
        )
      }
    }
  }

  const validateParameters = useCallback(
    (parameters: string) => {
      try {
        if (parameters.length === 0) {
          setValidationError(
            t('settings.mcp.parametersRequired', 'Parameters are required'),
          )
          return
        }
        const parsedParameters = JSON.parse(parameters)
        mcpServerParametersSchema.parse(
          normalizeMcpServerParameters({
            value: parsedParameters,
            serverName: name.trim(),
          }),
        )
        setValidationError(null)
      } catch (error) {
        if (error instanceof SyntaxError) {
          // JSON parse error
          setValidationError(
            t('settings.mcp.invalidJsonFormat', 'Invalid JSON format'),
          )
        } else if (error instanceof z.ZodError) {
          // Zod error
          const formattedErrors = error.errors
            .map((err) => {
              const path = err.path.length > 0 ? `${err.path.join('.')}: ` : ''
              return `${path}${err.message}`
            })
            .join('\n')
          setValidationError(formattedErrors)
        } else {
          setValidationError(
            error instanceof Error
              ? error.message
              : t('settings.mcp.invalidParameters', 'Invalid parameters'),
          )
        }
      }
    },
    [name, t],
  )

  useEffect(() => {
    validateParameters(parameters)
  }, [parameters, validateParameters])

  useEffect(() => {
    if (serverId !== undefined || isNameManuallyEdited) {
      return
    }

    try {
      const parsedParameters = JSON.parse(parameters)
      const serverNames = getMcpServerNamesFromInput(parsedParameters)
      if (serverNames.length === 1 && name !== serverNames[0]) {
        setName(serverNames[0])
      }
    } catch {
      // ignore JSON parse failures here; validation handles display errors
    }
  }, [isNameManuallyEdited, name, parameters, serverId])

  return (
    <>
      <ObsidianSetting
        name={t('settings.mcp.serverNameField', 'Name')}
        desc={t(
          'settings.mcp.serverNameFieldDesc',
          'The name of the MCP server',
        )}
        required
      >
        <ObsidianTextInput
          value={name}
          onChange={(value: string) => {
            setIsNameManuallyEdited(true)
            setName(value)
          }}
          placeholder={t('settings.mcp.serverNamePlaceholder', "e.g. 'github'")}
        />
      </ObsidianSetting>

      <div className="setting-item smtcmp-settings-textarea-header smtcmp-mcp-parameters-header">
        <div className="setting-item-info">
          <div className="smtcmp-mcp-parameters-title-row">
            <div className="setting-item-name">
              {t('settings.mcp.parametersField', 'Parameters')}
            </div>
            <Tooltip.Provider delayDuration={0} skipDelayDuration={0}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    className="smtcmp-mcp-parameters-info-icon"
                    type="button"
                  >
                    <Info size={16} />
                    <span className="smtcmp-mcp-sr-only">
                      {t('settings.mcp.parametersFormatHelp', 'Format help')}
                    </span>
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="smtcmp-tooltip-content smtcmp-tooltip-content--wide"
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    collisionPadding={12}
                  >
                    <div className="smtcmp-mcp-parameters-tooltip">
                      <div className="smtcmp-mcp-parameters-tooltip-title">
                        {t(
                          'settings.mcp.parametersTooltipTitle',
                          'Format examples',
                        )}
                      </div>

                      <div className="smtcmp-mcp-parameters-tooltip-line">
                        <span className="smtcmp-mcp-parameters-tooltip-keyword">
                          {t(
                            'settings.mcp.parametersTooltipPreferred',
                            'Preferred',
                          )}
                        </span>
                        {' stdio: {"transport":"stdio","command":"npx",...}'}
                      </div>

                      <div className="smtcmp-mcp-parameters-tooltip-line">
                        <span className="smtcmp-mcp-parameters-tooltip-keyword">
                          {t(
                            'settings.mcp.parametersTooltipPreferred',
                            'Preferred',
                          )}
                        </span>
                        {
                          ' http/sse/ws: {"transport":"http|sse|ws","url":"..."}'
                        }
                      </div>

                      <div className="smtcmp-mcp-parameters-tooltip-line">
                        <span className="smtcmp-mcp-parameters-tooltip-keyword">
                          {t(
                            'settings.mcp.parametersTooltipCompatible',
                            'Compatible',
                          )}
                        </span>
                        {' {"mcpServers":{"name":{...}}}'}
                      </div>

                      <div className="smtcmp-mcp-parameters-tooltip-line">
                        <span className="smtcmp-mcp-parameters-tooltip-keyword">
                          {t(
                            'settings.mcp.parametersTooltipCompatible',
                            'Compatible',
                          )}
                        </span>
                        {' {"id":"name","parameters":{...}}'}
                      </div>

                      <div className="smtcmp-mcp-parameters-tooltip-tip">
                        {t(
                          'settings.mcp.parametersTooltipTip',
                          'Tip: if mcpServers contains one server, Name will auto-fill.',
                        )}
                      </div>
                    </div>
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </div>
          <div className="setting-item-description">
            {t(
              'settings.mcp.parametersFieldDescShort',
              'JSON config for the MCP server. Supports stdio, http, sse, ws transports.',
            )}
          </div>
        </div>
      </div>
      <TextareaAutosize
        value={parameters}
        placeholder={PARAMETERS_PLACEHOLDER}
        onChange={(e) => setParameters(e.target.value)}
        className="smtcmp-mcp-server-modal-textarea"
        maxRows={20}
        minRows={PARAMETERS_PLACEHOLDER.split('\n').length}
      />
      {validationError !== null ? (
        <div className="smtcmp-mcp-server-modal-validation smtcmp-mcp-server-modal-validation--error">
          {validationError}
        </div>
      ) : (
        <div className="smtcmp-mcp-server-modal-validation smtcmp-mcp-server-modal-validation--success">
          {t('settings.mcp.validParameters', 'Valid parameters')}
        </div>
      )}

      <ObsidianSetting>
        <ObsidianButton
          text={t('common.save', 'Save')}
          onClick={() => void handleSubmit()}
          cta
        />
        <ObsidianButton text={t('common.cancel', 'Cancel')} onClick={onClose} />
      </ObsidianSetting>
    </>
  )
}
