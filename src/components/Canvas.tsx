import React, { useState, useRef, useCallback } from 'react'
import { SourceSection, CanvasBlock } from '../types'
import { SourcePreviewFrame } from './SourcePreviewFrame'
import { EditableSourceFrame, type SelectedNode } from './EditableSourceFrame'
import { NodeInspector } from './NodeInspector'
import { CodeEditor } from './CodeEditor'
import { FAMILY_COLORS } from '../constants'

interface CanvasItem {
  canvas: CanvasBlock
  section: SourceSection
}

interface Props {
  items: CanvasItem[]
  onRemove: (canvasId: string) => void
  onMove: (from: number, to: number) => void
  onViewTsx?: (sectionId: string) => void
  onExportZip?: () => void
  exporting?: boolean
  onSaveProject?: () => void
}

export function Canvas({ items, onRemove, onMove, onViewTsx, onExportZip, exporting, onSaveProject }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [codeEditingIndex, setCodeEditingIndex] = useState<number | null>(null)
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null)
  const iframeRefs = useRef<Map<number, HTMLIFrameElement>>(new Map())
  // プレビュー強制リロード用キー
  const [refreshKeys, setRefreshKeys] = useState<Record<number, number>>({})

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
      iframe.contentWindow.postMessage({ type: 'pc:apply-patch', patch }, window.location.origin)
    }
  }, [editingIndex])

  const handleCodeSaved = useCallback(() => {
    if (codeEditingIndex !== null) {
      setRefreshKeys(prev => ({ ...prev, [codeEditingIndex]: (prev[codeEditingIndex] || 0) + 1 }))
    }
  }, [codeEditingIndex])

  const editingItem = editingIndex !== null ? items[editingIndex] : null
  const codeEditingItem = codeEditingIndex !== null ? items[codeEditingIndex] : null

  if (items.length === 0) {
    return (
      <main className="canvas">
        <div className="canvas-empty">
          <div className="canvas-empty-icon" style={{ fontSize: '3rem' }}>&oplus;</div>
          <h3 style={{ fontSize: '1.25rem', margin: '0.75rem 0 0.5rem' }}>パーツを追加してページを組み立てよう</h3>
          <p style={{ fontSize: '0.95rem' }}>左のパーツにホバーして「+ 追加」ボタンで Canvas に配置できます</p>
          <p className="canvas-hint">ドラッグ&amp;ドロップで順序を変更</p>
        </div>
      </main>
    )
  }

  return (
    <div className="canvas-with-inspector">
      <main className="canvas">
        <div className="canvas-header">
          <h2>Canvas ({items.length} ブロック)</h2>
          <div className="canvas-header-actions">
            {onSaveProject && (
              <button className="save-project-btn" onClick={onSaveProject}>保存</button>
            )}
            {onExportZip && items.length > 0 && (
              <button className="zip-btn primary" onClick={onExportZip} disabled={exporting}>
                {exporting ? '出力中...' : '\u2193 ZIP ダウンロード'}
              </button>
            )}
            {editingIndex !== null && (
              <button className="inspector-btn" onClick={() => { setEditingIndex(null); setSelectedNode(null) }}>
                編集を閉じる
              </button>
            )}
          </div>
        </div>
        <div className="canvas-blocks">
          {items.map((item, i) => {
            const rk = refreshKeys[i] || 0
            const htmlUrlWithKey = item.section.htmlUrl
              ? `${item.section.htmlUrl}${item.section.htmlUrl.includes('?') ? '&' : '?'}v=${rk}`
              : item.section.htmlUrl

            return (
              <div
                key={item.canvas.id}
                className={`canvas-block ${dragIndex === i ? 'dragging' : ''} ${dragOverIndex === i ? 'drag-over' : ''} ${editingIndex === i ? 'editing' : ''}`}
                tabIndex={0}
                role="group"
                aria-label={`ブロック ${i + 1}: ${item.section.block_family}`}
                draggable={editingIndex === null}
                onDragStart={() => handleDragStart(i)}
                onDragOver={e => handleDragOver(e, i)}
                onDrop={() => handleDrop(i)}
                onDragEnd={handleDragEnd}
                onKeyDown={e => {
                  if (e.key === 'Delete' || e.key === 'Backspace') {
                    if (editingIndex === null && document.activeElement === e.currentTarget) {
                      e.preventDefault()
                      onRemove(item.canvas.id)
                    }
                  }
                }}
              >
                <div className="canvas-block-toolbar">
                  <span className="drag-handle" aria-label="ドラッグで並べ替え">&#9776;</span>
                  <span className="canvas-block-badge" style={{ background: FAMILY_COLORS[item.section.block_family] || '#94a3b8' }}>
                    {item.section.block_family}
                  </span>
                  <span className="canvas-block-source">
                    {item.section.source_sites?.normalized_domain || ''}
                  </span>
                  <div className="canvas-block-actions">
                    {item.section.tsx_code_storage_path && onViewTsx && (
                      <button className="tsx-btn" onClick={() => onViewTsx(item.section.id)} title="TSXコード表示">
                        TSX
                      </button>
                    )}
                    <button
                      className="code-btn"
                      onClick={() => setCodeEditingIndex(codeEditingIndex === i ? null : i)}
                      title="HTMLコード編集"
                      aria-label="HTMLコード編集"
                    >
                      &lt;/&gt;
                    </button>
                    <button
                      className={`edit-btn ${editingIndex === i ? 'active' : ''}`}
                      onClick={() => {
                        setEditingIndex(editingIndex === i ? null : i)
                        setSelectedNode(null)
                      }}
                      aria-label={editingIndex === i ? 'ビジュアル編集を閉じる' : 'ビジュアル編集を開く'}
                    >
                      {editingIndex === i ? '閉じる' : '編集'}
                    </button>
                    <button className="move-btn" onClick={() => i > 0 && onMove(i, i - 1)} disabled={i === 0} aria-label="上に移動">&#9650;</button>
                    <button className="move-btn" onClick={() => i < items.length - 1 && onMove(i, i + 1)} disabled={i === items.length - 1} aria-label="下に移動">&#9660;</button>
                    <button className="canvas-remove-btn" onClick={() => onRemove(item.canvas.id)} aria-label="ブロックを削除">&times;</button>
                  </div>
                </div>
                <div className="canvas-block-preview">
                  {editingIndex === i ? (
                    <EditableSourceFrame
                      sectionId={item.section.id}
                      onNodeSelect={handleNodeSelect}
                    />
                  ) : (
                    <SourcePreviewFrame
                      htmlUrl={htmlUrlWithKey}
                    />
                  )}
                </div>
              </div>
            )
          })}
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

      {codeEditingItem && (
        <CodeEditor
          sectionId={codeEditingItem.section.id}
          onClose={() => setCodeEditingIndex(null)}
          onSaved={handleCodeSaved}
        />
      )}
    </div>
  )
}
