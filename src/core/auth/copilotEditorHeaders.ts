/**
 * Editor identification headers GitHub expects from a Copilot client, sent
 * both on the token exchange and on every model request.
 *
 * The Copilot protocol has no public contract: GitHub may start rejecting
 * these values at any time, so they live in this one place and are bumped
 * here only.
 */
export const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  'Editor-Version': 'vscode/1.104.1',
  'Editor-Plugin-Version': 'copilot-chat/0.31.0',
  'User-Agent': 'GitHubCopilotChat/0.31.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'X-GitHub-Api-Version': '2025-05-01',
}
