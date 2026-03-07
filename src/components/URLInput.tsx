import React, { useState } from 'react'

const GENRE_PRESETS = [
  'SaaS', 'EC', 'BtoB', 'BtoC', '士業', '医療', '美容', '飲食',
  '不動産', '教育', '採用', '金融', 'IT', '製造', 'コンサル', 'その他'
]

interface Props {
  onSubmit: (url: string, genre: string, tags: string[]) => void
  loading: boolean
  error: string | null
}

export function URLInput({ onSubmit, loading, error }: Props) {
  const [url, setUrl] = useState('')
  const [genre, setGenre] = useState('')
  const [tagInput, setTagInput] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim() || loading) return
    let finalUrl = url.trim()
    if (!/^https?:\/\//.test(finalUrl)) {
      finalUrl = 'https://' + finalUrl
    }
    const tags = tagInput.split(',').map(t => t.trim()).filter(Boolean)
    onSubmit(finalUrl, genre, tags)
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
            disabled={loading}
          />
          <button type="submit" className="extract-btn" disabled={loading}>
            {loading ? <span className="spinner" /> : 'Extract'}
          </button>
        </div>
        <div className="url-form-tags">
          <div className="genre-select-wrap">
            <select
              value={genre}
              onChange={e => setGenre(e.target.value)}
              className="genre-select"
            >
              <option value="">-- Genre --</option>
              {GENRE_PRESETS.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <input
              type="text"
              value={genre}
              onChange={e => setGenre(e.target.value)}
              placeholder="or type genre"
              className="genre-custom"
            />
          </div>
          <input
            type="text"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            placeholder="Tags (comma separated: LP, corporate, ...)"
            className="tag-input"
          />
        </div>
      </form>
      {error && <div className="error-msg">{error}</div>}
    </div>
  )
}
