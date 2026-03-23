/**
 * SourcePreviewFrame — QA用の読み取り専用プレビュー。
 * iframe 内部は常に1440px幅でレンダリングし、コンテナに合わせて縮小表示。
 * これによりメディアクエリがデスクトップ判定になる。
 */
import React, { useRef, useEffect, useState } from 'react'

const DESKTOP_WIDTH = 1440

interface Props {
  htmlUrl?: string | null
  maxHeight?: number
  scale?: number
}

export function SourcePreviewFrame({ htmlUrl, maxHeight, scale }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(300)
  const [containerWidth, setContainerWidth] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)

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

  useEffect(() => {
    if (!iframeRef.current || !htmlUrl) return
    const iframe = iframeRef.current
    const handleLoad = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document
        if (doc?.body) {
          const h = doc.body.scrollHeight
          const text = doc.body.textContent || ''
          // コンテンツが壊れているか判定
          if (h < 10 || text.includes('Section not found') || text.includes('not found') || text.trim().length < 5) {
            setLoadFailed(true)
            return
          }
          setLoadFailed(false)
          setHeight(Math.min(h || 300, maxHeight || 10000))
        }
      } catch {
        setLoadFailed(true)
      }
    }
    iframe.addEventListener('load', handleLoad)
    return () => iframe.removeEventListener('load', handleLoad)
  }, [htmlUrl, maxHeight])

  if (!htmlUrl || loadFailed) {
    return null
  }

  // 明示的な scale が指定されていればそれを使う。なければコンテナ幅から算出
  const computedScale = scale || (containerWidth > 0 ? containerWidth / DESKTOP_WIDTH : 0.5)
  const displayHeight = height * computedScale

  return (
    <div ref={containerRef} style={{ overflow: 'hidden', height: displayHeight, position: 'relative' }}>
      <iframe
        ref={iframeRef}
        src={htmlUrl}
        style={{
          border: 'none',
          width: DESKTOP_WIDTH,
          height,
          transform: `scale(${computedScale})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
          display: 'block'
        }}
        sandbox="allow-same-origin allow-scripts"
        referrerPolicy="no-referrer"
      />
    </div>
  )
}
