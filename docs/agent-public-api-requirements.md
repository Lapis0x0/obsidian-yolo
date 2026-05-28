# Agent Public API Requirements

## Background

Other Obsidian plugins need a stable way to hand tasks to YOLO Agent without asking the user to manually open the chat panel, paste a prompt, attach context, and press send.

The first version should expose a small plugin-instance API that submits a task into YOLO Agent mode. It should reuse the normal chat submission pipeline so task execution keeps the existing model selection, context building, tool permissions, message persistence, and UI feedback.

## Goals

- Allow another plugin to submit a prompt to YOLO Agent with optional file or folder context.
- Always submit through Agent mode.
- Keep the API small enough for automation plugins, calendar plugins, task plugins, and custom scripts to call.
- Avoid adding a headless execution contract in the first version.

## Non-Goals

- Do not return the final model answer from the public API in the first version.
- Do not bypass the existing chat UI or agent run pipeline.
- Do not define command-line behavior in this document.
- Do not add integration-specific behavior for any single third-party plugin.

## Proposed API

```ts
await app.plugins.plugins.yolo.runAgentTask(content, {
  filePath: 'Daily/2026-05-28.md',
  folderPath: 'Projects/Alpha',
  assistantId: 'optional-assistant-id',
})
```

The API submits the task and resolves once the task has been handed to the chat panel:

```ts
{ success: true, answer: 'Agent task submitted' }
```

## Use Cases

- A scheduled-task plugin asks YOLO Agent every night to summarize the daily note and completed tasks.
- A weekly review automation asks YOLO Agent to read a project folder and draft a project status report.
- A todo plugin triggers YOLO Agent after a task list is completed to extract lessons learned and follow-up tasks.
- A calendar or meeting plugin sends meeting notes to YOLO Agent to create minutes and action items.
- An import or sync plugin asks YOLO Agent to summarize newly imported research material and suggest tags.
- A template workflow creates a review note and asks YOLO Agent to fill the first draft from referenced files.

## Acceptance Criteria

- External plugins can call `app.plugins.plugins.yolo.runAgentTask(...)`.
- Empty prompts are rejected with a clear error.
- Missing file or folder paths are rejected with clear errors.
- Valid file and folder paths are attached as context in the submitted message.
- The submitted message uses Agent mode even if the current chat panel is in normal chat mode.
- The implementation does not require callers to know about YOLO internals such as React refs, chat messages, or agent service run inputs.
