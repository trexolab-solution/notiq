import { useState, useEffect } from 'react'
import { Minus, X } from 'lucide-react'
import { appWin } from '../../lib/tauriWindow'
import { Tooltip } from '../ui/Tooltip'

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
      stroke="currentColor" strokeWidth="1.2">
      <rect x="1" y="1" width="8" height="8" />
    </svg>
  )
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
      stroke="currentColor" strokeWidth="1.2">
      <rect x="0" y="3" width="7" height="7" />
      <path d="M3 3V1h6v6H7" />
    </svg>
  )
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!appWin) return
    const win = appWin!

    win.isMaximized().then(setMaximized)

    let unlisten: (() => void) | undefined
    win.onResized(() => { win.isMaximized().then(setMaximized) })
      .then(fn => { unlisten = fn })

    return () => { unlisten?.() }
  }, [])

  if (!appWin) return null
  const win = appWin

  return (
    <div className="win-controls">
      <Tooltip content="Minimize" delay={800}>
        <button className="win-btn" aria-label="Minimize" onClick={() => win.minimize()}>
          <Minus size={10} strokeWidth={1.8} />
        </button>
      </Tooltip>
      <Tooltip content={maximized ? 'Restore Down' : 'Maximize'} delay={800}>
        <button className="win-btn" aria-label={maximized ? 'Restore Down' : 'Maximize'} onClick={() => win.toggleMaximize()}>
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
      </Tooltip>
      <Tooltip content="Close" delay={800}>
        <button className="win-btn win-btn--close" aria-label="Close" onClick={() => win.hide()}>
          <X size={11} strokeWidth={1.8} />
        </button>
      </Tooltip>
    </div>
  )
}
