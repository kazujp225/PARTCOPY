import React, { useEffect, useState } from 'react'
import { SourceSection, CanvasBlock } from '../types'
import { FAMILY_COLORS, FAMILY_LABELS, FAMILY_ICONS } from '../constants'

interface Props {
  sections: SourceSection[]
  canvas: CanvasBlock[]
  onNavigate: (view: string) => void
  onExtract?: (url: string) => void
  extractLoading?: boolean
}

export function Dashboard({ sections, canvas, onNavigate, onExtract, extractLoading }: Props) {
  const [extractUrl, setExtractUrl] = useState('')
  const [crawlQueueUrls, setCrawlQueueUrls] = useState<string[]>([])
  const [crawlDoneUrls, setCrawlDoneUrls] = useState<string[]>([])
  const [crawlActive, setCrawlActive] = useState(false)
  const [crawlUrl, setCrawlUrl] = useState<string | null>(null)
  const [bulkUrls, setBulkUrls] = useState('')
  const [bulkAdding, setBulkAdding] = useState(false)

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/crawl-queue')
      if (res.ok) {
        const data = await res.json()
        setCrawlQueueUrls(data.queue || [])
        setCrawlDoneUrls(data.done || [])
        setCrawlActive(data.active || false)
        setCrawlUrl(data.currentUrl || null)
      }
    } catch {}
  }

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleBulkAdd = async () => {
    const urls = bulkUrls.split('\n').map(u => u.trim()).filter(u => /^https?:\/\//i.test(u))
    if (urls.length === 0) return
    setBulkAdding(true)
    try {
      const res = await fetch('/api/crawl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls })
      })
      if (res.ok) {
        setBulkUrls('')
        await fetchStatus()
      }
    } catch {} finally {
      setBulkAdding(false)
    }
  }

  const handleClearQueue = async () => {
    try {
      await fetch('/api/crawl-queue', { method: 'DELETE' })
      await fetchStatus()
    } catch {}
  }

  // Fetch real counts from API instead of computing from limited sections array
  const [totalParts, setTotalParts] = useState(sections.length)
  const [siteCount, setSiteCount] = useState(0)
  const [familyCountsApi, setFamilyCountsApi] = useState<Array<{key: string; count: number}>>([])

  useEffect(() => {
    fetch('/api/library/count').then(r => r.json()).then(d => setTotalParts(d.count || 0)).catch(() => {})
    fetch('/api/library/families').then(r => r.json()).then(d => {
      const fams = d.families || []
      setFamilyCountsApi(fams.filter((f: any) => f.count > 0))
    }).catch(() => {})
    fetch('/api/sites/count').then(r => r.json()).then(d => {
      setSiteCount(d.count || 0)
    }).catch(() => {})
  }, [])

  const families = new Map<string, number>()
  const sites = new Map<string, number>()
  const recentSections = new Map<string, { count: number; domain: string; latest: string }>()

  sections.forEach(s => {
    const fam = s.block_family || 'unknown'
    families.set(fam, (families.get(fam) || 0) + 1)
    const dom = s.source_sites?.normalized_domain || '?'
    sites.set(dom, (sites.get(dom) || 0) + 1)

    const existing = recentSections.get(dom)
    if (!existing || s.created_at > existing.latest) {
      recentSections.set(dom, {
        count: (existing?.count || 0) + 1,
        domain: dom,
        latest: s.created_at
      })
    } else if (existing) {
      existing.count++
    }
  })

  const topFamilies = familyCountsApi.length > 0
    ? familyCountsApi.sort((a, b) => b.count - a.count).slice(0, 10).map(f => [f.key, f.count] as [string, number])
    : [...families.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const topSites = [...sites.entries()].sort((a, b) => b[1] - a[1])
  const recentSites = [...recentSections.values()]
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .slice(0, 5)

  // Build domain → page URL mapping from sections
  const domainUrls = new Map<string, string>()
  sections.forEach(s => {
    const dom = s.source_sites?.normalized_domain
    const url = s.source_pages?.url
    if (dom && url && !domainUrls.has(dom)) {
      domainUrls.set(dom, url)
    }
  })

  const crawlQueue = crawlQueueUrls.length
  const crawlDone = crawlDoneUrls.length
  const crawlTotal = crawlQueue + crawlDone
  const crawlPercent = crawlTotal > 0 ? Math.round((crawlDone / crawlTotal) * 100) : 0

  return (
    <div className="dashboard">
      {/* Hero header */}
      <div className="dash-hero">
        <h1 className="dash-hero-title">PARTCOPY</h1>
        <p className="dash-hero-sub">Webデザインのパーツ別ストック &amp; ビルダー</p>
        <div className="dash-hero-stats">
          <div className="dash-hero-stat">
            <strong>{totalParts}</strong>
            <span>Design Stock</span>
          </div>
          <div className="dash-hero-stat">
            <strong>{siteCount || sites.size}</strong>
            <span>Sites</span>
          </div>
          <div className="dash-hero-stat">
            <strong>{familyCountsApi.length || families.size}</strong>
            <span>Categories</span>
          </div>
        </div>
      </div>

      {/* URL extract bar */}
      {onExtract && (
        <div className="dash-extract-bar">
          <input
            type="text"
            className="dash-extract-input"
            placeholder="URLを入力してデザインパーツを抽出..."
            value={extractUrl}
            onChange={e => setExtractUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && extractUrl.trim()) {
                onExtract(extractUrl.trim())
                setExtractUrl('')
              }
            }}
            disabled={extractLoading}
          />
          <button
            className="dash-extract-btn"
            onClick={() => {
              if (extractUrl.trim()) {
                onExtract(extractUrl.trim())
                setExtractUrl('')
              }
            }}
            disabled={extractLoading || !extractUrl.trim()}
          >
            {extractLoading ? '抽出中...' : '抽出する'}
          </button>
        </div>
      )}

      {/* Auto-crawl management */}
      <div className="dash-section-header">
        <h2>AUTO COLLECT</h2>
        <p>自動収集</p>
      </div>
      <div className="dash-autocrawl-panel">
        {/* Progress */}
        {(crawlActive || crawlQueue > 0) && (
          <div className="dash-crawl-status">
            <div className="dash-crawl-header">
              <span className={`dash-crawl-title${crawlActive ? ' active' : ''}`}>
                {crawlActive ? '● 自動取得中' : '○ 自動取得待機中'}
              </span>
              <span className="dash-crawl-progress-text">
                {crawlDone}/{crawlTotal} 完了 ({crawlPercent}%)
              </span>
            </div>
            <div className="dash-crawl-bar">
              <div className="dash-crawl-bar-fill" style={{ width: `${crawlPercent}%` }} />
            </div>
            {crawlUrl && <p className="dash-crawl-url">処理中: {crawlUrl}</p>}
          </div>
        )}

        {/* Bulk URL add */}
        <div className="dash-autocrawl-section">
          <h3 className="dash-autocrawl-label">URLを一括追加</h3>
          <textarea
            className="dash-autocrawl-textarea"
            placeholder={"https://example.com\nhttps://example2.com\n1行に1つのURLを入力..."}
            value={bulkUrls}
            onChange={e => setBulkUrls(e.target.value)}
            rows={4}
            disabled={bulkAdding}
          />
          <div className="dash-autocrawl-row">
            <button
              className="dash-autocrawl-btn"
              onClick={handleBulkAdd}
              disabled={bulkAdding || !bulkUrls.trim()}
            >
              {bulkAdding ? '追加中...' : 'キューに追加'}
            </button>
          </div>
        </div>

        {/* Queue list */}
        {crawlQueueUrls.length > 0 && (
          <div className="dash-autocrawl-section">
            <div className="dash-autocrawl-queue-header">
              <h3 className="dash-autocrawl-label">キュー ({crawlQueueUrls.length}件)</h3>
              <button className="dash-autocrawl-btn-sm danger" onClick={handleClearQueue}>
                クリア
              </button>
            </div>
            <ul className="dash-autocrawl-queue-list">
              {crawlQueueUrls.slice(0, 20).map((url, i) => (
                <li key={i} className="dash-autocrawl-queue-item">
                  {i === 0 && crawlActive && <span className="dash-queue-active-dot">●</span>}
                  <span className="dash-queue-url">{url}</span>
                </li>
              ))}
              {crawlQueueUrls.length > 20 && (
                <li className="dash-autocrawl-queue-more">...他 {crawlQueueUrls.length - 20}件</li>
              )}
            </ul>
          </div>
        )}

        {/* Done summary */}
        {crawlDone > 0 && !crawlActive && crawlQueue === 0 && (
          <p className="dash-autocrawl-done">完了済み: {crawlDone}件</p>
        )}
      </div>

      {/* Category grid (STOCK DESIGN style) */}
      <div className="dash-section-header">
        <h2>SEARCH</h2>
        <p>パーツ種別から探す</p>
      </div>
      <div className="dash-category-grid">
        {topFamilies.map(([family, count]) => (
          <button
            key={family}
            className="dash-category-card"
            onClick={() => onNavigate('library')}
          >
            <span className="dash-cat-icon" style={{ color: FAMILY_COLORS[family] || '#94a3b8' }}>
              {FAMILY_ICONS[family] || '●'}
            </span>
            <span className="dash-cat-name">{FAMILY_LABELS[family] || family}</span>
            <span className="dash-cat-count">{count}</span>
          </button>
        ))}
      </div>

      {/* Recent sites */}
      <div className="dash-section-header">
        <h2>RECENT</h2>
        <p>最近取得したサイト</p>
      </div>
      {recentSites.length === 0 ? (
        <p className="dash-empty">まだ取得履歴がありません</p>
      ) : (
        <div className="dash-recent-list">
          {recentSites.map(site => {
            const pageUrl = domainUrls.get(site.domain)
            return (
              <div key={site.domain} className="dash-recent-row">
                <div className="dash-recent-info">
                  {pageUrl ? (
                    <a className="dash-recent-domain dash-link" href={pageUrl} target="_blank" rel="noopener noreferrer">{site.domain}</a>
                  ) : (
                    <span className="dash-recent-domain">{site.domain}</span>
                  )}
                  <span className="dash-recent-time">
                    {new Date(site.latest).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <span className="dash-recent-count">{site.count} パーツ</span>
              </div>
            )
          })}
        </div>
      )}

      {/* All sites */}
      {topSites.length > 0 && (
        <>
          <div className="dash-section-header">
            <h2>SITES</h2>
            <p>取得サイト一覧</p>
          </div>
          <div className="dash-site-grid">
            {topSites.map(([domain, count]) => {
              const pageUrl = domainUrls.get(domain)
              return (
                <div key={domain} className="dash-site-row">
                  {pageUrl ? (
                    <a className="dash-site-domain dash-link" href={pageUrl} target="_blank" rel="noopener noreferrer">{domain}</a>
                  ) : (
                    <span className="dash-site-domain">{domain}</span>
                  )}
                  <span className="dash-site-count">{count}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
