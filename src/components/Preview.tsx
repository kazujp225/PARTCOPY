import React, { useState } from 'react'
import { SourceSection, CanvasBlock } from '../types'
import { SourcePreviewFrame } from './SourcePreviewFrame'
import { FAMILY_COLORS, FAMILY_LABELS } from '../constants'

interface CanvasItem {
  canvas: CanvasBlock
  section: SourceSection
}

type ViewMode = 'merged' | 'split'
type DeviceMode = 'desktop' | 'tablet' | 'mobile'

const DEVICE_WIDTHS: Record<DeviceMode, number> = {
  desktop: 1440,
  tablet: 768,
  mobile: 375
}

interface Props {
  items: CanvasItem[]
  onExportZip?: (mode?: 'tsx' | 'screenshot' | 'compose') => void
  exporting?: boolean
  exportProgress?: { message: string; current?: number; total?: number; sectionName?: string; estimate?: string } | null
}

export function Preview({ items, onExportZip, exporting, exportProgress }: Props) {
  const [mode, setMode] = useState<ViewMode>('merged')
  const [device, setDevice] = useState<DeviceMode>('desktop')

  if (items.length === 0) {
    return (
      <div className="preview-container">
        <div className="canvas-empty"><p>Canvasにブロックを追加してください</p></div>
      </div>
    )
  }

  const mergedHtmlUrl = `/api/rawconcat/merged?sections=${encodeURIComponent(
    items.map(item => item.section.id).join(',')
  )}`

  return (
    <div className="preview-container">
      <div className="preview-header">
        <div className="preview-header-main">
          <h2>プレビュー</h2>
          <p className="preview-subtitle">
            {items.length} セクション · 再現用ZIPに含める参照デザインを確認できます
          </p>
        </div>
        {onExportZip && items.length > 0 && (
          <div className="zip-export-group">
            <button className="zip-btn primary" onClick={() => onExportZip?.('tsx')} disabled={exporting}>
              {exporting ? '出力中...' : '↓ TSX ZIP Export'}
            </button>
            <button className="zip-btn" onClick={() => onExportZip?.('screenshot')} disabled={exporting} style={{ marginLeft: 4, fontSize: '0.8em', opacity: 0.7 }}>
              スクショ版
            </button>
            {exporting && exportProgress && (
              <div className="export-progress">
                <span className="export-progress-spinner" />
                <span>{exportProgress.message}{exportProgress.current != null && exportProgress.total != null && ` (${exportProgress.current}/${exportProgress.total})`}</span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="preview-mode-bar">
        <div className="preview-mode-group">
          <button
            className={`preview-mode-btn ${mode === 'merged' ? 'active' : ''}`}
            onClick={() => setMode('merged')}
          >
            統合
          </button>
          <button
            className={`preview-mode-btn ${mode === 'split' ? 'active' : ''}`}
            onClick={() => setMode('split')}
          >
            セクション別
          </button>
        </div>
        <div className="preview-device-group">
          <button
            className={`preview-device-btn ${device === 'desktop' ? 'active' : ''}`}
            onClick={() => setDevice('desktop')}
            title="デスクトップ (1440px)"
          >
            &#9633;
          </button>
          <button
            className={`preview-device-btn ${device === 'tablet' ? 'active' : ''}`}
            onClick={() => setDevice('tablet')}
            title="タブレット (768px)"
          >
            &#9645;
          </button>
          <button
            className={`preview-device-btn ${device === 'mobile' ? 'active' : ''}`}
            onClick={() => setDevice('mobile')}
            title="モバイル (375px)"
          >
            &#9647;
          </button>
        </div>
      </div>
      {mode === 'merged' ? (
        <div className="preview-screenshots" data-device={device}>
          <div className="preview-section">
            <SourcePreviewFrame htmlUrl={mergedHtmlUrl} maxHeight={30000} renderWidth={DEVICE_WIDTHS[device]} />
          </div>
        </div>
      ) : (
        <div className="preview-screenshots" data-device={device}>
          {items.map(item => (
            <div key={item.canvas.id} className="preview-section-split">
              <div className="preview-section-label">
                <span className="preview-section-badge" style={{ background: FAMILY_COLORS[item.section.block_family] || '#94a3b8' }}>
                  {FAMILY_LABELS[item.section.block_family] || item.section.block_family}
                </span>
                <span className="preview-section-domain">{item.section.source_sites?.normalized_domain}</span>
              </div>
              <SourcePreviewFrame htmlUrl={item.section.htmlUrl} maxHeight={2000} renderWidth={DEVICE_WIDTHS[device]} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
