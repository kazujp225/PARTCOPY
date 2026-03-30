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
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
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
      .catch((err: any) => {
        setLoading(false)
        setSaveMessage({ type: 'error', text: err?.message || 'HTMLの読み込みに失敗しました' })
      })
  }, [sectionId])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setHtml(e.target.value)
    setDirty(e.target.value !== original)
  }, [original])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveMessage(null)
    try {
      const res = await fetch(`/api/sections/${sectionId}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html })
      })
      if (!res.ok) {
        throw new Error(`保存に失敗しました (${res.status})`)
      }
      setOriginal(html)
      setDirty(false)
      setPreviewKey(k => k + 1)
      onSaved()
      setSaveMessage({ type: 'success', text: '保存しました' })
      setTimeout(() => setSaveMessage(null), 3000)
    } catch (err: any) {
      setSaveMessage({ type: 'error', text: err?.message || '保存に失敗しました' })
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
        読み込み中...
      </div>
    )
  }

  return (
    <div className="code-editor-overlay">
      <div className="code-editor-container">
        {/* Header */}
        <div className="code-editor-header">
          <div className="code-editor-title">
            HTML 編集
            {dirty && <span className="code-editor-dirty">*未保存</span>}
            {saveMessage && (
              <span className={`code-editor-save-msg code-editor-save-msg--${saveMessage.type}`}>
                {saveMessage.text}
              </span>
            )}
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
