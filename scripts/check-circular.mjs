// Two-layer circular dependency guard:
// 1. Static runtime graph (type-only and dynamic imports excluded) must be
//    completely acyclic.
// 2. Logical runtime graph (type-only excluded, dynamic imports kept) is
//    compared as direct cyclic edges against a narrow baseline.
//
// `--update` is prune-only: it removes logical edges that no longer exist but
// refuses to absorb additions. A new allowance requires an explicit,
// reviewable edit to the baseline file.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')
const baselinePath = path.join(rootDir, 'scripts/circular-deps-baseline.json')
const shouldUpdate = process.argv.includes('--update')

async function buildGraph({ skipAsyncImports }) {
  const madge = (await import('madge')).default
  const result = await madge(path.join(rootDir, 'src'), {
    fileExtensions: ['ts', 'tsx'],
    tsConfig: path.join(rootDir, 'tsconfig.json'),
    excludeRegExp: [/\.test\.(ts|tsx)$/],
    detectiveOptions: {
      ts: { skipTypeImports: true, skipAsyncImports },
      tsx: { skipTypeImports: true, skipAsyncImports },
    },
  })
  return result.obj()
}

function findCyclicComponents(graph) {
  let nextIndex = 0
  const stack = []
  const onStack = new Set()
  const indices = new Map()
  const lowLinks = new Map()
  const components = []

  const visit = (node) => {
    indices.set(node, nextIndex)
    lowLinks.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)

    for (const dependency of graph[node] ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency)
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node), lowLinks.get(dependency)),
        )
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node), indices.get(dependency)),
        )
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return

    const component = []
    let member
    do {
      member = stack.pop()
      onStack.delete(member)
      component.push(member)
    } while (member !== node)

    const isSelfCycle =
      component.length === 1 &&
      (graph[component[0]] ?? []).includes(component[0])
    if (component.length > 1 || isSelfCycle) {
      components.push(component.sort())
    }
  }

  for (const node of Object.keys(graph).sort()) {
    if (!indices.has(node)) visit(node)
  }
  return components.sort((left, right) => right.length - left.length)
}

function getCyclicEdges(graph, components) {
  const edges = []
  for (const component of components) {
    const members = new Set(component)
    for (const from of component) {
      for (const to of graph[from] ?? []) {
        if (members.has(to)) edges.push(`${from} -> ${to}`)
      }
    }
  }
  return edges.sort()
}

function printComponents(label, components, edges) {
  console.error(
    `${label}: ${components.length} cyclic component(s), ${edges.length} direct cyclic edge(s).`,
  )
  for (const component of components.slice(0, 5)) {
    console.error(`  - ${component.join(', ')}`)
  }
}

async function readBaseline() {
  try {
    return JSON.parse(await readFile(baselinePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeBaseline(logicalCyclicEdges) {
  await writeFile(
    baselinePath,
    `${JSON.stringify({ logicalCyclicEdges }, null, 2)}\n`,
  )
}

const staticGraph = await buildGraph({ skipAsyncImports: true })
const staticComponents = findCyclicComponents(staticGraph)
const staticEdges = getCyclicEdges(staticGraph, staticComponents)

if (staticComponents.length > 0) {
  printComponents(
    'Static runtime dependency check failed',
    staticComponents,
    staticEdges,
  )
  console.error('Break every static runtime cycle before committing.')
  process.exit(1)
}
console.log('Static runtime dependency check passed: graph is acyclic.')

const logicalGraph = await buildGraph({ skipAsyncImports: false })
const logicalComponents = findCyclicComponents(logicalGraph)
const logicalEdges = getCyclicEdges(logicalGraph, logicalComponents)
const baseline = await readBaseline()

if (!baseline || !Array.isArray(baseline.logicalCyclicEdges)) {
  console.error(
    `No valid logical-cycle baseline found at ${path.relative(rootDir, baselinePath)}.`,
  )
  process.exit(1)
}

const baselineEdges = new Set(baseline.logicalCyclicEdges)
const currentEdges = new Set(logicalEdges)
const addedEdges = logicalEdges.filter((edge) => !baselineEdges.has(edge))
const removedEdges = baseline.logicalCyclicEdges.filter(
  (edge) => !currentEdges.has(edge),
)

if (addedEdges.length > 0) {
  console.error(
    `Logical dependency ratchet failed: ${addedEdges.length} new direct cyclic edge(s).`,
  )
  for (const edge of addedEdges.slice(0, 10)) console.error(`  + ${edge}`)
  console.error(
    'Fix the dependency direction. The prune-only baseline command will not accept additions.',
  )
  process.exit(1)
}

if (shouldUpdate) {
  await writeBaseline(logicalEdges)
  console.log(
    `Logical dependency baseline pruned: ${logicalEdges.length} direct cyclic edge(s) remain.`,
  )
  process.exit(0)
}

if (removedEdges.length > 0) {
  console.warn(
    `Logical dependency baseline can be tightened: ${removedEdges.length} recorded edge(s) no longer exist. Run \`npm run deps:baseline\` to prune them.`,
  )
}

console.log(
  `Logical dependency ratchet passed: ${logicalComponents.length} allowed component(s), ${logicalEdges.length} direct cyclic edge(s).`,
)
