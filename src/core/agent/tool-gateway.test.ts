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

  it('keeps tools pending when approval is required', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
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

  it('allows conversation-level approval to bypass per-tool approval', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
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

  it('runs fs_edit immediately when approval mode requires review', async () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
      callTool: jest.fn().mockResolvedValue({
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: '{}' },
      }),
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
    expect(callToolMock).toHaveBeenCalledWith({
      name: 'yolo_local__fs_edit',
      args: {},
      id: 'tool-1',
      conversationId: 'conv-1',
      conversationMessages: undefined,
      roundId: message.id,
      requireReview: true,
      signal: undefined,
    })
  })

  it('rejects tool calls when tools are disabled', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn(),
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

  it('rejects tool calls outside the allowed tool list', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn(),
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
})
