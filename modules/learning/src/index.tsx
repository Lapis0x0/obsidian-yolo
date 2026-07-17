import React, { useEffect, useState } from 'react'

const MODULE_ID = 'learning'
const VIEW_TYPE = 'yolo-learning-module-preview'

function LearningModulePreview({ host }: { host: YoloModuleHostApiV1 }) {
  const [contentRoot, setContentRoot] = useState(
    () => host.paths.getSnapshot().contentRoot,
  )

  useEffect(() => {
    const refresh = () => setContentRoot(host.paths.getSnapshot().contentRoot)
    const unsubscribe = host.paths.subscribe(refresh)
    refresh()
    return unsubscribe
  }, [host])

  return (
    <LearningContentPreview
      key={contentRoot}
      host={host}
      contentRoot={contentRoot}
    />
  )
}

function LearningContentPreview({
  host,
  contentRoot,
}: {
  host: YoloModuleHostApiV1
  contentRoot: string
}) {
  const [snapshot, setSnapshot] = useState(() =>
    scanLearningContent(host, contentRoot),
  )

  useEffect(() => {
    const refresh = () => setSnapshot(scanLearningContent(host, contentRoot))
    const unsubscribe = host.vault.subscribe(contentRoot, refresh)
    refresh()
    return unsubscribe
  }, [contentRoot, host])

  return (
    <main data-yolo-module={MODULE_ID}>
      <h2>Learning module preview</h2>
      <p>This view is running from an independently loaded module artifact.</p>
      <dl>
        <dt>Managed content root</dt>
        <dd>{contentRoot}</dd>
        <dt>Existing projects</dt>
        <dd>{snapshot.projectCount}</dd>
        <dt>Learning Markdown files</dt>
        <dd>{snapshot.markdownFileCount}</dd>
      </dl>
    </main>
  )
}

function scanLearningContent(host: YoloModuleHostApiV1, contentRoot: string) {
  const root = host.vault.getEntry(contentRoot)
  const projectFolders =
    root?.kind === 'folder'
      ? host.vault
          .listChildren(root.path)
          .filter(
            (entry) =>
              entry.kind === 'folder' &&
              host.vault
                .listChildren(entry.path)
                .some(
                  (child) => child.kind === 'file' && child.name === 'index.md',
                ),
          )
      : []
  return {
    projectCount: projectFolders.length,
    markdownFileCount: host.vault
      .listMarkdownFiles()
      .filter(
        (file) =>
          file.path === contentRoot || file.path.startsWith(`${contentRoot}/`),
      ).length,
  }
}

yolo.registerModule({
  id: MODULE_ID,
  activate(host) {
    host.workspace.registerView({
      type: VIEW_TYPE,
      name: 'Learning module preview',
      icon: 'graduation-cap',
      render: () => <LearningModulePreview host={host} />,
    })
    host.workspace.registerRibbonAction({
      icon: 'graduation-cap',
      title: 'Open Learning module preview',
      onClick: () => {
        void host.workspace.openView().catch((error) => {
          console.error('Learning module preview failed to open', error)
        })
      },
    })
    host.workspace.registerCommand({
      id: 'open-preview',
      name: 'Open Learning module preview',
      callback: () => host.workspace.openView(),
    })
  },
})
