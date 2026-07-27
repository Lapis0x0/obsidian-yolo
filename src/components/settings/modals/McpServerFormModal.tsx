import * as Tooltip from '@radix-ui/react-tooltip'
import { Braces, Info, KeyRound, ListChecks } from 'lucide-react'
import { App, Notice } from 'obsidian'
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import * as z from 'zod'

import { useLanguage } from '../../../contexts/language-context'
import { renameAssistantToolPreferencesServer } from '../../../core/agent/tool-preferences'
import { validateServerName } from '../../../core/mcp/tool-name-utils'
import YoloPlugin from '../../../main'
import {
  McpServerParameters,
  getMcpServerNamesFromInput,
  mcpServerParametersSchema,
  normalizeMcpServerParameters,
} from '../../../types/mcp.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'
import { ModeSegmentedControl } from '../common/ModeSegmentedControl'

type McpServerFormComponentProps = {
  plugin: YoloPlugin
  serverId?: string
}

type EditorMode = 'form' | 'json'
type McpTransport = McpServerParameters['transport']
type McpAuthMode = 'oauth' | 'none' | 'headers'

type KeyValueEntry = {
  id: string
  key: string
  value: string
}

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

const recordToEntries = (
  record: Record<string, string> | undefined,
  prefix: string,
): KeyValueEntry[] =>
  Object.entries(record ?? {}).map(([key, value], index) => ({
    id: `${prefix}-${index}`,
    key,
    value,
  }))

const entriesToRecord = (
  entries: KeyValueEntry[],
): Record<string, string> | undefined => {
  const pairs = entries
    .map((entry) => [entry.key.trim(), entry.value] as const)
    .filter(([key]) => key.length > 0)
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined
}

const formatZodError = (error: z.ZodError): string =>
  error.errors
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
      return `${path}${issue.message}`
    })
    .join('\n')

export class AddMcpServerModal extends ReactModal<McpServerFormComponentProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: McpServerFormComponent,
      props: { plugin },
      options: { className: 'yolo-mcp-server-form-modal' },
      plugin,
    })
  }
}

