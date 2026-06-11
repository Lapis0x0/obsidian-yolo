import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
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
          disclosureMode: 'on_demand',
        },
      },
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

  it('auto executes read-only terminal commands even when terminal_command requires approval', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest
        .fn()
        .mockImplementation(({ requireAutoExecution }) => requireAutoExecution),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__terminal_command'],
      toolPreferences: {
        yolo_local__terminal_command: {
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
      toolPreferences: {
        yolo_local__terminal_command: {
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
      toolPreferences: {
        yolo_local__terminal_command: {
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
      toolPreferences: {
        yolo_local__terminal_command: {
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
      toolPreferences: {
        yolo_local__terminal_command: {
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
      toolPreferences: {
        yolo_local__terminal_command: {
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
      toolPreferences: {
        yolo_local__terminal_command: {
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

  it('does not leave approval-required subagent child calls pending', () => {
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

    const response = message.toolCalls[0]?.response
    expect(response?.status).toBe(ToolCallResponseStatus.Error)
    if (response?.status === ToolCallResponseStatus.Error) {
      expect(response.error).toContain('Subagents cannot pause')
    }
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
      toolPreferences: {
        yolo_local__fs_edit: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'yolo_local__fs_edit', arguments: emptyArgs },
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
        args: {},
        id: 'tool-1',
        conversationId: 'conv-1',
        conversationMessages: undefined,
        roundId: message.id,
        requireReview: true,
        signal: undefined,
      }),
    )
  })

  it('does not open fs_edit review in subagent child runs without automatic permission', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
      getJsSandboxSettings: jest.fn().mockReturnValue({}),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      isSubagentChildRun: true,
      allowedToolNames: ['yolo_local__fs_edit'],
      toolPreferences: {
        yolo_local__fs_edit: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'yolo_local__fs_edit', arguments: emptyArgs },
      ],
      conversationId: 'subagent-task',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Error,
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
      toolPreferences: {
        yolo_local__fs_edit: {
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

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Rejected,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).not.toHaveBeenCalled()
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
            disclosureMode: 'on_demand',
          },
        },
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
})
