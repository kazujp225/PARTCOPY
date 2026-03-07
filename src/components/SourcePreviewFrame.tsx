/**
 * SourcePreviewFrame — QA用の読み取り専用プレビュー。
 * Library や分類確認で使用。旧 SectionFrame の役割をそのまま引き継ぐ。
 */
import React, { useRef, useEffect, useState } from 'react'

interface Props {
  htmlUrl?: string | null
  maxHeight?: number
  scale?: number
}

export function SourcePreviewFrame({ htmlUrl, maxHeight, scale }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [srcdoc, setSrcdoc] = useState<string | null>(null)
  const [height, setHeight] = useState(200)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!htmlUrl) return
    setLoading(true)
    fetch(htmlUrl)
      .then(r => r.text())
      .then(html => { setSrcdoc(html); setLoading(false) })
      .catch(() => setLoading(false))
  }, [htmlUrl])

  useEffect(() => {
    if (!iframeRef.current || !srcdoc) return
    const iframe = iframeRef.current
    const handleLoad = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document
        if (doc?.body) setHeight(Math.min(doc.body.scrollHeight, maxHeight || 2000))
      } catch {}
    }
    iframe.addEventListener('load', handleLoad)
    return () => iframe.removeEventListener('load', handleLoad)
  }, [srcdoc, maxHeight])

  if (!htmlUrl) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 100, color: '#8b90a0', fontSize: 14, background: '#f1f3f7' }}>
        No Preview
      </div>
    )
  }

  if (loading || !srcdoc) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: 120, color: '#8b90a0', fontSize: 14, background: '#f8f9fb' }}>
        Loading...
      </div>
    )
  }

  const s = scale || 1
  return (
    <div style={{ overflow: 'hidden', height: s < 1 ? height * s : height, position: 'relative' }}>
      <iframe
        ref={iframeRef}
        srcDoc={srcdoc}
        style={{
          border: 'none',
          width: s < 1 ? `${100 / s}%` : '100%',
          height,
          transform: s < 1 ? `scale(${s})` : undefined,
          transformOrigin: 'top left',
          pointerEvents: 'none',
          display: 'block'
        }}
        sandbox="allow-same-origin"
        loading="lazy"
      />
    </div>
  )
}