export class EditMcpServerModal extends ReactModal<McpServerFormComponentProps> {
  constructor(app: App, plugin: YoloPlugin, editServerId: string) {
    super({
      app,
      Component: McpServerFormComponent,
      props: { plugin, serverId: editServerId },
      options: { className: 'yolo-mcp-server-form-modal' },
      plugin,
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
  const initialParameters: McpServerParameters = existingServer?.parameters ?? {
    transport: 'http',
    url: '',
  }

  const [mode, setMode] = useState<EditorMode>('form')
  const [name, setName] = useState(existingServer?.id ?? '')
  const [isNameManuallyEdited, setIsNameManuallyEdited] = useState(
    existingServer !== undefined,
  )
  const [parameters, setParameters] = useState(
    existingServer ? JSON.stringify(existingServer.parameters, null, 2) : '',
  )
  const [validationError, setValidationError] = useState<string | null>(null)
  const [transport, setTransport] = useState<McpTransport>(
    initialParameters.transport,
  )
  const [authMode, setAuthMode] = useState<McpAuthMode>(() => {
    if (
      (initialParameters.transport === 'http' ||
        initialParameters.transport === 'sse') &&
      initialParameters.headers
    ) {
      return 'headers'
    }
    return existingServer ? 'none' : 'oauth'
  })
  const [url, setUrl] = useState(
    initialParameters.transport === 'http' ||
      initialParameters.transport === 'sse' ||
      initialParameters.transport === 'ws'
      ? initialParameters.url
      : '',
  )
  const [command, setCommand] = useState(
    initialParameters.transport === 'stdio' ? initialParameters.command : '',
  )
  const [args, setArgs] = useState(
    initialParameters.transport === 'stdio'
      ? (initialParameters.args ?? []).join('\n')
      : '',
  )
  const [cwd, setCwd] = useState(
    initialParameters.transport === 'stdio'
      ? (initialParameters.cwd ?? '')
      : '',
  )
  const [headers, setHeaders] = useState<KeyValueEntry[]>(
    initialParameters.transport === 'http' ||
      initialParameters.transport === 'sse'
      ? recordToEntries(initialParameters.headers, 'header')
      : [],
  )
  const [environment, setEnvironment] = useState<KeyValueEntry[]>(
    initialParameters.transport === 'stdio'
      ? recordToEntries(initialParameters.env, 'env')
      : [],
  )
  const entryIdRef = useRef(0)
  const formJsonSnapshotRef = useRef<string | null>(null)

  const createEntry = (prefix: string): KeyValueEntry => {
    entryIdRef.current += 1
    return { id: `${prefix}-${entryIdRef.current}`, key: '', value: '' }
  }

  const getFormParameters = useCallback((): unknown => {
    if (transport === 'stdio') {
      const parsedArgs = args
        .split('\n')
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0)
      const env = entriesToRecord(environment)
      return {
        transport,
        command: command.trim(),
        ...(parsedArgs.length > 0 ? { args: parsedArgs } : {}),
        ...(cwd.trim().length > 0 ? { cwd: cwd.trim() } : {}),
        ...(env ? { env } : {}),
      }
    }

    if (transport === 'ws') {
      return { transport, url: url.trim() }
    }

    const normalizedHeaders =
      authMode === 'headers' ? entriesToRecord(headers) : undefined
    return {
      transport,
      url: url.trim(),
      ...(normalizedHeaders ? { headers: normalizedHeaders } : {}),
    }
  }, [args, authMode, command, cwd, environment, headers, transport, url])

  const applyParametersToForm = useCallback(
    (nextParameters: McpServerParameters) => {
      setTransport(nextParameters.transport)
      if (
        nextParameters.transport === 'http' ||
        nextParameters.transport === 'sse' ||
        nextParameters.transport === 'ws'
      ) {
        setUrl(nextParameters.url)
      }
      if (
        nextParameters.transport === 'http' ||
        nextParameters.transport === 'sse'
      ) {
        setHeaders(recordToEntries(nextParameters.headers, 'synced-header'))
      }
      if (nextParameters.transport === 'stdio') {
        setCommand(nextParameters.command)
        setArgs((nextParameters.args ?? []).join('\n'))
        setCwd(nextParameters.cwd ?? '')
        setEnvironment(recordToEntries(nextParameters.env, 'synced-env'))
      }
    },
    [],
  )

  const handleModeChange = (nextMode: EditorMode) => {
    if (nextMode === mode) return

    if (nextMode === 'json') {
      const nextParameters = JSON.stringify(getFormParameters(), null, 2)
      formJsonSnapshotRef.current = nextParameters
      setParameters(nextParameters)
      setMode(nextMode)
      return
    }

    if (parameters === formJsonSnapshotRef.current) {
      setMode(nextMode)
      return
    }

    try {
      const nextParameters = normalizeMcpServerParameters({
        value: JSON.parse(parameters),
        serverName: name.trim(),
      })
      applyParametersToForm(nextParameters)
      setMode(nextMode)
    } catch (error) {
      const message =
        error instanceof SyntaxError
          ? t('settings.mcp.invalidJsonFormat', 'Invalid JSON format')
          : error instanceof z.ZodError
            ? formatZodError(error)
            : error instanceof Error
              ? error.message
              : t('settings.mcp.invalidParameters', 'Invalid parameters')
      setValidationError(message)
      new Notice(message)
    }
  }

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

      let parsedParameters: unknown
      if (mode === 'form') {
        if (
          (transport === 'http' || transport === 'sse') &&
          authMode === 'oauth'
        ) {
          throw new Error(
            t(
              'settings.mcp.oauthUnavailable',
              'OAuth connection is not available yet. Choose no authentication or custom headers to save this server now.',
            ),
          )
        }
        parsedParameters = getFormParameters()
      } else {
        if (parameters.trim().length === 0) {
          throw new Error(
            t('settings.mcp.parametersRequired', 'Parameters are required'),
          )
        }
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
      }

      const validatedParameters = normalizeMcpServerParameters({
        value: parsedParameters,
        serverName,
      })
      const isRename = !!existingServer && existingServer.id !== serverName
      const nextAssistants = isRename
        ? plugin.settings.assistants.map((assistant) =>
            renameAssistantToolPreferencesServer(
              assistant,
              existingServer.id,
              serverName,
            ),
          )
        : plugin.settings.assistants

      await plugin.setSettings({
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
        assistants: nextAssistants,
      })
      onClose()
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? formatZodError(error)
          : error instanceof Error
            ? error.message
            : t('settings.mcp.failedToAddServer', 'Failed to add MCP server.')
      new Notice(message)
    }
  }

