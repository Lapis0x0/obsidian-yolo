---
name: skill-creator
description: Guide for creating effective YOLO skills. Use when users want to create a new skill, update an existing skill, or improve skill quality within their Obsidian vault. Covers skill design principles, anatomy, and the full creation workflow.
mode: lazy
---

# Skill Creator

This skill provides guidance for creating effective YOLO skills.

## About Skills

Skills are self-contained Markdown files that extend the agent's capabilities by providing specialized knowledge and workflows. Think of them as "onboarding guides" for specific domains or tasks. They transform a general-purpose agent into a specialized one equipped with procedural knowledge that no model can fully possess.

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Domain expertise - Company-specific knowledge, schemas, business logic
3. Tool guidance - Instructions for working with specific file formats or vault structures
4. Quality standards - Output patterns, naming conventions, and verification checklists

## Core Principles

### Concise Is Key

The context window is a public good. Skills share the context window with the system prompt, conversation history, other skills metadata, and the actual user request.

Default assumption: the model is already very smart. Only add context the model does not already have. Challenge each piece of information: "Does the model really need this explanation?" and "Does this paragraph justify its token cost?"

Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

Match the level of specificity to the task's fragility and variability:

- High freedom (text-based guidance): Use when multiple approaches are valid, decisions depend on context, or heuristics guide the approach.
- Medium freedom (structured steps with defaults): Use when a preferred pattern exists, some variation is acceptable, or configuration affects behavior.
- Low freedom (strict sequence, explicit constraints): Use when operations are fragile and error-prone, consistency is critical, or a specific sequence must be followed.

Think of the agent as exploring a path: a narrow bridge with cliffs needs specific guardrails (low freedom), while an open field allows many routes (high freedom).

### Reversibility by Default

Obsidian vaults contain the user's real data. Prefer minimal edits, explicit verification steps, and safe patterns. Use `fs_edit` for a targeted content change in an existing file, `fs_write` to create or overwrite full file content, and the `bash` tool (`mkdir`/`mv`/`rm`) for path operations. Do not perform destructive operations unless explicitly requested.

## Anatomy of a Skill

YOLO supports simple Markdown skills and directory packages. Use a single Markdown file by default; use a package only when the skill needs supporting resources:

```
YOLO/skills/
├── meeting-notes.md
├── pdf-editor/
│   ├── SKILL.md
│   └── scripts/
└── ...
```

The Markdown entry file—either `<readable-name>.md` or a package's `SKILL.md`—has two parts. Packages may also contain supporting resources:

### Frontmatter (YAML, required)

Contains `name` and `description` fields:

- `name`: Stable kebab-case identifier (e.g., `meeting-notes`). Must be unique across the vault. This is both the skill's identity and its label.
- `description`: The primary triggering mechanism. The agent reads this to decide when to activate the skill. Include both what the skill does and specific triggers/contexts for when to use it.

```yaml
---
name: meeting-notes
description: Create structured meeting notes from raw transcripts or bullet points. Use when users paste meeting content, ask to summarize a meeting, or request action item extraction from conversation logs.
---
```

Description quality matters enormously. Only the frontmatter fields are always in context. The body loads only after the skill triggers. So all "when to use" information must live in the description, never buried in the body.

### Body (Markdown, required)

Instructions and guidance for using the skill. Written for the agent, in imperative/infinitive form.

The body should contain:

1. Workflow: The steps to follow when the skill triggers
2. Constraints: Guardrails, edge cases, things to avoid
3. Output pattern: Expected format or structure of the result (when consistency matters)
4. Verification: How to confirm the output is correct

### What to Include and Exclude

Include:
- Procedural knowledge the model cannot reliably infer
- Domain-specific terminology, schemas, or conventions
- Concrete examples that clarify ambiguous requirements
- Verification checklists for quality assurance

Exclude:
- General knowledge the model already possesses
- Explanations of why the skill exists or its design rationale
- Setup instructions, changelogs, or user-facing documentation
- Redundant restatements of the same concept

The skill exists for the agent to do the job at hand. Every line should earn its place in the context window.

## Progressive Disclosure

Skills use a two-level loading system to manage context efficiently:

1. Metadata (name + description): Always in context (~50-100 words)
2. Skill body: Loaded only when the skill triggers

This means the body can be more detailed without constantly consuming context. But keep it focused. Aim for under 300 lines. If a skill grows beyond that, consider whether it is trying to do too much and should be split into multiple skills.

Key principle: When a skill supports multiple variations or domains, split into separate skills rather than cramming everything into one file. Each skill should have a clear, singular purpose.

```
# Instead of one monolithic "data-analysis" skill:
YOLO/skills/
├── bigquery-finance.md
├── bigquery-sales.md
└── bigquery-product.md
```

