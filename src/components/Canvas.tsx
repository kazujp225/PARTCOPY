import React, { useState, useRef } from 'react'
import { SourceSection, CanvasBlock } from '../types'

const FAMILY_COLORS: Record<string, string> = {
  navigation: '#6366f1', hero: '#3b82f6', feature: '#10b981', social_proof: '#ec4899',
  stats: '#84cc16', pricing: '#8b5cf6', faq: '#14b8a6', content: '#64748b',
  cta: '#f59e0b', contact: '#f97316', recruit: '#06b6d4', footer: '#6b7280',
  news_list: '#a855f7', timeline: '#0ea5e9', company_profile: '#059669',
  gallery: '#06b6d4', logo_cloud: '#a855f7'
}

interface CanvasItem {
  canvas: CanvasBlock
  section: SourceSection
}

interface Props {
  items: CanvasItem[]
  onRemove: (canvasId: string) => void
  onMove: (from: number, to: number) => void
}

export function Canvas({ items, onRemove, onMove }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)

  const handleDragStart = (i: number) => { dragRef.current = i; setDragIndex(i) }
  const handleDragOver = (e: React.DragEvent, i: number) => { e.preventDefault(); setDragOverIndex(i) }
  const handleDrop = (i: number) => {
    if (dragRef.current !== null && dragRef.current !== i) onMove(dragRef.current, i)
    dragRef.current = null; setDragIndex(null); setDragOverIndex(null)
  }
  const handleDragEnd = () => { dragRef.current = null; setDragIndex(null); setDragOverIndex(null) }

  if (items.length === 0) {
    return (
      <main className="canvas">
        <div className="canvas-empty">
          <div className="canvas-empty-icon">&#10010;</div>
          <h3>Canvas</h3>
          <p>左のパーツにホバーして「+ Canvas」で配置</p>
          <p className="canvas-hint">ドラッグ&ドロップで順序変更</p>
        </div>
      </main>
    )
  }

  return (
    <main className="canvas">
      <div className="canvas-header"><h2>Canvas ({items.length} blocks)</h2></div>
      <div className="canvas-blocks">
        {items.map((item, i) => (
          <div
            key={item.canvas.id}
            className={`canvas-block ${dragIndex === i ? 'dragging' : ''} ${dragOverIndex === i ? 'drag-over' : ''}`}
            draggable
            onDragStart={() => handleDragStart(i)}
            onDragOver={e => handleDragOver(e, i)}
            onDrop={() => handleDrop(i)}
            onDragEnd={handleDragEnd}
          >
            <div className="canvas-block-toolbar">
              <span className="drag-handle">&#9776;</span>
              <span className="canvas-block-badge" style={{ background: FAMILY_COLORS[item.section.block_family] || '#94a3b8' }}>
                {item.section.block_family}
              </span>
              <span className="canvas-block-source">
                {item.section.source_sites?.normalized_domain || ''}
              </span>
              <div className="canvas-block-actions">
                <button className="move-btn" onClick={() => i > 0 && onMove(i, i - 1)} disabled={i === 0}>&#9650;</button>
                <button className="move-btn" onClick={() => i < items.length - 1 && onMove(i, i + 1)} disabled={i === items.length - 1}>&#9660;</button>
                <button className="canvas-remove-btn" onClick={() => onRemove(item.canvas.id)}>&times;</button>
              </div>
            </div>
            <div className="canvas-block-preview">
              {item.section.thumbnailUrl ? (
                <img src={item.section.thumbnailUrl} alt={item.section.block_family} className="canvas-block-img" />
              ) : (
                <div className="canvas-block-no-preview">No preview</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
