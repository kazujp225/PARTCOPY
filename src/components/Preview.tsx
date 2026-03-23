import React from 'react'
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
  if (items.length === 0) {
    return (
      <div className="preview-container">
        <div className="canvas-empty"><p>Canvasにブロックを追加してください</p></div>
      </div>
    )
  }

  return (
    <div className="preview-container">
      <div className="preview-header">
        <h2>プレビュー</h2>
        {onExportZip && items.length > 0 && (
          <button className="zip-btn primary" onClick={onExportZip} disabled={exporting}>
            {exporting ? '出力中...' : '↓ ZIP ダウンロード'}
          </button>
        )}
      </div>
      <div className="preview-screenshots">
        {items.map(item => (
          <div key={item.canvas.id} className="preview-section">
            <SourcePreviewFrame htmlUrl={item.section.htmlUrl} maxHeight={2000} />
          </div>
        ))}
      </div>
    </div>
  )
}