This way, when the user asks about sales metrics, only `bigquery-sales.md` activates and loads.

## Available Tools

YOLO skills operate within Obsidian's environment. The following built-in tools are available:

| Tool | Purpose |
|------|---------|
| `fs_edit` | Apply exactly one targeted text edit to an existing file (by exact `oldText`, or by `startLine`/`endLine` range) |
| `fs_write` | Create a file or overwrite it with full content |
| `bash` | Vault-sandboxed shell (mounted at `/vault`) for search/inspection (`ls`, `find`, `grep`, `cat`, pipes, ...) and `mkdir`/`mv`/`rm` path operations |

Skills should be designed around these capabilities. `bash` is a sandboxed virtual shell scoped to the vault, not real OS/shell access, and there is no external API access. All skill workflows must be achievable through these tools and the agent's reasoning.

## Skill Load Modes

- always: inject the full skill body at conversation start
- lazy: expose metadata first and load full body only when needed

## Skill Creation Process

1. Understand the skill with concrete examples
2. Explore existing vault skills
3. Plan the skill contents
4. Draft the skill
5. Write to vault safely
6. Verify and iterate

Follow these steps in order.

### Step 1: Understand the Skill with Concrete Examples

Skip this step only when the skill's usage patterns are already clearly understood.

To create an effective skill, clearly understand concrete examples of how the skill will be used. Ask targeted questions:

- "What should this skill help you do? Can you give 1-3 examples?"
- "What would you say to trigger this skill?"
- "What does a good result look like?"

Avoid overwhelming the user with too many questions at once. Start with the most important ones and follow up as needed.

Conclude this step when there is a clear sense of the functionality the skill should support.

### Step 2: Explore Existing Vault Skills

Before creating something new, check what already exists:

```
bash: ls YOLO/skills/                     -> see current inventory
bash: grep -rl "<topic keywords>" YOLO/skills/  -> find related skills
bash: sed -n '1,40p' <similar-skill-path>       -> study patterns that work (prefer targeted ranges when a section is known)
```

This avoids duplication and helps maintain consistency across the vault's skill collection.

### Step 3: Plan the Skill Contents

Analyze each concrete example by considering:

1. What steps would the agent follow to handle this request from scratch?
2. What knowledge, patterns, or constraints would help the agent handle this reliably every time?
3. What degree of freedom is appropriate for each step?

### Step 4: Draft the Skill

Write the frontmatter first, then the body.

Frontmatter checklist:
- `name` is stable and unique
- `description` clearly states what the skill does and when to trigger it

Body guidelines:
- Use imperative/infinitive form ("Extract action items", "Verify the output")
- Lead with the workflow, then constraints, then output pattern
- Include a concrete example if the expected behavior is non-obvious
- Keep verification steps explicit

### Step 5: Write to Vault

For a simple skill, keep the user-facing filename readable:

```
fs_write { path: "YOLO/skills/<readable-name>.md", content: "..." }
```

Only create a directory package when the skill needs scripts, references, assets, or other supporting files:

```
bash: mkdir -p YOLO/skills/<folder>
fs_write { path: "YOLO/skills/<folder>/SKILL.md", content: "..." }
```

For updates, preserve the skill's existing filename or package folder and prefer `fs_edit` for minimal, targeted changes.

### Step 6: Verify and Iterate

After writing:

1. `bash: cat` (or a targeted `sed -n` range) the file to confirm it saved correctly
2. Verify the description clearly communicates trigger conditions
3. Walk through each workflow step mentally: is it executable with available tools?
4. Test the skill on a real task when possible

Iteration workflow:

1. Use the skill on real tasks
2. Notice struggles or inefficiencies
3. Identify how the skill should be updated
4. Apply changes with `fs_edit` and test again

## Quality Checklist

Before finalizing any skill, verify:

- [ ] Frontmatter includes `name` and `description`
- [ ] Description states clear trigger conditions (not buried in body)
- [ ] `name` is stable and unique
- [ ] A simple skill remains a readable Markdown file; supporting resources stay inside a package folder with `SKILL.md`
- [ ] Workflow is executable with available tools (`fs_edit`, `fs_write`, `bash`)
- [ ] Instructions are concise and avoid redundant background
- [ ] Output pattern is defined where consistency matters
- [ ] Body is under 300 lines
- [ ] No extraneous documentation (README, changelog, etc.)

## Output Contract

When creating or updating a skill, report:

1. File created or updated (with path)
2. Summary of what the skill does and when it triggers
3. Recommended load mode (always or lazy) and why
4. Suggested next steps or iteration ideas based on likely usage
