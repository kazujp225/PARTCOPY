import React, { useState } from 'react'
import { SourceSection, CanvasBlock } from '../types'
import { SourcePreviewFrame } from './SourcePreviewFrame'

interface CanvasItem {
  canvas: CanvasBlock
  section: SourceSection
}

interface Props {
  items: CanvasItem[]
  onExportZip?: () => void
  exporting?: boolean
}

export function Preview({ items, onExportZip, exporting }: Props) {
  const [mode, setMode] = useState<'merged' | 'split'>('merged')

  if (items.length === 0) {
    return (
      <div className="preview-container">
        <div className="canvas-empty"><p>Canvasにブロックを追加してください</p></div>
      </div>
    )
  }

  const mergedHtmlUrl = `/api/preview/merged?sections=${encodeURIComponent(
    items.map(item => item.section.id).join(',')
  )}`

  return (
    <div className="preview-container">
      <div className="preview-header">
        <div className="preview-header-main">
          <h2>プレビュー</h2>
          <p className="preview-subtitle">
            統合プレビューは ZIP 出力に近い見た目で確認できます
          </p>
        </div>
        {onExportZip && items.length > 0 && (
          <button className="zip-btn primary" onClick={onExportZip} disabled={exporting}>
            {exporting ? '出力中...' : '↓ ZIP ダウンロード'}
          </button>
        )}
      </div>
      <div className="preview-mode-bar">
        <button
          className={`preview-mode-btn ${mode === 'merged' ? 'active' : ''}`}
          onClick={() => setMode('merged')}
        >
          統合プレビュー
        </button>
        <button
          className={`preview-mode-btn ${mode === 'split' ? 'active' : ''}`}
          onClick={() => setMode('split')}
        >
          セクション別
        </button>
      </div>
      {mode === 'merged' ? (
        <div className="preview-screenshots">
          <div className="preview-section">
            <SourcePreviewFrame htmlUrl={mergedHtmlUrl} maxHeight={30000} />
          </div>
        </div>
      ) : (
        <div className="preview-screenshots">
          {items.map(item => (
            <div key={item.canvas.id} className="preview-section">
              <SourcePreviewFrame htmlUrl={item.section.htmlUrl} maxHeight={2000} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
