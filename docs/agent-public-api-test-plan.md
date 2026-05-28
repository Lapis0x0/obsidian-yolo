# Agent Public API Test Plan

## API Smoke Test

Run from an Obsidian developer console after YOLO is enabled:

```ts
await app.plugins.plugins.yolo.runAgentTask('Summarize this note', {
  filePath: 'Daily/2026-05-28.md',
})
```

Expected result:

- YOLO opens or reuses a chat panel.
- The prompt is submitted automatically.
- The conversation is in Agent mode.
- The referenced file appears as message context.
- The returned value is `{ success: true, answer: 'Agent task submitted' }`.

## Manual Scenarios

- Submit a prompt without context:

```ts
await app.plugins.plugins.yolo.runAgentTask('Plan my writing tasks for today')
```

- Submit a prompt with a file:

```ts
await app.plugins.plugins.yolo.runAgentTask('Summarize this daily note', {
  filePath: 'Daily/2026-05-28.md',
})
```

- Submit a prompt with a folder:

```ts
await app.plugins.plugins.yolo.runAgentTask('Draft a weekly project report', {
  folderPath: 'Projects/Alpha',
})
```

- Submit with a specific assistant:

```ts
await app.plugins.plugins.yolo.runAgentTask('Turn these notes into action items', {
  filePath: 'Meetings/Planning.md',
  assistantId: 'assistant-id',
})
```

## Error Scenarios

- Empty prompt rejects:

```ts
await app.plugins.plugins.yolo.runAgentTask('')
```

- Missing file rejects:

```ts
await app.plugins.plugins.yolo.runAgentTask('Summarize this', {
  filePath: 'Missing.md',
})
```

- Missing folder rejects:

```ts
await app.plugins.plugins.yolo.runAgentTask('Summarize this folder', {
  folderPath: 'Missing',
})
```

## Automated Tests

- `ChatViewNavigator.openChatWithAgentPromptAndSend()` submits through an existing chat leaf.
- `ChatViewNavigator.openChatWithAgentPromptAndSend()` creates a fresh chat leaf by default when no usable leaf exists.
- The submitted options pass through `assistantId`, `fileToAdd`, and `folderToAdd`.
- `YoloPlugin.runAgentTask()` validates empty content, missing files, and missing folders.

## Commands

```bash
npm test -- chatViewNavigator
npm run type:check
```
