---
name: obsidian-cli
description: Drive Obsidian via the official CLI through terminal_command. Use when the user asks for Obsidian CLI, or when native fs_* / js_eval tools cannot cover Obsidian-specific operations (backlinks, properties, daily notes, command palette, plugin reload, tasks/tags, version history, etc.).
mode: lazy
---

# Obsidian CLI

Thin adapter: route to the official CLI executable and let its help command supply command details. Do not duplicate CLI docs here.

## When to use

- User explicitly asks for Obsidian CLI, or needs capabilities that `fs_*` / `js_eval` do not cover (Obsidian semantics: backlinks, frontmatter properties, daily notes, command palette, plugin reload, link graph, tasks/tags, file history, etc.).
- Otherwise prefer native tools (`bash`, `fs_write`, `fs_edit`, …). Do not round-trip through `terminal_command` for simple vault file work — `bash` already covers it.

## Workflow

1. **Resolve executable** (first use in the conversation): prefer the real CLI binary over the app launcher. On macOS, first check `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`; if executable, use that absolute path for all later commands. Otherwise use `command -v obsidian`. If the resolved path is `/Applications/Obsidian.app/Contents/MacOS/obsidian`, treat it as invalid because it is the app executable.
2. **Probe**: run `<resolved-cli> version`.
3. **Discover**: run `<resolved-cli> help` or `<resolved-cli> help <command>` — CLI documents parameters; read on demand.
4. **Execute**: run `<resolved-cli> <subcommand> …`. Add `format=json` when you need structured output to parse.

Rules:

- Never launch the interactive TUI (do not run the resolved CLI with no subcommand).
- Do not use `/Applications/Obsidian.app/Contents/MacOS/obsidian` as the CLI on macOS; that is the app executable, not the preferred CLI binary.
- Mutating CLI commands may require user approval like any other shell command.
- Desktop only (`terminal_command` is not available on mobile).

## Probe failure

If `<resolved-cli> version` fails (command not found or CLI error), tell the user to enable **Settings → General → Command line interface**, then retry. Do not guess command syntax — use `<resolved-cli> help` after probe succeeds.
