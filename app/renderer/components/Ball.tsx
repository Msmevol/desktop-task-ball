import { useEffect, useRef, useState } from 'react'
import type { Run, MainEvent } from '@shared/types'
import type { IpcResult } from '@shared/types'

/**
 * 极简独立组件：不共享 StoreProvider（球是独立窗口）。
 * 直接用 window.api 轮询一次 + 订阅事件。
 */
export function Ball() {
  const [running, setRunning] = useState(false)
  const [unread, setUnread] = useState(0)
  const dragRef = useRef<{
    active: boolean
    moved: boolean
    startX: number
    startY: number
    offsetX: number
    offsetY: number
  }>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0
  })

  const refresh = async () => {
    try {
      const r = (await window.api.runs.list({ limit: 20 })) as IpcResult<Run[]>
      if (r.ok) {
        setRunning(r.data.some((x) => x.stage === 'running'))
      }
      const u = (await window.api.notifications.unreadCount()) as IpcResult<number>
      if (u.ok) setUnread(u.data)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refresh()
    const off = window.api.events.on((e: MainEvent) => {
      if (
        e.type === 'run:started' ||
        e.type === 'run:finished' ||
        e.type === 'notification:new'
      ) {
        refresh()
      }
    })
    const t = setInterval(refresh, 5000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    const onMove = async (e: MouseEvent) => {
      const s = dragRef.current
      if (!s.active) return
      const movedDistance = Math.hypot(e.screenX - s.startX, e.screenY - s.startY)
      if (movedDistance > 3) s.moved = true
      await window.api.ball.setPosition(e.screenX - s.offsetX, e.screenY - s.offsetY)
    }
    const onUp = async () => {
      const s = dragRef.current
      if (!s.active) return
      const clickWithoutMove = !s.moved
      dragRef.current = { ...s, active: false, moved: false }
      if (clickWithoutMove) {
        await window.api.panel.toggle()
      } else {
        await window.api.ball.snapToEdge()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const color = running ? 'rgb(var(--accent))' : 'rgb(var(--ink-faint))'

  return (
    <div
      aria-label="切换面板"
      title="左键单击切换面板，左键按住拖动，右键打开菜单"
      style={{
        width: '64px',
        height: '64px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
      onMouseDown={async (e) => {
        if (e.button !== 0) return
        const r = (await window.api.ball.getBounds()) as IpcResult<{
          x: number
          y: number
          width: number
          height: number
        } | null>
        if (!r.ok || !r.data) return
        dragRef.current = {
          active: true,
          moved: false,
          startX: e.screenX,
          startY: e.screenY,
          offsetX: e.screenX - r.data.x,
          offsetY: e.screenY - r.data.y
        }
      }}
    >
      <div
        style={{
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          background: color,
          opacity: 0.92,
          boxShadow: `0 8px 16px rgba(0,0,0,0.35), 0 0 10px ${color}66, 0 0 20px ${color}33`,
          border: '1px solid rgba(255,255,255,0.12)',
          transition: 'all 0.22s',
          animation: running ? 'ball-pulse 1.2s ease-in-out infinite' : 'none',
          WebkitAppRegion: 'no-drag',
          position: 'relative'
        } as React.CSSProperties}
      >
        {unread > 0 && (
          <div
            style={{
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              minWidth: '18px',
              height: '18px',
              padding: '0 4px',
              borderRadius: '9px',
              background: 'rgb(var(--danger))',
              color: '#fff',
              fontSize: '10px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1
            }}
          >
            {unread > 99 ? '99+' : unread}
          </div>
        )}
      </div>
      <style>{`
        @keyframes ball-pulse {
          0%, 100% { transform: scale(1); opacity: 0.85; }
          50% { transform: scale(1.12); opacity: 1; }
        }
      `}</style>
    </div>
  )
}
