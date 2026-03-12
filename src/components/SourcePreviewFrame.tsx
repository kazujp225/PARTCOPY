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
          setHeight(Math.min(h || 300, maxHeight || 10000))
        }
      } catch {}
    }
    iframe.addEventListener('load', handleLoad)
    return () => iframe.removeEventListener('load', handleLoad)
  }, [htmlUrl, maxHeight])

  if (!htmlUrl) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 100, color: '#8b90a0', fontSize: 14, background: '#f1f3f7' }}>
        No Preview
      </div>
    )
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
        sandbox="allow-same-origin"
      />
    </div>
  )
}
