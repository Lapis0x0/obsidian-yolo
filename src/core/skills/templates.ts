import { DEFAULT_YOLO_BASE_DIR, YOLO_SKILLS_SUBDIR } from '../paths/yoloPaths'

export const YOLO_SKILLS_DIR = `${DEFAULT_YOLO_BASE_DIR}/${YOLO_SKILLS_SUBDIR}`

export const YOLO_SKILLS_INDEX_TEMPLATE = `# YOLO Skills

Store your skill files here.

- Supported formats:
  - Legacy: \`YOLO/skills/*.md\` (exclude \`Skills.md\`)
  - Claude-style: \`YOLO/skills/**/SKILL.md\`
- Required frontmatter: \`name\` (required), \`id\` (optional, defaults to \`name\`), \`description\` (optional)
`

export const YOLO_OBSIDIAN_OUTPUT_FORMAT_TEMPLATE = `---
id: obsidian-output-format
name: Obsidian Output Format
description: Use <smtcmp_block> only for markdown file edit plans. Output the compact edit DSL only.
mode: always
---

# Obsidian Output Format

Use \`<smtcmp_block>\` only when proposing edits to an existing markdown file.

## Rules

1. Output exactly one \`<smtcmp_block>\` when proposing file edits.
2. Inside \`<smtcmp_block>\`, output one edit block only.
3. The \`<smtcmp_block>\` block does not require any code block wrapping.

## Format

Normal output text before the \`<smtcmp_block>\` block.
<smtcmp_block filename="path/to/file.md">
<<<<<<< REPLACE/INSERT_AFTER/APPEND
[old]
exact old text
=======
[new]
new text
>>>>>>> END
</smtcmp_block>
Normal output text after the \`<smtcmp_block>\` block.

Allowed operation types:

1. \`REPLACE\` for replacement
2. \`INSERT_AFTER\` for insertion after an anchor
3. \`APPEND\` for appending to the end

## Operation Rules

- Keep \`[old]\` or \`[anchor]\` minimal but uniquely matchable.
- Preserve exact markdown source in \`[old]\`, including whitespace and punctuation.
- The \`APPEND\` operation only requires outputting the New text; there is no need to output \`[old]\`, exact old text,and \`>>>>>>> END\`
- Each \`<smtcmp_block>\` must contain exactly one operation.
- Do not dump the full file unless explicitly requested.
`

