import React, { useEffect, useState } from 'react'

const VIEW_TYPE = 'yolo-host-api-conformance'
const RIBBON_EVENT = 'yolo:host-api-conformance:ribbon'

function ConformanceView() {
  const [ribbonClicks, setRibbonClicks] = useState(0)

  useEffect(() => {
    const onRibbonClick = () => setRibbonClicks((count) => count + 1)
    window.addEventListener(RIBBON_EVENT, onRibbonClick)
    return () => window.removeEventListener(RIBBON_EVENT, onRibbonClick)
  }, [])

  return (
    <main data-yolo-module="host-api-conformance">
      <h2>Host API conformance</h2>
      <p>Shared React hooks are active.</p>
      <p>Ribbon actions observed: {ribbonClicks}</p>
    </main>
  )
}

yolo.registerModule({
  id: 'host-api-conformance',
  activate(host) {
    const marker = { active: true }
    host.lifecycle.add(() => {
      marker.active = false
    })
    host.workspace.registerView({
      type: VIEW_TYPE,
      name: 'Host API conformance',
      icon: 'flask-conical',
      render: () => <ConformanceView />,
    })
    host.workspace.registerRibbonAction({
      icon: 'flask-conical',
      title: 'Test YOLO module host API',
      onClick: () => {
        if (marker.active) window.dispatchEvent(new Event(RIBBON_EVENT))
      },
    })
  },
})
