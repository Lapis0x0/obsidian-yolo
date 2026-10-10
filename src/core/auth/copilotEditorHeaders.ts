/**
 * Editor identification headers GitHub expects from a Copilot client, sent
 * both on the token exchange and on every model request.
 *
 * The Copilot protocol has no public contract: GitHub may start rejecting
 * these values at any time, so they live in this one place and are bumped
 * here only.
 */
export const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  'Editor-Version': 'vscode/1.120.0',
  'Editor-Plugin-Version': 'copilot-chat/0.70.0',
  'User-Agent': 'GitHubCopilotChat/0.70.0',
  'Copilot-Integration-Id': 'vscode-chat',
  // `/auto` (the only way Free and Student plans reach newer models) answers
  // 404 to API versions older than the one current VS Code sends.
  'X-GitHub-Api-Version': '2026-08-01',
}