  const validateParameters = useCallback(
    (parametersValue: string) => {
      try {
        if (parametersValue.length === 0) {
          setValidationError(
            t('settings.mcp.parametersRequired', 'Parameters are required'),
          )
          return
        }
        const parsedParameters = JSON.parse(parametersValue)
        mcpServerParametersSchema.parse(
          normalizeMcpServerParameters({
            value: parsedParameters,
            serverName: name.trim(),
          }),
        )
        setValidationError(null)
      } catch (error) {
        if (error instanceof SyntaxError) {
          setValidationError(
            t('settings.mcp.invalidJsonFormat', 'Invalid JSON format'),
          )
        } else if (error instanceof z.ZodError) {
          setValidationError(formatZodError(error))
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
    if (serverId !== undefined || isNameManuallyEdited || mode !== 'json') {
      return
    }

    try {
      const parsedParameters = JSON.parse(parameters)
      const serverNames = getMcpServerNamesFromInput(parsedParameters)
      if (serverNames.length === 1 && name !== serverNames[0]) {
        setName(serverNames[0])
      }
    } catch {
      // JSON validation displays parse errors.
    }
  }, [isNameManuallyEdited, mode, name, parameters, serverId])

  const modeOptions = [
    {
      value: 'form' as const,
      label: t('settings.mcp.modeForm', 'Form'),
      Icon: ListChecks,
    },
    {
      value: 'json' as const,
      label: t('settings.mcp.modeJson', 'JSON'),
      Icon: Braces,
    },
  ]

  return (
    <div className="yolo-mcp-server-modal-form">
      <div className="yolo-mcp-server-modal-header">
        <h2 className="yolo-mcp-server-modal-title">
          {existingServer
            ? t('settings.mcp.editServerTitle', 'Edit server')
            : t('settings.mcp.addServerTitle', 'Add server')}
        </h2>
        <ModeSegmentedControl<EditorMode>
          value={mode}
          options={modeOptions}
          onChange={handleModeChange}
          ariaLabel={t('settings.mcp.editorMode', 'Configuration editor')}
        />
      </div>

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
          onChange={(value) => {
            setIsNameManuallyEdited(true)
            setName(value)
          }}
          placeholder={t('settings.mcp.serverNamePlaceholder', "e.g. 'github'")}
        />
      </ObsidianSetting>

      {mode === 'form' ? (
        <McpGuidedForm
          t={t}
          transport={transport}
          setTransport={setTransport}
          authMode={authMode}
          setAuthMode={setAuthMode}
          url={url}
          setUrl={setUrl}
          command={command}
          setCommand={setCommand}
          args={args}
          setArgs={setArgs}
          cwd={cwd}
          setCwd={setCwd}
          headers={headers}
          setHeaders={setHeaders}
          environment={environment}
          setEnvironment={setEnvironment}
          createEntry={createEntry}
        />
      ) : (
        <McpJsonEditor
          t={t}
          parameters={parameters}
          setParameters={setParameters}
          validationError={validationError}
        />
      )}

      <ObsidianSetting>
        <ObsidianButton
          text={t('common.save', 'Save')}
          onClick={() => void handleSubmit()}
          cta
        />
        <ObsidianButton text={t('common.cancel', 'Cancel')} onClick={onClose} />
      </ObsidianSetting>
    </div>
  )
}

type McpGuidedFormProps = {
  t: ReturnType<typeof useLanguage>['t']
  transport: McpTransport
  setTransport: (transport: McpTransport) => void
  authMode: McpAuthMode
  setAuthMode: (authMode: McpAuthMode) => void
  url: string
  setUrl: (url: string) => void
  command: string
  setCommand: (command: string) => void
  args: string
  setArgs: (args: string) => void
  cwd: string
  setCwd: (cwd: string) => void
  headers: KeyValueEntry[]
  setHeaders: Dispatch<SetStateAction<KeyValueEntry[]>>
  environment: KeyValueEntry[]
  setEnvironment: Dispatch<SetStateAction<KeyValueEntry[]>>
  createEntry: (prefix: string) => KeyValueEntry
}

function McpGuidedForm({
  t,
  transport,
  setTransport,
  authMode,
  setAuthMode,
  url,
  setUrl,
  command,
  setCommand,
  args,
  setArgs,
  cwd,
  setCwd,
  headers,
  setHeaders,
  environment,
  setEnvironment,
  createEntry,
}: McpGuidedFormProps) {
  return (
    <div className="yolo-mcp-guided-form">
      <ObsidianSetting
        name={t('settings.mcp.transportField', 'Connection type')}
        desc={t(
          'settings.mcp.transportFieldDesc',
          'Choose how YOLO connects to this server.',
        )}
        required
      >
        <ObsidianDropdown
          value={transport}
          groupedOptions={[
            {
              label: t('settings.mcp.remoteTransports', 'Remote'),
              options: [
                {
                  value: 'http',
                  label: t('settings.mcp.transportHttp', 'Streamable HTTP'),
                },
                {
                  value: 'sse',
                  label: t('settings.mcp.transportSse', 'SSE'),
                },
                {
                  value: 'ws',
                  label: t('settings.mcp.transportWs', 'WebSocket'),
                },
              ],
            },
            {
              label: t('settings.mcp.localTransports', 'Local'),
              options: [
                {
                  value: 'stdio',
                  label: t('settings.mcp.transportStdio', 'stdio'),
                },
              ],
            },
          ]}
          onChange={(value) => setTransport(value as McpTransport)}
        />
      </ObsidianSetting>

      {transport === 'stdio' ? (
        <>
          <ObsidianSetting
            name={t('settings.mcp.commandField', 'Command')}
            desc={t(
              'settings.mcp.commandFieldDesc',
              'The executable used to start the MCP server.',
            )}
            required
          >
            <ObsidianTextInput
              value={command}
              onChange={setCommand}
              placeholder="npx"
            />
          </ObsidianSetting>
          <div className="yolo-mcp-field-block">
            <div className="yolo-mcp-field-label">
              {t('settings.mcp.argumentsField', 'Arguments')}
            </div>
            <div className="yolo-mcp-field-desc">
              {t(
                'settings.mcp.argumentsFieldDesc',
                'Enter one command argument per line.',
              )}
            </div>
            <TextareaAutosize
              value={args}
              onChange={(event) => setArgs(event.currentTarget.value)}
              placeholder={'-y\n@modelcontextprotocol/server-github'}
              className="yolo-mcp-form-textarea"
              minRows={3}
              maxRows={8}
            />
          </div>
          <ObsidianSetting
            name={t('settings.mcp.cwdField', 'Working directory')}
            desc={t(
              'settings.mcp.cwdFieldDesc',
              'Optional directory in which to start the command.',
            )}
          >
            <ObsidianTextInput
              value={cwd}
              onChange={setCwd}
              placeholder="/path/to/project"
            />
          </ObsidianSetting>
          <KeyValueFields
            t={t}
            title={t('settings.mcp.environmentField', 'Environment variables')}
            description={t(
              'settings.mcp.environmentFieldDesc',
              'Values passed to the local server process.',
            )}
            addLabel={t('settings.mcp.addEnvironmentVariable', 'Add variable')}
            keyPlaceholder={t(
              'settings.mcp.environmentKeyPlaceholder',
              'Variable name',
            )}
            valuePlaceholder={t(
              'settings.mcp.environmentValuePlaceholder',
              'Value',
            )}
            entries={environment}
            setEntries={setEnvironment}
            createEntry={() => createEntry('env')}
          />
        </>
      ) : (
        <>
          <ObsidianSetting
            name={t('settings.mcp.urlField', 'Server URL')}
            desc={t(
              'settings.mcp.urlFieldDesc',
              'The URL provided by the MCP server.',
            )}
            required
          >
            <ObsidianTextInput
              value={url}
              onChange={setUrl}
              placeholder={
                transport === 'ws'
                  ? 'wss://example.com/mcp'
                  : 'https://example.com/mcp'
              }
            />
          </ObsidianSetting>
          {(transport === 'http' || transport === 'sse') && (
            <>
              <ObsidianSetting
                name={t('settings.mcp.authenticationField', 'Authentication')}
                desc={t(
                  'settings.mcp.authenticationFieldDesc',
                  'Choose how this server verifies your identity.',
                )}
              >
                <ObsidianDropdown
                  value={authMode}
                  options={{
                    oauth: t('settings.mcp.authenticationOAuth', 'OAuth'),
                    none: t(
                      'settings.mcp.authenticationNone',
                      'No authentication',
                    ),
                    headers: t(
                      'settings.mcp.authenticationHeaders',
                      'Custom headers',
                    ),
                  }}
                  onChange={(value) => setAuthMode(value as McpAuthMode)}
                />
              </ObsidianSetting>

              {authMode === 'oauth' ? (
                <div className="yolo-mcp-oauth-card">
                  <div className="yolo-mcp-oauth-icon" aria-hidden="true">
                    <KeyRound size={18} />
                  </div>
                  <div className="yolo-mcp-oauth-content">
                    <div className="yolo-mcp-oauth-title-row">
                      <div className="yolo-mcp-oauth-title">
                        {t('settings.mcp.oauthTitle', 'Connect with OAuth')}
                      </div>
                      <span className="yolo-mcp-oauth-badge">
                        {t('settings.mcp.oauthComingSoon', 'Coming soon')}
                      </span>
                    </div>
                    <div className="yolo-mcp-oauth-desc">
                      {t(
                        'settings.mcp.oauthDesc',
                        'YOLO will open your browser so you can authorize this MCP server securely.',
                      )}
                    </div>
                    <div className="yolo-mcp-oauth-actions">
                      <span className="yolo-mcp-oauth-status">
                        <span
                          className="yolo-mcp-oauth-status-dot"
                          aria-hidden="true"
                        />
                        {t('settings.mcp.oauthNotConnected', 'Not connected')}
                      </span>
                      <ObsidianButton
                        text={t('settings.mcp.oauthConnect', 'Connect')}
                        onClick={() => undefined}
                        disabled
                      />
                    </div>
                  </div>
                </div>
              ) : authMode === 'headers' ? (
                <KeyValueFields
                  t={t}
                  title={t('settings.mcp.headersField', 'Headers')}
                  description={t(
                    'settings.mcp.headersFieldDesc',
                    'Optional headers for servers that use manual authentication.',
                  )}
                  addLabel={t('settings.mcp.addHeader', 'Add header')}
                  keyPlaceholder={t(
                    'settings.mcp.headerKeyPlaceholder',
                    'Header name',
                  )}
                  valuePlaceholder={t(
                    'settings.mcp.headerValuePlaceholder',
                    'Header value',
                  )}
                  entries={headers}
                  setEntries={setHeaders}
                  createEntry={() => createEntry('header')}
                />
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  )
}

type KeyValueFieldsProps = {
  t: ReturnType<typeof useLanguage>['t']
  title: string
  description: string
  addLabel: string
  keyPlaceholder: string
  valuePlaceholder: string
  entries: KeyValueEntry[]
  setEntries: Dispatch<SetStateAction<KeyValueEntry[]>>
  createEntry: () => KeyValueEntry
}

function KeyValueFields({
  t,
  title,
  description,
  addLabel,
  keyPlaceholder,
  valuePlaceholder,
  entries,
  setEntries,
  createEntry,
}: KeyValueFieldsProps) {
  return (
    <>
      <ObsidianSetting name={title} desc={description}>
        <ObsidianButton
          text={addLabel}
          onClick={() => setEntries((current) => [...current, createEntry()])}
        />
      </ObsidianSetting>
      {entries.map((entry) => (
        <ObsidianSetting
          key={entry.id}
          className="yolo-settings-kv-entry yolo-settings-kv-entry--inline yolo-mcp-kv-entry"
        >
          <ObsidianTextInput
            value={entry.key}
            placeholder={keyPlaceholder}
            onChange={(value) =>
              setEntries((current) =>
                current.map((candidate) =>
                  candidate.id === entry.id
                    ? { ...candidate, key: value }
                    : candidate,
                ),
              )
            }
          />
          <ObsidianTextInput
            value={entry.value}
            placeholder={valuePlaceholder}
            onChange={(value) =>
              setEntries((current) =>
                current.map((candidate) =>
                  candidate.id === entry.id
                    ? { ...candidate, value }
                    : candidate,
                ),
              )
            }
          />
          <ObsidianButton
            text={t('common.remove', 'Remove')}
            onClick={() =>
              setEntries((current) =>
                current.filter((candidate) => candidate.id !== entry.id),
              )
            }
          />
        </ObsidianSetting>
      ))}
    </>
  )
}

type McpJsonEditorProps = {
  t: ReturnType<typeof useLanguage>['t']
  parameters: string
  setParameters: (parameters: string) => void
  validationError: string | null
}

function McpJsonEditor({
  t,
  parameters,
  setParameters,
  validationError,
}: McpJsonEditorProps) {
  return (
    <div className="yolo-mcp-json-editor">
      <div className="setting-item yolo-settings-textarea-header yolo-mcp-parameters-header">
        <div className="setting-item-info">
          <div className="yolo-mcp-parameters-title-row">
            <div className="setting-item-name">
              {t('settings.mcp.parametersField', 'Parameters')}
            </div>
            <Tooltip.Provider delayDuration={0} skipDelayDuration={0}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    className="yolo-mcp-parameters-info-icon"
                    type="button"
                  >
                    <Info size={16} />
                    <span className="yolo-mcp-sr-only">
                      {t('settings.mcp.parametersFormatHelp', 'Format help')}
                    </span>
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="yolo-tooltip-content yolo-tooltip-content--wide"
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    collisionPadding={12}
                  >
                    <div className="yolo-mcp-parameters-tooltip">
                      <div className="yolo-mcp-parameters-tooltip-title">
                        {t(
                          'settings.mcp.parametersTooltipTitle',
                          'Format examples',
                        )}
                      </div>
                      <div className="yolo-mcp-parameters-tooltip-line">
                        <span className="yolo-mcp-parameters-tooltip-keyword">
                          {t(
                            'settings.mcp.parametersTooltipPreferred',
                            'Preferred',
                          )}
                        </span>
                        {' stdio: {"transport":"stdio","command":"npx",...}'}
                      </div>
                      <div className="yolo-mcp-parameters-tooltip-line">
                        <span className="yolo-mcp-parameters-tooltip-keyword">
                          {t(
                            'settings.mcp.parametersTooltipPreferred',
                            'Preferred',
                          )}
                        </span>
                        {
                          ' http/sse/ws: {"transport":"http|sse|ws","url":"..."}'
                        }
                      </div>
                      <div className="yolo-mcp-parameters-tooltip-line">
                        <span className="yolo-mcp-parameters-tooltip-keyword">
                          {t(
                            'settings.mcp.parametersTooltipCompatible',
                            'Compatible',
                          )}
                        </span>
                        {' {"mcpServers":{"name":{...}}}'}
                      </div>
                      <div className="yolo-mcp-parameters-tooltip-line">
                        <span className="yolo-mcp-parameters-tooltip-keyword">
                          {t(
                            'settings.mcp.parametersTooltipCompatible',
                            'Compatible',
                          )}
                        </span>
                        {' {"id":"name","parameters":{...}}'}
                      </div>
                      <div className="yolo-mcp-parameters-tooltip-tip">
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
        onChange={(event) => setParameters(event.currentTarget.value)}
        className="yolo-mcp-server-modal-textarea"
        maxRows={20}
        minRows={PARAMETERS_PLACEHOLDER.split('\n').length}
      />
      {validationError !== null ? (
        <div className="yolo-mcp-server-modal-validation yolo-mcp-server-modal-validation--error">
          {validationError}
        </div>
      ) : (
        <div className="yolo-mcp-server-modal-validation yolo-mcp-server-modal-validation--success">
          {t('settings.mcp.validParameters', 'Valid parameters')}
        </div>
      )}
    </div>
  )
}
