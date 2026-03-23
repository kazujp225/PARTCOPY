import React, { useState } from 'react'

interface Props {
  tsx: string
  familyName?: string
  onClose: () => void
}

export function TsxModal({ tsx, familyName, onClose }: Props) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(tsx)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
      const ta = document.createElement('textarea')
      ta.value = tsx
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="tsx-modal-overlay" onClick={onClose}>
      <div className="tsx-modal" onClick={e => e.stopPropagation()}>
        <div className="tsx-modal-header">
          <h3>TSX {familyName && `- ${familyName}`}</h3>
          <div className="tsx-modal-actions">
            <button className={`tsx-copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy}>
              {copied ? 'コピー済み！' : 'コピー'}
            </button>
            <button className="tsx-close-btn" onClick={onClose}>&times;</button>
          </div>
        </div>
        <pre className="tsx-code"><code>{tsx}</code></pre>
      </div>
    </div>
  )
}
