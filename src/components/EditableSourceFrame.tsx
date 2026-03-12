/**
 * EditableSourceFrame — Source Edit Mode 用。
 * iframe 内部は常に1440px幅でレンダリングし、コンテナに合わせて縮小表示。
 * iframe 内のノードをクリック可能にし、選択ノードを親に通知する。
 *
 * 通信は postMessage 経由:
 *   iframe → parent: { type: 'pc:node-click', stableKey, tagName, textContent, rect }
 *   parent → iframe: { type: 'pc:apply-patch', patch: { nodeStableKey, op, payload } }
 */
import React, { useRef, useEffect, useState, useCallback } from 'react'

const DESKTOP_WIDTH = 1440

export interface SelectedNode {
  stableKey: string
  tagName: string
  textContent: string
  rect: DOMRect
}

interface Props {
  sectionId: string
  maxHeight?: number
  onNodeSelect?: (node: SelectedNode | null) => void
}

export function EditableSourceFrame({ sectionId, maxHeight, onNodeSelect }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(400)
  const [containerWidth, setContainerWidth] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)

  // コンテナ幅を監視
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Determine which URL to use
  useEffect(() => {
    if (!sectionId) return
    setLoading(true)
    setError(false)
    setIframeSrc(null)

    fetch(`/api/sections/${sectionId}/editable-render`, { method: 'HEAD' })
      .then(r => {
        if (r.ok) {
          setIframeSrc(`/api/sections/${sectionId}/editable-render`)
        } else {
          setIframeSrc(`/api/sections/${sectionId}/render`)
        }
      })
      .catch(() => {
        setIframeSrc(`/api/sections/${sectionId}/render`)
      })
  }, [sectionId])

  // iframe からのメッセージ受信
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (!e.data || typeof e.data !== 'object') return

      if (e.data.type === 'pc:node-click') {
        setSelectedKey(e.data.stableKey)
        onNodeSelect?.({
          stableKey: e.data.stableKey,
          tagName: e.data.tagName,
          textContent: e.data.textContent,
          rect: e.data.rect
        })

        const iframe = iframeRef.current
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'pc:select-node',
            stableKey: e.data.stableKey
          }, window.location.origin)
        }
      }

      if (e.data.type === 'pc:patch-applied') {
        setTimeout(recalcHeight, 100)
      }
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onNodeSelect])

  const recalcHeight = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document
      if (doc?.body) {
        setHeight(Math.min(doc.body.scrollHeight, maxHeight || 10000))
      }
    } catch {}
  }, [maxHeight])

  const handleLoad = useCallback(() => {
    setLoading(false)
    recalcHeight()
  }, [recalcHeight])

  if (!sectionId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 200, color: '#8b90a0', fontSize: 14, background: '#f8f9fb' }}>
        セクションを選択してください
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 200, color: '#8b90a0', fontSize: 14, background: '#f8f9fb' }}>
        プレビューを読み込めませんでした
      </div>
    )
  }

  const computedScale = containerWidth > 0 ? containerWidth / DESKTOP_WIDTH : 0.5
  const displayHeight = height * computedScale

  return (
    <div ref={containerRef} style={{ position: 'relative', overflow: 'hidden', height: loading ? 200 : displayHeight }}>
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: 200, color: '#8b90a0', fontSize: 14, background: '#f8f9fb' }}>
          Loading editor...
        </div>
      )}
      {iframeSrc && (
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          onLoad={handleLoad}
          style={{
            border: 'none',
            width: DESKTOP_WIDTH,
            height,
            transform: `scale(${computedScale})`,
            transformOrigin: 'top left',
            display: loading ? 'none' : 'block'
          }}
          sandbox="allow-same-origin allow-scripts"
        />
      )}
    </div>
  )
}

/**
 * iframe にパッチを送信するヘルパー。
 */
export function sendPatchToFrame(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  patch: { nodeStableKey: string; op: string; payload: Record<string, any> }
) {
  const iframe = iframeRef.current
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'pc:apply-patch', patch }, window.location.origin)
  }
}
