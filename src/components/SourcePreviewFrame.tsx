/**
 * SourcePreviewFrame — QA用の読み取り専用プレビュー。
 * iframe 内部は常に1440px幅でレンダリングし、コンテナに合わせて縮小表示。
 */
import React, { useRef, useEffect, useState, useCallback } from 'react'

const DEFAULT_RENDER_WIDTH = 1440

interface Props {
  htmlUrl?: string | null
  maxHeight?: number
  scale?: number
  renderWidth?: number
}

export function SourcePreviewFrame({ htmlUrl, maxHeight, scale, renderWidth }: Props) {
  const RENDER_WIDTH = renderWidth || DEFAULT_RENDER_WIDTH
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const frameIdRef = useRef(`pc-preview-${Math.random().toString(36).slice(2)}`)
  const [height, setHeight] = useState(300)
  const [containerWidth, setContainerWidth] = useState(0)

  const updateHeight = useCallback((nextHeight: number) => {
    if (!nextHeight || nextHeight <= 0) return
    setHeight(Math.min(nextHeight, maxHeight || 10000))
  }, [maxHeight])

  const measureHeight = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument || iframeRef.current?.contentWindow?.document
      if (!doc?.documentElement) return
      updateHeight(
        Math.max(
          doc.documentElement.scrollHeight,
          doc.body?.scrollHeight || 0
        )
      )
    } catch {
      // cross-origin: ignore
    }
  }, [updateHeight])

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
    const handler = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (!e.data || e.data.type !== 'partcopy-preview-height') return
      if (e.data.frameId !== frameIdRef.current) return
      if (typeof e.data.height !== 'number') return
      updateHeight(e.data.height)
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [updateHeight])

  useEffect(() => {
    setHeight(300)
  }, [htmlUrl])

  const handleLoad = useCallback(() => {
    measureHeight()

    try {
      const iframe = iframeRef.current
      const doc = iframe?.contentDocument || iframe?.contentWindow?.document
      if (!doc?.body) return

      const existing = doc.getElementById('__partcopy_preview_height_bridge__')
      if (existing) existing.remove()

      const script = doc.createElement('script')
      script.id = '__partcopy_preview_height_bridge__'
      script.textContent = `
        (function() {
          var frameId = ${JSON.stringify(frameIdRef.current)};
          var lastHeight = 0;
          function sendHeight() {
            var nextHeight = Math.max(
              document.documentElement.scrollHeight || 0,
              document.body ? document.body.scrollHeight : 0
            );
            if (!nextHeight || nextHeight === lastHeight) return;
            lastHeight = nextHeight;
            parent.postMessage({
              type: 'partcopy-preview-height',
              frameId: frameId,
              height: nextHeight
            }, ${JSON.stringify(window.location.origin)});
          }

          if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(sendHeight).observe(document.documentElement);
          }

          document.querySelectorAll('img').forEach(function(img) {
            if (!img.complete) img.addEventListener('load', sendHeight, { once: true });
            img.addEventListener('error', sendHeight, { once: true });
          });

          window.addEventListener('load', sendHeight);
          requestAnimationFrame(sendHeight);

          var checks = 0;
          var interval = setInterval(function() {
            sendHeight();
            checks += 1;
            if (checks >= 20) clearInterval(interval);
          }, 500);
        })();
      `
      doc.body.appendChild(script)
    } catch {
      // cross-origin: ignore
    }
  }, [measureHeight])

  if (!htmlUrl) {
    return null
  }

  const computedScale = scale || (containerWidth > 0 ? containerWidth / RENDER_WIDTH : 0.5)
  const displayHeight = height * computedScale

  return (
    <div ref={containerRef} style={{ overflow: 'hidden', height: displayHeight, position: 'relative' }}>
      <iframe
        ref={iframeRef}
        src={htmlUrl}
        onLoad={handleLoad}
        style={{
          border: 'none',
          width: RENDER_WIDTH,
          height,
          transform: `scale(${computedScale})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
          display: 'block'
        }}
        sandbox="allow-same-origin allow-scripts allow-forms"
        referrerPolicy="no-referrer"
      />
    </div>
  )
}
