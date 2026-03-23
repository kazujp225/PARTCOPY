import React from 'react'
import { SourceSection, CanvasBlock } from '../types'
import { SourcePreviewFrame } from './SourcePreviewFrame'

interface CanvasItem {
  canvas: CanvasBlock
  section: SourceSection
}

interface Props {
  items: CanvasItem[]
}

export function Preview({ items }: Props) {
  if (items.length === 0) {
    return (
      <div className="preview-container">
        <div className="canvas-empty"><p>Canvasにブロックを追加してください</p></div>
      </div>
    )
  }

  return (
    <div className="preview-container">
      <div className="preview-mode-bar">
        <span className="preview-label">Live Preview</span>
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
