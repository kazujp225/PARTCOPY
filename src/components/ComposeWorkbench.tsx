import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { SourcePreviewFrame } from './SourcePreviewFrame'
import type { CanvasBlock, SourceSection } from '../types'

interface CanvasItem {
  canvas: CanvasBlock
  section: SourceSection
}

interface Props {
  items: CanvasItem[]
  projectName?: string
  mode?: 'rawconcat' | 'preserve' | 'styled'
}

const COMPOSE_RENDER_WIDTH = 1440

export function ComposeWorkbench({ items, projectName, mode = 'preserve' }: Props) {
  const ordered = useMemo(() => [...items].sort((a, b) => a.canvas.position - b.canvas.position), [items])

  const sectionIds = useMemo(() => ordered.map((item) => item.section.id), [ordered])
  const composeMergedUrl = useMemo(() => {
    if (sectionIds.length === 0) return null
    // preserve と rawconcat は個別iframe方式なのでマージURLは不要
    if (mode === 'rawconcat' || mode === 'preserve') return null
    return `/api/compose/merged?sections=${encodeURIComponent(sectionIds.join(','))}`
  }, [sectionIds, mode])

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [iframeHeight, setIframeHeight] = useState(600)
  const [containerWidth, setContainerWidth] = useState(0)
  const [loading, setLoading] = useState(true)

  // Track container width for scaling
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Measure iframe content height
  const measureHeight = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument || iframeRef.current?.contentWindow?.document
      if (doc?.documentElement) {
        const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0)
        if (h > 0) setIframeHeight(h)
      }
    } catch {
      // cross-origin fallback
    }
  }, [])

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data && e.data.type === 'partcopy-iframe-height' && typeof e.data.height === 'number') {
        setIframeHeight(e.data.height)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  useEffect(() => {
    if (composeMergedUrl) setLoading(true)
  }, [composeMergedUrl])

  const handleIframeLoad = useCallback(() => {
    setLoading(false)
    measureHeight()

    try {
      const iframe = iframeRef.current
      const doc = iframe?.contentDocument || iframe?.contentWindow?.document
      if (doc?.body) {
        const script = doc.createElement('script')
        script.textContent = `
          (function() {
            var lastH = 0;
            function send() {
              var h = Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight
              );
              if (h !== lastH && h > 0) {
                lastH = h;
                parent.postMessage({ type: 'partcopy-iframe-height', height: h }, '*');
              }
            }
            new ResizeObserver(send).observe(document.documentElement);
            document.querySelectorAll('img').forEach(function(img) {
              if (!img.complete) img.addEventListener('load', send);
              img.addEventListener('error', send);
            });
            var checks = 0;
            var iv = setInterval(function() {
              send();
              if (++checks >= 20) clearInterval(iv);
            }, 500);
          })();
        `
        doc.body.appendChild(script)
      }
    } catch {
      // cross-origin fallback
    }
  }, [measureHeight])

  const computedScale = containerWidth > 0 ? Math.min(containerWidth / COMPOSE_RENDER_WIDTH, 1) : 1
  const displayHeight = iframeHeight * computedScale

  const modeLabel = mode === 'rawconcat' ? 'Raw Concat' : mode === 'preserve' ? 'Preserve Compose' : 'Styled Compose'
  const modeDescription = mode === 'rawconcat'
    ? 'Sourceの見た目を一切変えずにそのまま縦連結します。'
    : mode === 'preserve'
    ? '元サイトの断片をそのまま縦連結します。内部デザインは一切変更しません。'
    : 'Panasonicアンカースタイルで再構成したページを表示します。'

  // ── Preserve: 個別iframeをシームレスに縦連結（CSS完全分離で忠実表示）──
  if (mode === 'preserve') {
    return (
      <div className="compose-workbench">
        <div className="compose-workbench-header">
          <div>
            <div className="compose-kicker">{modeLabel}</div>
            <h3>{projectName || 'Compose Project'}</h3>
            <p>各セクションの元デザインを完全に保ったまま1ページとして表示します。</p>
          </div>
          <div className="compose-meta">
            <span>{items.length} ブロック</span>
            <span>忠実表示</span>
          </div>
        </div>

        <div className="preserve-seamless-sections">
          {ordered.map((item) => (
            <div key={item.canvas.id} className="preserve-seamless-block">
              <SourcePreviewFrame htmlUrl={item.section.htmlUrl} maxHeight={10000} />
            </div>
          ))}
        </div>

        <div className="compose-provenance-list">
          {ordered.map((item, i) => (
            <div key={item.canvas.id} className="compose-provenance-item">
              <span className="compose-provenance-index">{String(i + 1).padStart(2, '0')}</span>
              <span className="compose-provenance-family">{item.section.block_family}</span>
              <span className="compose-provenance-domain">
                {item.section.source_sites?.normalized_domain || '—'}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ── Raw Concat: セクションごとに個別iframeで表示（デバッグ用ラベル付き）──
  if (mode === 'rawconcat') {
    return (
      <div className="compose-workbench">
        <div className="compose-workbench-header">
          <div>
            <div className="compose-kicker">{modeLabel}</div>
            <h3>{projectName || 'Compose Project'}</h3>
            <p>{modeDescription}</p>
          </div>
          <div className="compose-meta">
            <span>{items.length} ブロック</span>
            <span>無加工連結</span>
          </div>
        </div>

        <div className="rawconcat-sections">
          {ordered.map((item, i) => {
            const htmlUrl = item.section.htmlUrl
            return (
              <div key={item.canvas.id} className="rawconcat-section-block">
                <SourcePreviewFrame htmlUrl={htmlUrl} maxHeight={10000} />
                <div className="compose-provenance-item">
                  <span className="compose-provenance-index">{String(i + 1).padStart(2, '0')}</span>
                  <span className="compose-provenance-family">{item.section.block_family}</span>
                  <span className="compose-provenance-domain">
                    {item.section.source_sites?.normalized_domain || '—'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Styled: 従来のマージiframe方式（正規化CSS適用）──
  return (
    <div className="compose-workbench">
      <div className="compose-workbench-header">
        <div>
          <div className="compose-kicker">{modeLabel}</div>
          <h3>{projectName || 'Compose Project'}</h3>
          <p>{modeDescription}</p>
        </div>
        <div className="compose-meta">
          <span>{items.length} ブロック</span>
          <span>スタイル適用</span>
          <span>Compose ZIP連動</span>
        </div>
      </div>

      <section className="compose-live-stage compose-live-stage--full">
        <div className="compose-live-stage-head">
          <strong>{modeLabel} Output Preview</strong>
          <span>この表示がそのまま Compose ZIP に出力されます</span>
        </div>

        <div className="compose-live-stage-frame" ref={containerRef}>
          {composeMergedUrl ? (
            <>
              {loading && (
                <div className="compose-stitch-fallback" style={{ minHeight: 200 }}>
                  読み込み中…
                </div>
              )}
              <div style={{ overflow: 'hidden', height: displayHeight, position: 'relative' }}>
                <iframe
                  ref={iframeRef}
                  src={composeMergedUrl}
                  onLoad={handleIframeLoad}
                  style={{
                    border: 'none',
                    width: COMPOSE_RENDER_WIDTH,
                    height: iframeHeight,
                    transform: computedScale < 1 ? `scale(${computedScale})` : undefined,
                    transformOrigin: 'top left',
                    pointerEvents: 'none',
                    display: loading ? 'none' : 'block',
                  }}
                  sandbox="allow-same-origin allow-scripts"
                  referrerPolicy="no-referrer"
                />
              </div>
            </>
          ) : (
            <div className="compose-stitch-fallback">
              Canvas にブロックを追加してください
            </div>
          )}
        </div>
      </section>

      <div className="compose-provenance-list">
        {ordered.map((item, i) => (
          <div key={item.canvas.id} className="compose-provenance-item">
            <span className="compose-provenance-index">{String(i + 1).padStart(2, '0')}</span>
            <span className="compose-provenance-family">{item.section.block_family}</span>
            <span className="compose-provenance-domain">
              {item.section.source_sites?.normalized_domain || '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
