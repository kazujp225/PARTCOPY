import React from 'react'
import { SourceSection, CanvasBlock } from '../types'

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
        <span className="preview-label">Screenshot Preview</span>
      </div>
      <div className="preview-screenshots">
        {items.map(item => (
          <div key={item.canvas.id} className="preview-section">
            {item.section.thumbnailUrl ? (
              <img src={item.section.thumbnailUrl} alt={item.section.block_family} className="preview-section-img" />
            ) : (
              <div className="preview-section-placeholder">{item.section.block_family} - No preview</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
