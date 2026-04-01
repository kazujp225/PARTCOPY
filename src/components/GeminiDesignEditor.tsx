/**
 * GeminiDesignEditor — Gemini APIを使ってセクションのデザインを修正するエディタ。
 * 左: チャット形式の指示入力 + プリセット / 右: ライブプレビュー (iframe)
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'

interface Props {
  sectionId: string
  familyName?: string
  onClose: () => void
  onSaved: () => void
}

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

const PRESETS = [
  { label: '配色を変更', prompt: 'このセクションの配色をモダンでプロフェッショナルな印象に変更してください。元のレイアウト構造は維持してください。' },
  { label: 'フォント調整', prompt: 'フォントサイズとウェイトのバランスを調整して、より読みやすくしてください。見出しは大きめに、本文は適切なサイズに。' },
  { label: '余白を整える', prompt: 'padding と margin を調整して、要素間の余白バランスを改善してください。窮屈な部分は広げ、空きすぎの部分は詰めてください。' },
  { label: 'ダークモード化', prompt: 'このセクションをダークモードのデザインに変換してください。背景を暗く、テキストを明るい色に変更し、コントラストを確保してください。' },
  { label: '角丸・シャドウ追加', prompt: 'カードやボタンなどの要素にborder-radiusとbox-shadowを追加して、やわらかい印象のデザインにしてください。' },
  { label: 'CTA強調', prompt: 'CTA（Call To Action）ボタンやリンクをより目立つデザインにしてください。色、サイズ、ホバー効果を強化してください。' },
]

export function GeminiDesignEditor({ sectionId, familyName, onClose, onSaved }: Props) {
  const [html, setHtml] = useState('')
  const [originalHtml, setOriginalHtml] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [previewKey, setPreviewKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Load section HTML
  useEffect(() => {
    setLoading(true)
    fetch(`/api/sections/${sectionId}/html`)
      .then(r => r.json())
      .then(data => {
        setHtml(data.html || '')
        setOriginalHtml(data.html || '')
        setLoading(false)
        setMessages([{ role: 'system', content: 'セクションを読み込みました。デザインの変更指示を入力するか、プリセットを選択してください。' }])
      })
      .catch(() => {
        setLoading(false)
        setMessages([{ role: 'system', content: 'HTMLの読み込みに失敗しました。' }])
      })
  }, [sectionId])

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleClose = useCallback(() => {
    if (dirty && !window.confirm('未保存の変更があります。閉じてもよろしいですか？')) return
    onClose()
  }, [dirty, onClose])

  const sendToGemini = useCallback(async (prompt: string) => {
    if (!prompt.trim() || generating) return

    // Gemini 2.0 Flash: input $0.10/MTok, output $0.40/MTok
    const inputChars = html.length + prompt.length + 1500 // HTML + prompt + system prompt
    const estimatedInputTokens = Math.ceil(inputChars / 4)
    const estimatedOutputTokens = Math.ceil(estimatedInputTokens * 0.6) // output ≈ 60% of input
    const estimatedCostUsd = (estimatedInputTokens * 0.10 + estimatedOutputTokens * 0.40) / 1_000_000
    const estimatedCostYen = Math.ceil(estimatedCostUsd * 150 * 100) / 100 // USD→JPY
    const costDisplay = estimatedCostYen < 0.1
      ? '0.1円未満'
      : `約${estimatedCostYen.toFixed(1)}円`

    const confirmed = window.confirm(
      `⚠️ Gemini API（従量課金）を使用します\n\n` +
      `推定コスト: ${costDisplay}（入力 ${Math.round(estimatedInputTokens / 1000)}Kトークン）\n` +
      `モデル: gemini-2.0-flash\n\n` +
      `実行しますか？`
    )
    if (!confirmed) return

    const userMsg: Message = { role: 'user', content: prompt }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setGenerating(true)

    try {
      const res = await fetch('/api/gemini/design-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, prompt, sectionId })
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'エラーが発生しました' }))
        throw new Error(err.error || `Error ${res.status}`)
      }

      const data = await res.json()
      const newHtml = data.html

      if (newHtml && newHtml !== html) {
        setHtml(newHtml)
        setDirty(true)
        setPreviewKey(k => k + 1)
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.explanation || 'デザインを変更しました。'
        }])
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.explanation || '変更はありませんでした。'
        }])
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'system',
        content: `エラー: ${err.message}`
      }])
    } finally {
      setGenerating(false)
    }
  }, [html, generating, sectionId])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    sendToGemini(input)
  }, [input, sendToGemini])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendToGemini(input)
    }
  }, [input, sendToGemini])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      const res = await fetch(`/api/sections/${sectionId}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html })
      })
      if (!res.ok) throw new Error(`保存に失敗しました (${res.status})`)
      setOriginalHtml(html)
      setDirty(false)
      onSaved()
      setSaveMsg({ type: 'success', text: '保存しました' })
      setTimeout(() => setSaveMsg(null), 3000)
    } catch (err: any) {
      setSaveMsg({ type: 'error', text: err?.message || '保存に失敗しました' })
    } finally {
      setSaving(false)
    }
  }, [sectionId, html, onSaved])

  const handleUndo = useCallback(() => {
    setHtml(originalHtml)
    setDirty(false)
    setPreviewKey(k => k + 1)
    setMessages(prev => [...prev, { role: 'system', content: '元のHTMLに戻しました。' }])
  }, [originalHtml])

  // Build preview HTML using render endpoint with modified HTML
  const previewSrc = `/api/sections/${sectionId}/render?t=${previewKey}`

  // For modified HTML, we use srcdoc with the current html
  const [previewDoc, setPreviewDoc] = useState('')
  useEffect(() => {
    if (!dirty) {
      setPreviewDoc('')
      return
    }
    // Fetch the rendered version to get CSS, then inject our modified HTML
    fetch(`/api/sections/${sectionId}/render`)
      .then(r => r.text())
      .then(fullDoc => {
        // Replace the body content with our modified HTML
        const bodyMatch = fullDoc.match(/<body[^>]*>([\s\S]*)<\/body>/i)
        if (bodyMatch) {
          const newDoc = fullDoc.replace(bodyMatch[1], html)
          setPreviewDoc(newDoc)
        } else {
          setPreviewDoc(fullDoc)
        }
      })
      .catch(() => setPreviewDoc(''))
  }, [sectionId, html, dirty, previewKey])

  if (loading) {
    return (
      <div className="gemini-editor-overlay">
        <div className="gemini-editor-container">
          <div className="gemini-editor-loading">読み込み中...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="gemini-editor-overlay" onClick={handleClose}>
      <div className="gemini-editor-container" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="gemini-editor-header">
          <div className="gemini-editor-title">
            <span className="gemini-editor-logo">G</span>
            Gemini デザイン編集
            {familyName && <span className="gemini-editor-family">— {familyName}</span>}
            {dirty && <span className="gemini-editor-dirty">*未保存</span>}
            {saveMsg && (
              <span className={`code-editor-save-msg code-editor-save-msg--${saveMsg.type}`}>
                {saveMsg.text}
              </span>
            )}
          </div>
          <div className="gemini-editor-actions">
            <button className="code-editor-btn secondary" onClick={handleUndo} disabled={!dirty || saving}>
              元に戻す
            </button>
            <button className="code-editor-btn primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : dirty ? '保存' : '保存済み'}
            </button>
            <button className="code-editor-btn close" onClick={handleClose}>&times;</button>
          </div>
        </div>

        {/* Body */}
        <div className="gemini-editor-body">
          {/* Left: Chat + Presets */}
          <div className="gemini-editor-chat-pane">
            {/* Presets */}
            <div className="gemini-editor-presets">
              <div className="gemini-editor-presets-label">プリセット</div>
              <div className="gemini-editor-presets-grid">
                {PRESETS.map((p, i) => (
                  <button
                    key={i}
                    className="gemini-preset-btn"
                    onClick={() => sendToGemini(p.prompt)}
                    disabled={generating}
                    title={p.prompt}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Chat messages */}
            <div className="gemini-editor-messages">
              {messages.map((msg, i) => (
                <div key={i} className={`gemini-msg gemini-msg--${msg.role}`}>
                  <div className="gemini-msg-content">{msg.content}</div>
                </div>
              ))}
              {generating && (
                <div className="gemini-msg gemini-msg--assistant">
                  <div className="gemini-msg-content gemini-msg-loading">
                    <span className="gemini-dot" /><span className="gemini-dot" /><span className="gemini-dot" />
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <form className="gemini-editor-input-area" onSubmit={handleSubmit}>
              <textarea
                ref={inputRef}
                className="gemini-editor-input"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="デザインの変更指示を入力... (Enter で送信, Shift+Enter で改行)"
                disabled={generating}
                rows={2}
              />
              <button
                type="submit"
                className="gemini-send-btn"
                disabled={!input.trim() || generating}
              >
                {generating ? '...' : '送信'}
              </button>
            </form>
          </div>

          {/* Right: Preview */}
          <div className="gemini-editor-preview-pane">
            {dirty && previewDoc ? (
              <iframe
                key={`mod-${previewKey}`}
                srcDoc={previewDoc}
                className="gemini-editor-preview-iframe"
                sandbox="allow-same-origin"
              />
            ) : (
              <iframe
                key={`orig-${previewKey}`}
                src={previewSrc}
                className="gemini-editor-preview-iframe"
                sandbox="allow-same-origin"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
