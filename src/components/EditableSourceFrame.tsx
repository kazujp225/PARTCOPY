/**
 * EditableSourceFrame — Source Edit Mode 用。
 * iframe 内のノードをクリック可能にし、選択ノードを親に通知する。
 * 親からのパッチメッセージを iframe に中継する。
 *
 * 通信は postMessage 経由:
 *   iframe → parent: { type: 'pc:node-click', stableKey, tagName, textContent, rect }
 *   parent → iframe: { type: 'pc:apply-patch', patch: { nodeStableKey, op, payload } }
 */
import React, { useRef, useEffect, useState, useCallback } from 'react'

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
  const [height, setHeight] = useState(400)
  const [loading, setLoading] = useState(true)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [srcdoc, setSrcdoc] = useState<string | null>(null)
  const [error, setError] = useState(false)

  // Fetch editable-render HTML, fallback to normal render
  useEffect(() => {
    if (!sectionId) return
    setLoading(true)
    setError(false)
    setSrcdoc(null)

    fetch(`/api/sections/${sectionId}/editable-render`)
      .then(r => {
        if (!r.ok) throw new Error('No editable snapshot')
        return r.text()
      })
      .then(html => {
        setSrcdoc(html)
        setLoading(false)
      })
      .catch(() => {
        // Fallback: normal render endpoint
        fetch(`/api/sections/${sectionId}/render`)
          .then(r => r.ok ? r.text() : Promise.reject())
          .then(html => {
            setSrcdoc(html)
            setLoading(false)
          })
          .catch(() => {
            setError(true)
            setLoading(false)
          })
      })
  }, [sectionId])

  // iframe からのメッセージ受信
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return

      if (e.data.type === 'pc:node-click') {
        setSelectedKey(e.data.stableKey)
        onNodeSelect?.({
          stableKey: e.data.stableKey,
          tagName: e.data.tagName,
          textContent: e.data.textContent,
          rect: e.data.rect
        })

        // 選択状態をiframe内に反映
        const iframe = iframeRef.current
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'pc:select-node',
            stableKey: e.data.stableKey
          }, '*')
        }
      }

      if (e.data.type === 'pc:patch-applied') {
        // パッチ適用完了 → 高さ再計測
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
        setHeight(Math.min(doc.body.scrollHeight, maxHeight || 3000))
      }
    } catch {}
  }, [maxHeight])

  // iframe ロード完了
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

  return (
    <div style={{ position: 'relative' }}>
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: 200, color: '#8b90a0', fontSize: 14, background: '#f8f9fb' }}>
          Loading editor...
        </div>
      )}
      {srcdoc && (
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          onLoad={handleLoad}
          style={{
            border: 'none',
            width: '100%',
            height,
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
 * コンポーネント外から呼べるように export する。
 */
export function sendPatchToFrame(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  patch: { nodeStableKey: string; op: string; payload: Record<string, any> }
) {
  const iframe = iframeRef.current
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'pc:apply-patch', patch }, '*')
  }
}
