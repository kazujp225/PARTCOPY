import React, { useState } from 'react'

interface Props {
  onSubmit: (url: string, genre: string, tags: string[]) => void
  loading: boolean
  error: string | null
  jobStatus: string | null
}

export function URLInput({ onSubmit, loading, error, jobStatus }: Props) {
  const [url, setUrl] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim() || loading) return
    let finalUrl = url.trim()
    if (!/^https?:\/\//.test(finalUrl)) finalUrl = 'https://' + finalUrl
    onSubmit(finalUrl, '', [])
  }

  return (
    <div className="url-input-bar">
      <form onSubmit={handleSubmit} className="url-form">
        <div className="url-form-main">
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="URLを入力 (例: https://example.co.jp)"
            className="url-field"
            style={{ padding: '0.85rem 1rem', fontSize: '1rem' }}
            disabled={loading}
          />
          <button type="submit" className="extract-btn" disabled={loading}>
            {loading ? <span className="spinner" /> : '抽出する'}
          </button>
        </div>
      </form>
      <p className="url-input-description" style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
        URLを入力してサイトのパーツを自動抽出します
      </p>
      {jobStatus && (
        <div className={`job-status ${jobStatus.includes('Claude') ? 'claude-active' : ''}`}>
          {jobStatus.includes('Claude') && <span className="claude-spinner" />}
          <span>{jobStatus}</span>
        </div>
      )}
      {jobStatus && (
        <div className="phase-indicator">
          {['DL', '検出', '分類', 'TSX', '完了'].map((label, i) => {
            const currentPhase = jobStatus.includes('TSX') || jobStatus.includes('Claude') ? 3
              : jobStatus.includes('normalizing') || jobStatus.includes('セクション') ? 2
              : jobStatus.includes('rendering') || jobStatus.includes('parsed') ? 1
              : jobStatus.includes('queued') ? 0 : 4
            const state = i < currentPhase ? 'done' : i === currentPhase ? 'active' : ''
            return (
              <div key={label} className={`phase-step ${state}`}>
                <span className={`phase-dot ${state}`} />
                <span className="phase-label">{label}</span>
              </div>
            )
          })}
        </div>
      )}
      {error && <div className="error-msg">{error}</div>}
    </div>
  )
}
