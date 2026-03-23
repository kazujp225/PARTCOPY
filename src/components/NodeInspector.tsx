/**
 * NodeInspector — 選択されたノードの編集パネル。
 * テキスト、リンク、画像、スタイルトークンの編集 → パッチ生成。
 */
import React, { useState, useEffect, useCallback } from 'react'
import type { SelectedNode } from './EditableSourceFrame'

interface NodeDetail {
  id: string
  stable_key: string
  node_type: string
  tag_name: string
  text_content: string | null
  attrs_jsonb: Record<string, string>
  computed_style_jsonb: Record<string, string>
}

interface Patch {
  nodeStableKey: string
  op: string
  payload: Record<string, any>
}

interface Props {
  sectionId: string
  selectedNode: SelectedNode | null
  onApplyPatch: (patch: Patch) => void
  patchSetId: string | null
}

export function NodeInspector({ sectionId, selectedNode, onApplyPatch, patchSetId }: Props) {
  const [nodeDetail, setNodeDetail] = useState<NodeDetail | null>(null)
  const [editText, setEditText] = useState('')
  const [editHref, setEditHref] = useState('')
  const [editSrc, setEditSrc] = useState('')
  const [editAlt, setEditAlt] = useState('')
  const [pendingPatches, setPendingPatches] = useState<Patch[]>([])

  // ノード選択時にDBからノード詳細を取得
  useEffect(() => {
    if (!selectedNode) { setNodeDetail(null); return }
    fetch(`/api/sections/${sectionId}/dom`)
      .then(r => r.json())
      .then(data => {
        const node = (data.nodes || []).find((n: NodeDetail) => n.stable_key === selectedNode.stableKey)
        if (node) {
          setNodeDetail(node)
          setEditText(node.text_content || '')
          setEditHref(node.attrs_jsonb?.href || '')
          setEditSrc(node.attrs_jsonb?.src || '')
          setEditAlt(node.attrs_jsonb?.alt || '')
        }
      })
      .catch(() => {})
  }, [selectedNode, sectionId])

  const applyAndRecord = useCallback((patch: Patch) => {
    onApplyPatch(patch)
    setPendingPatches(prev => [...prev, patch])
  }, [onApplyPatch])

  const handleSetText = () => {
    if (!selectedNode || !editText) return
    applyAndRecord({
      nodeStableKey: selectedNode.stableKey,
      op: 'set_text',
      payload: { text: editText }
    })
  }

  const handleSetHref = () => {
    if (!selectedNode || !editHref) return
    applyAndRecord({
      nodeStableKey: selectedNode.stableKey,
      op: 'set_attr',
      payload: { attr: 'href', value: editHref }
    })
  }

  const handleSetSrc = () => {
    if (!selectedNode || !editSrc) return
    applyAndRecord({
      nodeStableKey: selectedNode.stableKey,
      op: 'replace_asset',
      payload: { src: editSrc, alt: editAlt }
    })
  }

  const handleRemove = () => {
    if (!selectedNode) return
    applyAndRecord({
      nodeStableKey: selectedNode.stableKey,
      op: 'remove_node',
      payload: {}
    })
  }

  // パッチをサーバーに保存
  const savePatches = async () => {
    if (pendingPatches.length === 0) return

    let currentPatchSetId = patchSetId

    // パッチセットがなければ作成
    if (!currentPatchSetId) {
      const res = await fetch(`/api/sections/${sectionId}/patch-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Edit session' })
      })
      const data = await res.json()
      currentPatchSetId = data.patchSet?.id
    }

    if (!currentPatchSetId) return

    await fetch(`/api/patch-sets/${currentPatchSetId}/patches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patches: pendingPatches })
    })

    setPendingPatches([])
  }

  if (!selectedNode) {
    return (
      <aside className="node-inspector">
        <div className="inspector-empty">
          <p>セクション内の要素をクリックして編集</p>
        </div>
      </aside>
    )
  }

  const isText = ['heading', 'paragraph', 'text', 'list_item', 'button'].includes(nodeDetail?.node_type || '')
  const isLink = nodeDetail?.node_type === 'link' || nodeDetail?.node_type === 'button'
  const isImage = nodeDetail?.node_type === 'image'

  return (
    <aside className="node-inspector">
      <div className="inspector-header">
        <h3>
          <span className="inspector-tag">&lt;{selectedNode.tagName}&gt;</span>
          <span className="inspector-type">{nodeDetail?.node_type || ''}</span>
        </h3>
        <span className="inspector-key">{selectedNode.stableKey}</span>
      </div>

      {/* テキスト編集 */}
      {isText && (
        <div className="inspector-section">
          <label>テキスト</label>
          <textarea
            value={editText}
            onChange={e => setEditText(e.target.value)}
            rows={3}
          />
          <button className="inspector-btn primary" onClick={handleSetText}>
            テキスト適用
          </button>
        </div>
      )}

      {/* リンク編集 */}
      {isLink && (
        <div className="inspector-section">
          <label>リンク先 (href)</label>
          <input
            type="text"
            value={editHref}
            onChange={e => setEditHref(e.target.value)}
            placeholder="https://..."
          />
          <button className="inspector-btn" onClick={handleSetHref}>
            リンク適用
          </button>
        </div>
      )}

      {/* 画像編集 */}
      {isImage && (
        <div className="inspector-section">
          <label>画像URL (src)</label>
          <input
            type="text"
            value={editSrc}
            onChange={e => setEditSrc(e.target.value)}
            placeholder="https://..."
          />
          <label>Alt テキスト</label>
          <input
            type="text"
            value={editAlt}
            onChange={e => setEditAlt(e.target.value)}
          />
          <button className="inspector-btn" onClick={handleSetSrc}>
            画像差し替え
          </button>
        </div>
      )}

      {/* 削除 */}
      <div className="inspector-section">
        <button className="inspector-btn danger" onClick={handleRemove}>
          この要素を削除
        </button>
      </div>

      {/* Computed Style 表示 */}
      {nodeDetail?.computed_style_jsonb && Object.keys(nodeDetail.computed_style_jsonb).length > 0 && (
        <div className="inspector-section">
          <label>Computed Style</label>
          <div className="inspector-styles">
            {Object.entries(nodeDetail.computed_style_jsonb).map(([k, v]) => (
              <div key={k} className="style-row">
                <span className="style-prop">{k}</span>
                <span className="style-val">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 保存 */}
      {pendingPatches.length > 0 && (
        <div className="inspector-section inspector-save">
          <span className="patch-count">{pendingPatches.length} 件の変更</span>
          <button className="inspector-btn primary" onClick={savePatches}>
            変更を保存
          </button>
        </div>
      )}
    </aside>
  )
}
