#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.dirname(scriptDir)
const homeDir = os.homedir()
const appName = process.env.OBSIDIAN_AGENT_APP || 'Obsidian'
const profileDir =
  process.env.OBSIDIAN_AGENT_PROFILE_DIR ||
  path.join(homeDir, 'Library/Application Support/obsidian-yolo-agent')
const vaultDir =
  process.env.OBSIDIAN_AGENT_VAULT_DIR ||
  path.join(homeDir, 'Documents/Git/obsidiandev-agent')
const pluginDir =
  process.env.OBSIDIAN_AGENT_PLUGIN_DIR ||
  path.join(vaultDir, '.obsidian/plugins/yolo')
const host = process.env.OBSIDIAN_AGENT_DEBUG_HOST || '127.0.0.1'
const port = Number(process.env.OBSIDIAN_AGENT_DEBUG_PORT || 9233)

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

async function listTargets() {
  const response = await fetch(`http://${host}:${port}/json`)
  if (!response.ok) throw new Error(`CDP /json returned ${response.status}`)
  return await response.json()
}

async function pickMainTarget() {
  const targets = await listTargets()
  const target = targets.find(
    (candidate) =>
      candidate.type === 'page' &&
      candidate.url?.startsWith('app://obsidian.md'),
  )
  if (!target) throw new Error(`No Agent Obsidian page on CDP port ${port}`)
  return target
}

async function evaluate(expression) {
  const target = await pickMainTarget()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error('Failed to connect to Agent CDP'))
  })

  let nextId = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const callbacks = pending.get(message.id)
    if (!callbacks) return
    pending.delete(message.id)
    if (message.error) callbacks.reject(new Error(message.error.message))
    else callbacks.resolve(message.result)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  try {
    await send('Runtime.enable')
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          'Agent evaluation failed',
      )
    }
    return result.result?.value
  } finally {
    socket.close()
  }
}

async function findAgentPid() {
  try {
    const escapedProfile = profileDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const { stdout } = await execFileAsync('pgrep', [
      '-f',
      `^/Applications/Obsidian\\.app/Contents/MacOS/Obsidian .*--user-data-dir=${escapedProfile}( |$)`,
    ])
    return Number(stdout.trim().split('\n')[0]) || null
  } catch (error) {
    if (error?.code === 1) return null
    throw error
  }
}

async function hideApplicationProcess() {
  const pid = await findAgentPid()
  if (!pid) return
  try {
    await execFileAsync('osascript', [
      '-e',
      `tell application "System Events" to set visible of first application process whose unix id is ${pid} to false`,
    ])
  } catch {
    // The process may still be starting or may already have hidden its Dock UI.
  }
}

async function waitForAgent() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      return await pickMainTarget()
    } catch {
      await sleep(200)
    }
  }
  throw new Error(`Agent Obsidian did not expose CDP port ${port} within 20s`)
}

async function waitForWorkspace() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(`
        return Boolean(
          app?.workspace?.layoutReady &&
          app?.vault?.getName?.() &&
          app?.plugins?.plugins?.yolo
        );
      `)
      if (ready) return
    } catch {
      // The renderer may rebuild once while Obsidian opens the configured vault.
    }
    await sleep(200)
  }
  throw new Error('Agent Obsidian did not finish loading its vault and YOLO')
}

async function cloak() {
  return await evaluate(`
    const remote = require('@electron/remote');
    const win = remote.getCurrentWindow();
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.setFocusable(false);
    remote.app.dock?.hide();
    win.showInactive();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      vault: app.vault.getName(),
      yoloLoaded: Boolean(app.plugins.plugins.yolo),
      visible: win.isVisible(),
      opacity: win.getOpacity(),
      focused: win.isFocused(),
      bounds: win.getBounds(),
      pageVisibility: document.visibilityState,
      raf: 'running',
      port: ${port},
    };
  `)
}

async function reveal() {
  return await evaluate(`
    const remote = require('@electron/remote');
    const win = remote.getCurrentWindow();
    remote.app.dock?.show();
    win.setOpacity(1);
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.show();
    win.focus();
    return { visible: win.isVisible(), opacity: win.getOpacity(), bounds: win.getBounds() };
  `)
}

async function status() {
  return await evaluate(`
    const remote = require('@electron/remote');
    const win = remote.getCurrentWindow();
    const raf = await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => resolve('running'))),
      new Promise((resolve) => setTimeout(() => resolve('stopped'), 1000)),
    ]);
    return {
      pid: remote.process.pid,
      vault: app.vault.getName(),
      files: app.vault.getFiles().length,
      yoloLoaded: Boolean(app.plugins.plugins.yolo),
      visible: win.isVisible(),
      opacity: win.getOpacity(),
      focused: win.isFocused(),
      bounds: win.getBounds(),
      pageVisibility: document.visibilityState,
      raf,
      port: ${port},
    };
  `)
}

async function start() {
  await Promise.all([
    access(path.join(profileDir, 'obsidian.json')),
    access(path.join(pluginDir, 'manifest.json')),
  ])

  let isRunning = false
  try {
    await pickMainTarget()
    isRunning = true
  } catch {
    // Start a fresh isolated instance below when no CDP target exists.
  }
  if (isRunning) {
    await cloak()
    await waitForWorkspace()
    return await status()
  }

  let hideInFlight = false
  const hideTimer = setInterval(() => {
    if (hideInFlight) return
    hideInFlight = true
    void hideApplicationProcess().finally(() => {
      hideInFlight = false
    })
  }, 50)

  try {
    const child = spawn(
      'open',
      [
        '-g',
        '-j',
        '-n',
        '-a',
        appName,
        '--args',
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
      ],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
    await waitForAgent()
    await hideApplicationProcess()
    await cloak()
    await waitForWorkspace()
    return await status()
  } finally {
    clearInterval(hideTimer)
  }
}

async function stop() {
  const pid = await findAgentPid()
  if (!pid) return { stopped: false, reason: 'not-running' }
  process.kill(pid, 'SIGTERM')
  return { stopped: true, pid }
}

async function syncArtifacts({ once }) {
  await access(path.join(pluginDir, 'manifest.json'))
  const child = spawn(
    process.execPath,
    [
      path.join(scriptDir, 'sync-dev-artifacts.mjs'),
      ...(once ? ['--once'] : []),
    ],
    {
      cwd: projectDir,
      env: { ...process.env, OBSIDIAN_PLUGIN_DIR: pluginDir },
      stdio: 'inherit',
    },
  )
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))
  if (exitCode !== 0) process.exitCode = exitCode ?? 1
}

const command = process.argv[2] || 'status'

try {
  let result
  switch (command) {
    case 'start':
      result = await start()
      break
    case 'status':
      result = await status()
      break
    case 'cloak':
      result = await cloak()
      break
    case 'reveal':
      result = await reveal()
      break
    case 'stop':
      result = await stop()
      break
    case 'sync':
      await syncArtifacts({ once: false })
      break
    case 'sync-once':
      await syncArtifacts({ once: true })
      break
    default:
      throw new Error(
        'Usage: obsidian-agent.mjs <start|status|cloak|reveal|stop|sync|sync-once>',
      )
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(`[obsidian-agent] ${error?.message || error}`)
  process.exit(1)
}
