import React, { useState, useRef, useCallback } from 'react'
import { SourceSection, CanvasBlock } from '../types'
import { SourcePreviewFrame } from './SourcePreviewFrame'
import { EditableSourceFrame, type SelectedNode } from './EditableSourceFrame'
import { NodeInspector } from './NodeInspector'

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
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null)
  const iframeRefs = useRef<Map<number, HTMLIFrameElement>>(new Map())

  const handleDragStart = (i: number) => { dragRef.current = i; setDragIndex(i) }
  const handleDragOver = (e: React.DragEvent, i: number) => { e.preventDefault(); setDragOverIndex(i) }
  const handleDrop = (i: number) => {
    if (dragRef.current !== null && dragRef.current !== i) onMove(dragRef.current, i)
    dragRef.current = null; setDragIndex(null); setDragOverIndex(null)
  }
  const handleDragEnd = () => { dragRef.current = null; setDragIndex(null); setDragOverIndex(null) }

  const handleNodeSelect = useCallback((node: SelectedNode | null) => {
    setSelectedNode(node)
  }, [])

  const handleApplyPatch = useCallback((patch: any) => {
    if (editingIndex === null) return
    const iframe = iframeRefs.current.get(editingIndex)
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'pc:apply-patch', patch }, '*')
    }
  }, [editingIndex])

  const editingItem = editingIndex !== null ? items[editingIndex] : null

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
    <div className="canvas-with-inspector">
      <main className="canvas">
        <div className="canvas-header">
          <h2>Canvas ({items.length} blocks)</h2>
          {editingIndex !== null && (
            <button className="inspector-btn" onClick={() => { setEditingIndex(null); setSelectedNode(null) }}>
              編集を閉じる
            </button>
          )}
        </div>
        <div className="canvas-blocks">
          {items.map((item, i) => (
            <div
              key={item.canvas.id}
              className={`canvas-block ${dragIndex === i ? 'dragging' : ''} ${dragOverIndex === i ? 'drag-over' : ''} ${editingIndex === i ? 'editing' : ''}`}
              draggable={editingIndex === null}
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
                  <button
                    className={`edit-btn ${editingIndex === i ? 'active' : ''}`}
                    onClick={() => {
                      setEditingIndex(editingIndex === i ? null : i)
                      setSelectedNode(null)
                    }}
                  >
                    {editingIndex === i ? '閉じる' : '編集'}
                  </button>
                  <button className="move-btn" onClick={() => i > 0 && onMove(i, i - 1)} disabled={i === 0}>&#9650;</button>
                  <button className="move-btn" onClick={() => i < items.length - 1 && onMove(i, i + 1)} disabled={i === items.length - 1}>&#9660;</button>
                  <button className="canvas-remove-btn" onClick={() => onRemove(item.canvas.id)}>&times;</button>
                </div>
              </div>
              <div className="canvas-block-preview">
                {editingIndex === i ? (
                  <EditableSourceFrame
                    sectionId={item.section.id}
                    maxHeight={800}
                    onNodeSelect={handleNodeSelect}
                  />
                ) : (
                  <SourcePreviewFrame
                    htmlUrl={item.section.htmlUrl}
                    maxHeight={600}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </main>

      {editingIndex !== null && editingItem && (
        <NodeInspector
          sectionId={editingItem.section.id}
          selectedNode={selectedNode}
          onApplyPatch={handleApplyPatch}
          patchSetId={null}
        />
      )}
    </div>
  )
}
