/**
 * CodeEditor — セクションのHTMLを直接編集するパネル。
 * 左: コードエディタ (textarea) / 右: ライブプレビュー (iframe)
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'

interface Props {
  sectionId: string
  onClose: () => void
  onSaved: () => void
}

export function CodeEditor({ sectionId, onClose, onSaved }: Props) {
  const [html, setHtml] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Warn on browser/tab close when there are unsaved changes
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const handleClose = useCallback(() => {
    if (dirty) {
      if (!window.confirm('未保存の変更があります。閉じてもよろしいですか？')) return
    }
    onClose()
  }, [dirty, onClose])

  useEffect(() => {
    setLoading(true)
    fetch(`/api/sections/${sectionId}/html`)
      .then(r => r.json())
      .then(data => {
        setHtml(data.html || '')
        setOriginal(data.html || '')
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [sectionId])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setHtml(e.target.value)
    setDirty(e.target.value !== original)
  }, [original])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/sections/${sectionId}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html })
      })
      if (res.ok) {
        setOriginal(html)
        setDirty(false)
        setPreviewKey(k => k + 1)
        onSaved()
      }
    } finally {
      setSaving(false)
    }
  }, [sectionId, html, onSaved])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Cmd/Ctrl+S で保存
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (dirty) handleSave()
    }
    // Tab でインデント
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = textareaRef.current
      if (!ta) return
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const value = ta.value
      const newValue = value.substring(0, start) + '  ' + value.substring(end)
      setHtml(newValue)
      setDirty(newValue !== original)
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2
      })
    }
  }, [dirty, handleSave, original])

  const handleReset = useCallback(() => {
    setHtml(original)
    setDirty(false)
  }, [original])

  if (loading) {
    return (
      <div className="code-editor-loading">
        Loading...
      </div>
    )
  }

  return (
    <div className="code-editor-overlay">
      <div className="code-editor-container">
        {/* Header */}
        <div className="code-editor-header">
          <div className="code-editor-title">
            HTML Editor
            {dirty && <span className="code-editor-dirty">*未保存</span>}
          </div>
          <div className="code-editor-actions">
            <button
              className="code-editor-btn secondary"
              onClick={handleReset}
              disabled={!dirty}
            >
              リセット
            </button>
            <button
              className="code-editor-btn primary"
              onClick={handleSave}
              disabled={!dirty || saving}
            >
              {saving ? '保存中...' : '保存 (Cmd+S)'}
            </button>
            <button className="code-editor-btn close" onClick={handleClose}>
              &times;
            </button>
          </div>
        </div>

        {/* Body: Code + Preview */}
        <div className="code-editor-body">
          <div className="code-editor-pane">
            <textarea
              ref={textareaRef}
              className="code-editor-textarea"
              value={html}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              spellCheck={false}
            />
          </div>
          <div className="code-editor-preview-pane">
            <iframe
              key={previewKey}
              src={`/api/sections/${sectionId}/render?t=${previewKey}`}
              className="code-editor-preview-iframe"
              sandbox="allow-same-origin"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
