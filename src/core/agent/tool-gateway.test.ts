import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
  createPartialToolCallArguments,
} from '../../types/tool-call.types'
import { McpManager } from '../mcp/mcpManager'

import { AgentToolGateway } from './tool-gateway'

describe('AgentToolGateway', () => {
  const emptyArgs = createCompleteToolCallArguments({ value: {} })

  it('auto executes tools with full access', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
        },
      },
      toolServerPreferences: {
        server: { approvalMode: 'full_access' },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'server__tool_a',
      conversationId: 'conv-1',
      requestArgs: {},
      requireAutoExecution: true,
    })
  })

  it('ignores per-tool full access for third-party MCP tools without server approval', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.PendingApproval,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'server__tool_a',
      conversationId: 'conv-1',
      requestArgs: {},
      requireAutoExecution: false,
    })
  })

  it('loads enabled tool contracts through load_tool_schemas', async () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      listAvailableTools: jest.fn().mockResolvedValue([
        {
          name: 'yolo_local__load_tool_schemas',
          description: 'Search tools',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'server__tool_a',
          description: 'Tool A',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
          },
        },
        {
          name: 'server__tool_b',
          description: 'Tool B',
          inputSchema: { type: 'object', properties: {} },
        },
      ]),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__load_tool_schemas', 'server__tool_a'],
      toolPreferences: {
        yolo_local__load_tool_schemas: {
          enabled: true,
          approvalMode: 'full_access',
        },
        server__tool_a: {
          enabled: true,
        },
      },
      toolServerPreferences: { server: { disclosureMode: 'on_demand' } },
    })

    const toolMessage = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__load_tool_schemas',
          arguments: createCompleteToolCallArguments({
            value: { servers: ['server'] },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    const executed = await gateway.executeAutoToolCalls({
      toolMessage,
      conversationId: 'conv-1',
    })
    const response = executed.toolCalls[0]?.response
    expect(response?.status).toBe(ToolCallResponseStatus.Success)
    if (response?.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(response.data.text) as {
      loadedToolNames: string[]
      matches: Array<{ name: string }>
    }
    expect(payload.loadedToolNames).toEqual(['server__tool_a'])
    expect(payload.matches.map((match) => match.name)).toEqual([
      'server__tool_a',
    ])
  })

  it('keeps tools pending when approval is required', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.PendingApproval,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'server__tool_a',
      conversationId: 'conv-1',
      requestArgs: {},
      requireAutoExecution: false,
    })
  })

  describe('non-Agent modes supply no preference maps', () => {
    // `resolveChatModeRuntime` deliberately passes `toolPreferences` and
    // `builtinCapabilityPreferences` as undefined outside Agent mode, so
    // `allowedToolNames` is the only grant the gateway gets. Re-deriving
    // built-in enablement there resolved each tool against its capability's
    // `defaultEnabled` instead — silently rejecting every Ask / Quick Ask
    // call to `js_sandbox`, both context tools, and `subagent_delegation`,
    // all of which are `defaultEnabled: false` yet advertised to the model
    // by `selectAllowedTools` once the user enables them.
    const askModeGateway = (allowedToolNames: string[]) =>
      new AgentToolGateway(
        {
          isToolExecutionAllowed: jest.fn().mockReturnValue(true),
          getJsSandboxSettings: jest.fn().mockReturnValue({}),
        } as unknown as McpManager,
        { allowedToolNames },
      )

    const call = (gateway: AgentToolGateway, name: string) =>
      gateway.createToolMessage({
        toolCallRequests: [{ id: 'tool-1', name, arguments: emptyArgs }],
        conversationId: 'conv-1',
      }).toolCalls[0]?.response

    it.each([
      'yolo_local__js_eval',
      'yolo_local__context_compact',
      'yolo_local__context_prune_tool_results',
      'yolo_local__delegate_subagent',
    ])('honors the grant for default-off capability tool %s', (name) => {
      expect(call(askModeGateway([name]), name)?.status).not.toBe(
        ToolCallResponseStatus.Rejected,
      )
    })

    it('still rejects a tool the grant does not contain', () => {
      const response = call(
        askModeGateway(['yolo_local__js_eval']),
        'yolo_local__fs_write',
      )
      expect(response?.status).toBe(ToolCallResponseStatus.Rejected)
    })
  })

  it('rejects malformed local write arguments before execution', async () => {
    const callTool = jest.fn()
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      callTool,
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_write'],
      builtinCapabilityPreferences: {
        file_editing: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_write',
          arguments: createPartialToolCallArguments(
            '{"path":"note.md","content":',
          ),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response).toEqual({
      status: ToolCallResponseStatus.Error,
      error: expect.stringContaining('Tool argument parsing failed'),
    })
    const response = message.toolCalls[0]?.response
    if (response?.status !== ToolCallResponseStatus.Error) {
      throw new Error('expected error')
    }
    expect(response.error).toContain('Provided parameter names: content, path')
    expect(response.error).toContain('Required parameter names: path, content')
    expect(response.error).toContain('Raw args length:')
    expect(response.error).toContain('finishReason:')

    const executed = await gateway.executeAutoToolCalls({
      toolMessage: message,
      conversationId: 'conv-1',
    })

    expect(executed.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Error,
    )
    expect(callTool).not.toHaveBeenCalled()
  })

  it('repairs incomplete local write JSON before execution', async () => {
    const callTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'ok' },
    })
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      callTool,
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_write'],
      builtinCapabilityPreferences: {
        file_editing: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_write',
          arguments: createPartialToolCallArguments(
            '{"path":"note.md","content":"hello"',
          ),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
    expect(message.toolCalls[0]?.request.arguments?.kind).toBe('complete')

    const executed = await gateway.executeAutoToolCalls({
      toolMessage: message,
      conversationId: 'conv-1',
    })

    expect(executed.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Success,
    )
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { path: 'note.md', content: 'hello' },
      }),
    )
  })

  it('rejects local write repair that would close an unterminated content string', async () => {
    const callTool = jest.fn()
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      callTool,
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_write'],
      builtinCapabilityPreferences: {
        file_editing: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_write',
          arguments: createPartialToolCallArguments(
            '{"path":"note.md","content":"half written',
          ),
        },
      ],
      conversationId: 'conv-1',
    })

    const response = message.toolCalls[0]?.response
    expect(response?.status).toBe(ToolCallResponseStatus.Error)
    if (response?.status !== ToolCallResponseStatus.Error) {
      throw new Error('expected error')
    }
    expect(response.error).toContain('unterminated string')
    expect(response.error).toContain('file content was truncated')

    const executed = await gateway.executeAutoToolCalls({
      toolMessage: message,
      conversationId: 'conv-1',
    })

    expect(executed.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Error,
    )
    expect(callTool).not.toHaveBeenCalled()
  })

  it('reports missing fs_edit locator fields before execution', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_edit'],
      builtinCapabilityPreferences: {
        file_editing: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: { path: 'note.md', newText: 'x' },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    const response = message.toolCalls[0]?.response
    expect(response?.status).toBe(ToolCallResponseStatus.Error)
    if (response?.status !== ToolCallResponseStatus.Error) {
      throw new Error('expected error')
    }
    expect(response.error).toContain('Missing edit locator.')
    expect(response.error).toContain(
      'Always required parameter names: path, newText',
    )
    expect(response.error).toContain(
      'Edit locator requirement: provide exactly one of oldText, or startLine together with endLine.',
    )
    expect(response.error).toContain('"path":"note.md"')
  })

  it('auto executes read-only terminal commands even when terminal_command requires approval', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest
        .fn()
        .mockImplementation(({ requireAutoExecution }) => requireAutoExecution),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__terminal_command'],
      builtinCapabilityPreferences: {
        terminal: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { command: 'git status --short | head -20' },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'yolo_local__terminal_command',
      conversationId: 'conv-1',
      requestArgs: { command: 'git status --short | head -20' },
      requireAutoExecution: true,
    })
  })

  it('keeps mutating terminal commands pending for approval', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest
        .fn()
        .mockImplementation(({ requireAutoExecution }) => requireAutoExecution),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__terminal_command'],
      builtinCapabilityPreferences: {
        terminal: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { command: 'echo hello > out.txt' },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.PendingApproval,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'yolo_local__terminal_command',
      conversationId: 'conv-1',
      requestArgs: { command: 'echo hello > out.txt' },
      requireAutoExecution: false,
    })
  })

  it('auto executes the bash tool under the dangerous_only tier (gating happens mid-script, not at dispatch)', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest
        .fn()
        .mockImplementation(({ requireAutoExecution }) => requireAutoExecution),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__bash'],
      builtinCapabilityPreferences: {
        vault_shell: {
          enabled: true,
          approvalMode: 'dangerous_only',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__bash',
          arguments: createCompleteToolCallArguments({
            value: { command: 'rm notes/a.md' },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'yolo_local__bash',
      conversationId: 'conv-1',
      requestArgs: { command: 'rm notes/a.md' },
      requireAutoExecution: true,
    })
  })

  it('keeps the bash tool pending under the require_approval tier (gates the whole call up front)', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest
        .fn()
        .mockImplementation(({ requireAutoExecution }) => requireAutoExecution),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__bash'],
      builtinCapabilityPreferences: {
        vault_shell: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__bash',
          arguments: createCompleteToolCallArguments({
            value: { command: 'ls' },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.PendingApproval,
    )
  })

  it('auto executes require_approval tools when bypassToolApproval is enabled', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      bypassToolApproval: true,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'server__tool_a',
      conversationId: 'conv-1',
      requestArgs: {},
      requireAutoExecution: true,
    })
  })

  it('still rejects blocked terminal commands when bypassToolApproval is enabled', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      bypassToolApproval: true,
      allowedToolNames: ['yolo_local__terminal_command'],
      builtinCapabilityPreferences: {
        terminal: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { command: 'rm -rf test-dir' },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Error,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).not.toHaveBeenCalled()
  })

  it('rejects blocked terminal command prefixes before approval', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__terminal_command'],
      builtinCapabilityPreferences: {
        terminal: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { command: 'rm -rf test-dir' },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Error,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).not.toHaveBeenCalled()
  })

  it('allows blocked terminal defaults to be cleared explicitly', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__terminal_command'],
      blockedCommandPrefixes: [],
      builtinCapabilityPreferences: {
        terminal: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { command: 'rm -rf test-dir' },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
  })

  it('serializes sibling foreground terminal commands on the shared session lane', async () => {
    let activeCalls = 0
    let maxActiveCalls = 0
    const callOrder: string[] = []
    const callTool = jest.fn().mockImplementation(async ({ id }) => {
      activeCalls += 1
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
      callOrder.push(id)
      await new Promise((resolve) => setTimeout(resolve, 5))
      activeCalls -= 1
      return {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: id },
      }
    })
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      callTool,
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__terminal_command'],
      builtinCapabilityPreferences: {
        terminal: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { command: 'echo one' },
          }),
        },
        {
          id: 'tool-2',
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { command: 'echo two' },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    const result = await gateway.executeAutoToolCalls({
      toolMessage: message,
      conversationId: 'conv-1',
    })

    expect(callTool).toHaveBeenCalledTimes(2)
    expect(maxActiveCalls).toBe(1)
    expect(callOrder).toEqual(['tool-1', 'tool-2'])
    expect(result.toolCalls.map((call) => call.response.status)).toEqual([
      ToolCallResponseStatus.Success,
      ToolCallResponseStatus.Success,
    ])
  })

  it('keeps sibling background terminal commands parallel', async () => {
    let activeCalls = 0
    let maxActiveCalls = 0
    const callTool = jest.fn().mockImplementation(async () => {
      activeCalls += 1
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
      await new Promise((resolve) => setTimeout(resolve, 5))
      activeCalls -= 1
      return {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: 'ok' },
      }
    })
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      callTool,
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__terminal_command'],
      builtinCapabilityPreferences: {
        terminal: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { command: 'sleep 1', background: true },
          }),
        },
        {
          id: 'tool-2',
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { command: 'sleep 1', background: true },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    await gateway.executeAutoToolCalls({
      toolMessage: message,
      conversationId: 'conv-1',
    })

    expect(callTool).toHaveBeenCalledTimes(2)
    expect(maxActiveCalls).toBe(2)
  })

  it('allows conversation-level approval to bypass per-tool approval', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
  })

  it('uses the parent approval conversation for subagent child runs', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      isSubagentChildRun: true,
      toolApprovalConversationId: 'parent-conv',
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'subagent-task',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'server__tool_a',
      conversationId: 'parent-conv',
      requestArgs: {},
      requireAutoExecution: false,
    })
  })

  it('routes approval-required subagent child calls to PendingApproval (parent UI)', () => {
    // Subagent approval requests bubble up to the SubagentCard's inline
    // approval block in the parent conversation. See
    // `docs/plans/2026-06-18-subagent-tool-approval-routing.md`.
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      isSubagentChildRun: true,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'subagent-task',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.PendingApproval,
    )
  })

  it('runs fs_edit immediately when approval mode requires review', async () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
      callTool: jest.fn().mockResolvedValue({
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: '{}' },
      }),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_edit'],
      builtinCapabilityPreferences: {
        file_editing: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'note.md',
              oldText: 'before',
              newText: 'after',
            },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )

    await gateway.executeAutoToolCalls({
      toolMessage: message,
      conversationId: 'conv-1',
    })

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const callToolMock = mcpManager.callTool
    expect(callToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'yolo_local__fs_edit',
        args: {
          path: 'note.md',
          oldText: 'before',
          newText: 'after',
        },
        id: 'tool-1',
        conversationId: 'conv-1',
        conversationMessages: undefined,
        roundId: message.id,
        requireReview: true,
        signal: undefined,
      }),
    )
  })

  it('opens fs_edit review for subagent child runs (same as parent flow)', () => {
    // After the approval-routing refactor, subagent fs_edit calls go through
    // the same review (inline diff) path as parent calls when the tool is in
    // require_approval mode. The user's approval target is the SubagentCard.
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      isSubagentChildRun: true,
      allowedToolNames: ['yolo_local__fs_edit'],
      builtinCapabilityPreferences: {
        file_editing: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'note.md',
              oldText: 'before',
              newText: 'after',
            },
          }),
        },
      ],
      conversationId: 'subagent-task',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
  })

  it('rejects tool calls when tools are disabled', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn(),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      toolsEnabled: false,
      allowedToolNames: ['server__tool_a'],
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Rejected,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).not.toHaveBeenCalled()
  })

  it('merges sibling fs_edit calls targeting the same path into one batched invocation', async () => {
    const callTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: '{"tool":"fs_edit"}' },
    })
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      callTool,
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_edit'],
      builtinCapabilityPreferences: {
        file_editing: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'note.md',
              oldText: 'foo',
              newText: 'FOO',
            },
          }),
        },
        {
          id: 'tool-2',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'note.md',
              oldText: 'bar',
              newText: 'BAR',
            },
          }),
        },
        {
          id: 'tool-3',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'other.md',
              oldText: 'tail',
              newText: 'TAIL',
            },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    const result = await gateway.executeAutoToolCalls({
      toolMessage: message,
      conversationId: 'conv-1',
    })

    // Two distinct invocations: one batched for note.md, one for other.md.
    expect(callTool).toHaveBeenCalledTimes(2)
    const noteCall = callTool.mock.calls.find(
      ([args]: [{ args?: { path?: string } }]) => args.args?.path === 'note.md',
    )
    expect(noteCall).toBeDefined()
    expect(noteCall![0].id).toBe('tool-1')
    expect(noteCall![0].args).toEqual({
      path: 'note.md',
      operations: [
        { path: 'note.md', oldText: 'foo', newText: 'FOO' },
        { path: 'note.md', oldText: 'bar', newText: 'BAR' },
      ],
    })

    // All three tool calls resolve to Success.
    expect(result.toolCalls.map((call) => call.response.status)).toEqual([
      ToolCallResponseStatus.Success,
      ToolCallResponseStatus.Success,
      ToolCallResponseStatus.Success,
    ])

    // The leader carries the full response; followers get a batch note.
    const followerResponse = result.toolCalls[1].response
    if (followerResponse.status === ToolCallResponseStatus.Success) {
      expect(followerResponse.data.text).toContain('batched fs_edit')
      expect(followerResponse.data.text).toContain('note.md')
      expect(followerResponse.data.text).toContain('unified review outcome')
      expect(followerResponse.data.text).not.toContain('Applied')
    }
  })

  it('rejects tool calls outside the allowed tool list', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn(),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['server__tool_a'],
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_b', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response).toEqual({
      status: ToolCallResponseStatus.Rejected,
      reason: 'Tool "server__tool_b" is not available in this workspace.',
    })
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).not.toHaveBeenCalled()
  })

  it('explains workspace scope path rejections', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn(),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_edit'],
      workspaceScope: {
        enabled: true,
        include: ['Notes'],
        exclude: [],
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'Private/secret.md',
              oldText: 'x',
              newText: 'y',
            },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response).toEqual({
      status: ToolCallResponseStatus.Rejected,
      reason:
        'Path "Private/secret.md" is outside this agent\'s workspace scope. Do not attempt to bypass this restriction. If the task requires this path, tell the user that it is outside the configured workspace scope.',
    })
  })

  // fs_read is intentionally absent from workspaceScope's PATH_ARGS table
  // (its `paths` entries may be Obsidian wikilinks, not literal vault
  // paths — see workspaceScope.ts). This gateway-level pre-check is
  // therefore a no-op for it; scope is instead enforced per-resolved-file
  // inside fs_read's own read loop (see localFileTools.ts's
  // `case 'fs_read'`, and the "workspace scope final defense" /
  // wikilink-resolution tests in localFileTools.test.ts).
  it('does not reject fs_read at the gateway level even for out-of-scope paths', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_read'],
      workspaceScope: {
        enabled: true,
        include: ['Notes'],
        exclude: [],
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_read',
          arguments: createCompleteToolCallArguments({
            value: { paths: ['Private/secret.md'] },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).not.toBe(
      ToolCallResponseStatus.Rejected,
    )
  })

  describe('on-demand harness', () => {
    const realToolSchema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    } as const

    const mcpManagerWithRealTool = () =>
      ({
        isToolExecutionAllowed: jest.fn().mockReturnValue(true),
        callTool: jest.fn().mockResolvedValue({
          status: ToolCallResponseStatus.Success,
          data: { type: 'text' as const, text: 'ok' },
        }),
        listAvailableTools: jest.fn().mockResolvedValue([
          {
            name: 'server__tool_a',
            description: 'Tool A',
            inputSchema: realToolSchema,
          },
        ]),
        getJsSandboxSettings: jest.fn().mockReturnValue({}),
      }) as unknown as McpManager

    const buildGateway = (mcpManager: McpManager, apiType?: 'gemini') =>
      new AgentToolGateway(mcpManager, {
        allowedToolNames: ['server__tool_a', 'yolo_local__load_tool_schemas'],
        toolPreferences: {
          yolo_local__load_tool_schemas: {
            enabled: true,
            approvalMode: 'full_access',
          },
          server__tool_a: {
            enabled: true,
            approvalMode: 'full_access',
          },
        },
        toolServerPreferences: { server: { disclosureMode: 'on_demand' } },
        apiType,
      })

    it('rejects on-demand tools whose schemas have not been disclosed yet', async () => {
      const mcpManager = mcpManagerWithRealTool()
      const gateway = buildGateway(mcpManager)
      const toolMessage = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-1',
            name: 'server__tool_a',
            arguments: createCompleteToolCallArguments({
              value: { value: 'hello' },
            }),
          },
        ],
        conversationId: 'conv-1',
      })
      const result = await gateway.executeAutoToolCalls({
        toolMessage,
        conversationId: 'conv-1',
        conversationMessages: [],
      })
      const response = result.toolCalls[0]?.response
      expect(response?.status).toBe(ToolCallResponseStatus.Error)
      if (response?.status === ToolCallResponseStatus.Error) {
        expect(response.error).toContain('load_tool_schemas')
      }
    })

    it('does not require disclosure for lightweight servers in auto mode', async () => {
      const mcpManager = mcpManagerWithRealTool()
      const gateway = new AgentToolGateway(mcpManager, {
        allowedToolNames: ['server__tool_a'],
        toolPreferences: {
          server__tool_a: {
            enabled: true,
            approvalMode: 'full_access',
          },
        },
      })
      const toolMessage = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-1',
            name: 'server__tool_a',
            arguments: createCompleteToolCallArguments({
              value: { value: 'hello' },
            }),
          },
        ],
        conversationId: 'conv-1',
      })
      const result = await gateway.executeAutoToolCalls({
        toolMessage,
        conversationId: 'conv-1',
        conversationMessages: [],
      })
      const response = result.toolCalls[0]?.response
      expect(response?.status).toBe(ToolCallResponseStatus.Success)
    })

    it('rejects on-demand tool calls with arguments that violate the real schema', async () => {
      const mcpManager = mcpManagerWithRealTool()
      const gateway = buildGateway(mcpManager)
      const disclosureMessage = {
        role: 'tool' as const,
        id: 'tool-load',
        toolCalls: [
          {
            request: {
              id: 'call-search',
              name: 'yolo_local__load_tool_schemas',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success as const,
              data: {
                type: 'text' as const,
                text: JSON.stringify({
                  tool: 'load_tool_schemas',
                  loadedToolNames: ['server__tool_a'],
                  matches: [
                    {
                      name: 'server__tool_a',
                      description: 'Tool A',
                      parameters: realToolSchema,
                    },
                  ],
                }),
              },
            },
          },
        ],
      }
      const toolMessage = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-bad',
            name: 'server__tool_a',
            arguments: createCompleteToolCallArguments({
              value: { value: 42 },
            }),
          },
        ],
        conversationId: 'conv-1',
      })
      const result = await gateway.executeAutoToolCalls({
        toolMessage,
        conversationId: 'conv-1',
        conversationMessages: [disclosureMessage],
      })
      const response = result.toolCalls[0]?.response
      expect(response?.status).toBe(ToolCallResponseStatus.Error)
      if (response?.status === ToolCallResponseStatus.Error) {
        expect(response.error).toContain('schema validation')
      }
    })

    it('unpacks args_json before dispatch on Gemini', async () => {
      const mcpManager = mcpManagerWithRealTool()
      const gateway = buildGateway(mcpManager, 'gemini')
      const disclosureMessage = {
        role: 'tool' as const,
        id: 'tool-load',
        toolCalls: [
          {
            request: {
              id: 'call-search',
              name: 'yolo_local__load_tool_schemas',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success as const,
              data: {
                type: 'text' as const,
                text: JSON.stringify({
                  tool: 'load_tool_schemas',
                  loadedToolNames: ['server__tool_a'],
                  matches: [
                    {
                      name: 'server__tool_a',
                      description: 'Tool A',
                      parameters: realToolSchema,
                    },
                  ],
                }),
              },
            },
          },
        ],
      }
      const toolMessage = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-good',
            name: 'server__tool_a',
            arguments: createCompleteToolCallArguments({
              value: { args_json: '{"value": "hello"}' },
            }),
          },
        ],
        conversationId: 'conv-1',
      })
      const result = await gateway.executeAutoToolCalls({
        toolMessage,
        conversationId: 'conv-1',
        conversationMessages: [disclosureMessage],
      })
      const response = result.toolCalls[0]?.response
      expect(response?.status).toBe(ToolCallResponseStatus.Success)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock for assertion
      const callMock = mcpManager.callTool as unknown as jest.Mock
      expect(callMock).toHaveBeenCalledTimes(1)
      const callArgs = callMock.mock.calls[0]?.[0] as { args: unknown }
      expect(callArgs.args).toEqual({ value: 'hello' })
    })

    it('honors schemas persisted in compaction state when no load_tool_schemas history remains', async () => {
      const mcpManager = mcpManagerWithRealTool()
      const gateway = buildGateway(mcpManager)
      const compaction = {
        anchorMessageId: 'anchor-1',
        summary: 'prior turns compacted',
        compactedAt: Date.now(),
        loadedDeferredToolSchemas: [
          {
            name: 'server__tool_a',
            description: 'Tool A',
            parameters: realToolSchema,
          },
        ],
      }
      const toolMessage = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-good',
            name: 'server__tool_a',
            arguments: createCompleteToolCallArguments({
              value: { value: 'hello' },
            }),
          },
        ],
        conversationId: 'conv-1',
      })
      const result = await gateway.executeAutoToolCalls({
        toolMessage,
        conversationId: 'conv-1',
        conversationMessages: [],
        conversationCompaction: compaction,
      })
      const response = result.toolCalls[0]?.response
      expect(response?.status).toBe(ToolCallResponseStatus.Success)
    })
  })

  describe('module chat mode tool call snapshot', () => {
    // Mirrors resolveModuleChatModeRuntime's moduleToolApprovalPolicies: full
    // tool name -> the mode's declared requiresApproval (present with
    // `false` when omitted, absent entirely for non-mode tools).
    const moduleToolApprovalPolicies = new Map<string, boolean>([
      ['module-mode-learning-chat__start_course_generation', true],
      ['module-mode-learning-chat__get_generation_status', false],
    ])

    it('fixes approvalPolicy "always-require-user" and stays PendingApproval, ignoring bypassToolApproval and the conversation allow-list', () => {
      const mcpManager = {
        // Both would normally auto-execute the call; the persisted policy
        // must override them entirely.
        isToolExecutionAllowed: jest.fn().mockReturnValue(true),
        getJsSandboxSettings: jest.fn().mockReturnValue({}),
      } as unknown as McpManager

      const gateway = new AgentToolGateway(mcpManager, {
        bypassToolApproval: true,
        allowedToolNames: [
          'module-mode-learning-chat__start_course_generation',
        ],
        moduleToolApprovalPolicies,
      })

      const message = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-1',
            name: 'module-mode-learning-chat__start_course_generation',
            arguments: emptyArgs,
          },
        ],
        conversationId: 'conv-1',
      })

      expect(message.toolCalls[0]?.response.status).toBe(
        ToolCallResponseStatus.PendingApproval,
      )
      expect(message.toolCalls[0]?.request.metadata?.approvalPolicy).toBe(
        'always-require-user',
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
      const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
      expect(isToolExecutionAllowedMock).not.toHaveBeenCalled()
    })

    it('fixes approvalPolicy "auto" and runs immediately for a mode tool without requiresApproval', () => {
      const mcpManager = {
        isToolExecutionAllowed: jest.fn().mockReturnValue(false),
        getJsSandboxSettings: jest.fn().mockReturnValue({}),
      } as unknown as McpManager

      const gateway = new AgentToolGateway(mcpManager, {
        allowedToolNames: ['module-mode-learning-chat__get_generation_status'],
        moduleToolApprovalPolicies,
      })

      const message = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-1',
            name: 'module-mode-learning-chat__get_generation_status',
            arguments: emptyArgs,
          },
        ],
        conversationId: 'conv-1',
      })

      expect(message.toolCalls[0]?.response.status).toBe(
        ToolCallResponseStatus.Running,
      )
      expect(message.toolCalls[0]?.request.metadata?.approvalPolicy).toBe(
        'auto',
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
      const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
      expect(isToolExecutionAllowedMock).not.toHaveBeenCalled()
    })

    it('does not write approvalPolicy for a host tool granted by the mode capability tier (not in the map)', () => {
      const mcpManager = {
        isToolExecutionAllowed: jest.fn().mockReturnValue(true),
        getJsSandboxSettings: jest.fn().mockReturnValue({}),
      } as unknown as McpManager

      const gateway = new AgentToolGateway(mcpManager, {
        allowedToolNames: ['yolo_local__bash'],
        bashReadOnly: true,
        moduleToolApprovalPolicies,
      })

      const message = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-1',
            name: 'yolo_local__bash',
            arguments: createCompleteToolCallArguments({
              value: { command: 'ls' },
            }),
          },
        ],
        conversationId: 'conv-1',
      })

      expect(
        message.toolCalls[0]?.request.metadata?.approvalPolicy,
      ).toBeUndefined()
      expect(
        message.toolCalls[0]?.request.metadata?.executionConstraints,
      ).toEqual({ bashReadOnly: true })
    })

    it('does not write executionConstraints for a non-bash tool in module mode', () => {
      const mcpManager = {
        isToolExecutionAllowed: jest.fn().mockReturnValue(false),
        getJsSandboxSettings: jest.fn().mockReturnValue({}),
      } as unknown as McpManager

      const gateway = new AgentToolGateway(mcpManager, {
        allowedToolNames: ['module-mode-learning-chat__get_generation_status'],
        bashReadOnly: true,
        moduleToolApprovalPolicies,
      })

      const message = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-1',
            name: 'module-mode-learning-chat__get_generation_status',
            arguments: emptyArgs,
          },
        ],
        conversationId: 'conv-1',
      })

      expect(
        message.toolCalls[0]?.request.metadata?.executionConstraints,
      ).toBeUndefined()
    })

    it('writes no module chat mode metadata at all outside module chat mode runs', () => {
      const mcpManager = {
        isToolExecutionAllowed: jest.fn().mockReturnValue(true),
        getJsSandboxSettings: jest.fn().mockReturnValue({}),
      } as unknown as McpManager

      // No `moduleToolApprovalPolicies` passed — matches every existing
      // (non-module) chat mode and assistant run.
      const gateway = new AgentToolGateway(mcpManager, {
        allowedToolNames: ['yolo_local__bash'],
        builtinCapabilityPreferences: {
          vault_shell: { enabled: true, approvalMode: 'full_access' },
        },
        bashReadOnly: false,
      })

      const message = gateway.createToolMessage({
        toolCallRequests: [
          {
            id: 'tool-1',
            name: 'yolo_local__bash',
            arguments: createCompleteToolCallArguments({
              value: { command: 'ls' },
            }),
          },
        ],
        conversationId: 'conv-1',
      })

      expect(
        message.toolCalls[0]?.request.metadata?.approvalPolicy,
      ).toBeUndefined()
      expect(
        message.toolCalls[0]?.request.metadata?.executionConstraints,
      ).toBeUndefined()
    })
  })
})