export const YOLO_SKILL_CREATOR_TEMPLATE = `---
id: skill-creator
name: Skill Creator
description: Guide for creating effective YOLO skills. Use when users want to create a new skill, update an existing skill, or improve skill quality within their Obsidian vault. Covers skill design principles, anatomy, and the full creation workflow.
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

Obsidian vaults contain the user's real data. Prefer minimal edits, explicit verification steps, and safe patterns. Use \`fs_edit\` for existing-file content changes, and \`fs_create_file\` / \`fs_delete_file\` / \`fs_create_dir\` / \`fs_delete_dir\` / \`fs_move\` for path operations. Do not perform destructive operations unless explicitly requested.

## Anatomy of a Skill

Every YOLO skill is a single \`.md\` file stored in the vault's \`YOLO/skills/\` folder:

~~~
YOLO/skills/
├── skill-creator.md
├── meeting-notes.md
├── pdf-editor.md
└── ...
~~~

Each skill \`.md\` file consists of two parts:

### Frontmatter (YAML, required)

Contains \`id\`, \`name\`, and \`description\` fields:

- \`id\`: Stable kebab-case identifier (e.g., \`meeting-notes\`). Must be unique across the vault.
- \`name\`: Human-readable title (e.g., \`Meeting Notes\`).
- \`description\`: The primary triggering mechanism. The agent reads this to decide when to activate the skill. Include both what the skill does and specific triggers/contexts for when to use it.

~~~yaml
---
id: meeting-notes
name: Meeting Notes
description: Create structured meeting notes from raw transcripts or bullet points. Use when users paste meeting content, ask to summarize a meeting, or request action item extraction from conversation logs.
---
~~~

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

1. Metadata (id + name + description): Always in context (~50-100 words)
2. Skill body: Loaded only when the skill triggers

This means the body can be more detailed without constantly consuming context. But keep it focused. Aim for under 300 lines. If a skill grows beyond that, consider whether it is trying to do too much and should be split into multiple skills.

Key principle: When a skill supports multiple variations or domains, split into separate skills rather than cramming everything into one file. Each skill should have a clear, singular purpose.

~~~
# Instead of one monolithic "data-analysis" skill:
YOLO/skills/
├── bigquery-finance.md
├── bigquery-sales.md
└── bigquery-product.md
~~~

This way, when the user asks about sales metrics, only \`bigquery-sales.md\` activates and loads.

## Available Tools

YOLO skills operate within Obsidian's environment. The following built-in tools are available:

| Tool | Purpose |
|------|---------|
| \`fs_list\` | Inspect folder contents and vault structure |
| \`fs_search\` | Find files by keyword or pattern |
| \`fs_read\` | Read file contents |
| \`fs_edit\` | Apply targeted text edits to an existing file (\`replace\`, \`insert_after\`, \`append\`) |
| \`fs_create_file\` | Create a file with provided content (supports \`dryRun\`) |
| \`fs_delete_file\` | Delete a file path (supports \`dryRun\`) |
| \`fs_create_dir\` | Create a directory path (supports \`dryRun\`) |
| \`fs_delete_dir\` | Delete a directory path (supports \`recursive\` and \`dryRun\`) |
| \`fs_move\` | Move or rename a file/folder path (supports \`dryRun\`) |

Skills should be designed around these capabilities. There is no script execution environment, no shell access, and no external API calls. All skill workflows must be achievable through file operations and the agent's reasoning.

## Skill Load Modes

- full-inject: inject the full skill body at conversation start
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

~~~
fs_list YOLO/skills/          -> see current inventory
fs_search <topic keywords>    -> find related skills
fs_read <similar-skill.md>    -> study patterns that work
~~~

This avoids duplication and helps maintain consistency across the vault's skill collection.

### Step 3: Plan the Skill Contents

Analyze each concrete example by considering:

1. What steps would the agent follow to handle this request from scratch?
2. What knowledge, patterns, or constraints would help the agent handle this reliably every time?
3. What degree of freedom is appropriate for each step?

### Step 4: Draft the Skill

Write the frontmatter first, then the body.

Frontmatter checklist:
- \`id\` is kebab-case and unique
- \`name\` is readable
- \`description\` clearly states what the skill does and when to trigger it

Body guidelines:
- Use imperative/infinitive form ("Extract action items", "Verify the output")
- Lead with the workflow, then constraints, then output pattern
- Include a concrete example if the expected behavior is non-obvious
- Keep verification steps explicit

### Step 5: Write to Vault Safely

Always preview before committing:

~~~
fs_create_file { path: "YOLO/skills/<skill-id>.md", content: "...", dryRun: true } -> preview
fs_create_file { path: "YOLO/skills/<skill-id>.md", content: "..." } -> commit
~~~

For updates to existing skills, prefer \`fs_edit\` to make minimal, targeted changes rather than rewriting the entire file.

### Step 6: Verify and Iterate

After writing:

1. \`fs_read\` the file to confirm it saved correctly
2. Verify the description clearly communicates trigger conditions
3. Walk through each workflow step mentally: is it executable with available tools?
4. Test the skill on a real task when possible

Iteration workflow:

1. Use the skill on real tasks
2. Notice struggles or inefficiencies
3. Identify how the skill should be updated
4. Apply changes with \`fs_edit\` and test again

## Quality Checklist

Before finalizing any skill, verify:

- [ ] Frontmatter includes \`id\`, \`name\`, and \`description\`
- [ ] Description states clear trigger conditions (not buried in body)
- [ ] \`id\` is kebab-case and matches the filename
- [ ] Workflow is executable with available tools (\`fs_list\`, \`fs_search\`, \`fs_read\`, \`fs_edit\`, \`fs_create_file\`, \`fs_delete_file\`, \`fs_create_dir\`, \`fs_delete_dir\`, \`fs_move\`)
- [ ] Instructions are concise and avoid redundant background
- [ ] Output pattern is defined where consistency matters
- [ ] Body is under 300 lines
- [ ] No extraneous documentation (README, changelog, etc.)

## Output Contract

When creating or updating a skill, report:

1. File created or updated (with path)
2. Summary of what the skill does and when it triggers
3. Recommended load mode (full-inject or lazy) and why
4. Suggested next steps or iteration ideas based on likely usage
`
