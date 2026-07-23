import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import yaml from 'js-yaml'
import { minimatch } from 'minimatch'

const workflowPath = path.resolve('.github/workflows/release.yml')
const source = await readFile(workflowPath, 'utf8')
const workflow = yaml.load(source, { schema: yaml.JSON_SCHEMA })
const build = workflow.jobs.build
const tagFilters = workflow.on.push.tags
const coreTagPattern = new RegExp(build.env.CORE_RELEASE_TAG_PATTERN)

function permitsCoreRelease(tag) {
  return (
    tagFilters.some((filter) => minimatch(tag, filter)) &&
    coreTagPattern.test(tag)
  )
}

test('Core release accepts only root numeric version tags', () => {
  assert.deepEqual(tagFilters, ['[0-9]*'])

  for (const tag of ['1.6.0', '1.6.0.3', '10.20.30.40']) {
    assert.equal(permitsCoreRelease(tag), true, tag)
  }

  for (const tag of [
    'learning/v1.2.3',
    'notes/v1.2.3',
    'calendar/v1.2.3',
    '1/v1.2.3',
    'v1.2.3',
    '1.2',
    '1.2.3.4.5',
    '1.2.3-beta.1',
    '01.2.3',
  ]) {
    assert.equal(permitsCoreRelease(tag), false, tag)
  }
})

test('Core release validates the tag before checkout and build', () => {
  const guardIndex = build.steps.findIndex(
    ({ name }) => name === 'Validate Core release tag',
  )
  const checkoutIndex = build.steps.findIndex(({ uses }) =>
    uses?.startsWith('actions/checkout@'),
  )
  const buildIndex = build.steps.findIndex(
    ({ name }) => name === 'Build and test Core',
  )

  assert.equal(guardIndex, 0)
  assert.ok(guardIndex < checkoutIndex)
  assert.ok(guardIndex < buildIndex)
  assert.match(build.steps[guardIndex].run, /CORE_RELEASE_TAG_PATTERN/)
  assert.match(build.steps[guardIndex].run, /exit 1/)
})

test('Core release keeps least-privilege permissions and pinned actions', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(build.permissions, {
    actions: 'write',
    contents: 'write',
  })

  const actions = build.steps.filter(({ uses }) => uses)
  assert.ok(actions.length > 0)
  for (const step of actions) {
    assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/)
  }
})

test('Core release is immutable and wakes the central reconcile', () => {
  const sourceText = source
  assert.equal(workflow.concurrency.group, 'core-release')
  assert.doesNotMatch(sourceText, /--clobber/)
  assert.match(sourceText, /Create immutable draft Release/)
  assert.match(sourceText, /Verify published Release/)
  assert.match(sourceText, /distribution-publish\.yml/)
})

test('all first-party modules share one tag workflow', async () => {
  const moduleSource = await readFile(
    path.resolve('.github/workflows/module-release.yml'),
    'utf8',
  )
  const moduleWorkflow = yaml.load(moduleSource, { schema: yaml.JSON_SCHEMA })
  assert.deepEqual(moduleWorkflow.on.push.tags, ['*/v*'])
  assert.equal(moduleWorkflow.concurrency.group, 'module-release')
  assert.match(moduleSource, /validate-module-release\.mjs/)
  assert.match(moduleSource, /distribution-publish\.yml/)
  assert.doesNotMatch(moduleSource, /module-catalog\.yml/)
})

test('distribution treats dispatch as a wake-up and reconciles full state', async () => {
  const distributionSource = await readFile(
    path.resolve('.github/workflows/distribution-publish.yml'),
    'utf8',
  )
  const distributionWorkflow = yaml.load(distributionSource, {
    schema: yaml.JSON_SCHEMA,
  })
  assert.equal(distributionWorkflow.concurrency.group, 'distribution-publish')
  assert.equal(distributionWorkflow.concurrency['cancel-in-progress'], false)
  assert.ok(distributionWorkflow.on.schedule)
  assert.match(distributionSource, /args=\(reconcile\)/)
  assert.match(distributionSource, /scripts\/distribution\.mjs/)
  assert.match(distributionSource, /git status --porcelain -- distribution/)
  assert.match(distributionSource, /for attempt in 1 2 3/)
  assert.doesNotMatch(distributionSource, /force.push|--force/)
})
