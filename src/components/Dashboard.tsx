import React, { useEffect, useState } from 'react'
import { SourceSection, CanvasBlock } from '../types'

interface Props {
  sections: SourceSection[]
  canvas: CanvasBlock[]
  onNavigate: (view: string) => void
  onExtract?: (url: string) => void
  extractLoading?: boolean
}

export function Dashboard({ sections, canvas, onNavigate, onExtract, extractLoading }: Props) {
  const [extractUrl, setExtractUrl] = useState('')
  const [crawlQueue, setCrawlQueue] = useState(0)
  const [crawlDone, setCrawlDone] = useState(0)
  const [crawlActive, setCrawlActive] = useState(false)
  const [crawlUrl, setCrawlUrl] = useState<string | null>(null)

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/crawl-queue')
        if (res.ok) {
          const data = await res.json()
          setCrawlQueue(data.queue?.length || 0)
          setCrawlDone(data.done?.length || 0)
          setCrawlActive(data.active || false)
          setCrawlUrl(data.currentUrl || null)
        }
      } catch {}
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 10000)
    return () => clearInterval(interval)
  }, [])

  const totalParts = sections.length
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

  const topFamilies = [...families.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const topSites = [...sites.entries()].sort((a, b) => b[1] - a[1])
  const recentSites = [...recentSections.values()]
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .slice(0, 5)

  const crawlTotal = crawlQueue + crawlDone
  const crawlPercent = crawlTotal > 0 ? Math.round((crawlDone / crawlTotal) * 100) : 0

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <div>
          <h2>ダッシュボード</h2>
          <p className="dashboard-subtitle">パーツライブラリの概要</p>
        </div>
      </div>

      {onExtract && (
        <div className="dash-extract-bar">
          <input
            type="text"
            className="dash-extract-input"
            placeholder="URLを入力してパーツを抽出..."
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

      <div className="dashboard-stats">
        <div className="dash-stat-card primary">
          <div className="dash-stat-number">{totalParts}</div>
          <div className="dash-stat-label">総パーツ数</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-number">{sites.size}</div>
          <div className="dash-stat-label">取得サイト数</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-number">{families.size}</div>
          <div className="dash-stat-label">パーツ種別</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-number">{canvas.length}</div>
          <div className="dash-stat-label">Canvas</div>
        </div>
      </div>

      {/* Auto-crawl status */}
      {(crawlActive || crawlQueue > 0) && (
        <div className="dash-crawl-status">
          <div className="dash-crawl-header">
            <span className="dash-crawl-title">
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

      <div className="dashboard-grid">
        {/* Recent activity */}
        <div className="dash-card">
          <h3>最近の取得</h3>
          {recentSites.length === 0 ? (
            <p className="dash-empty">まだ取得履歴がありません</p>
          ) : (
            <div className="dash-recent-list">
              {recentSites.map(site => (
                <div key={site.domain} className="dash-recent-row">
                  <div className="dash-recent-info">
                    <span className="dash-recent-domain">{site.domain}</span>
                    <span className="dash-recent-time">
                      {new Date(site.latest).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <span className="dash-recent-count">{site.count}パーツ</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Parts breakdown */}
        <div className="dash-card">
          <h3>パーツ種別の内訳</h3>
          <div className="dash-bar-chart">
            {topFamilies.map(([family, count]) => (
              <div key={family} className="dash-bar-row">
                <span className="dash-bar-label">{family}</span>
                <div className="dash-bar-track">
                  <div className="dash-bar-fill" style={{ width: `${(count / totalParts) * 100}%` }} />
                </div>
                <span className="dash-bar-count">{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Site list */}
        <div className="dash-card full-width">
          <h3>取得サイト一覧</h3>
          <div className="dash-site-grid">
            {topSites.map(([domain, count]) => (
              <div key={domain} className="dash-site-row">
                <span className="dash-site-domain">{domain}</span>
                <span className="dash-site-count">{count}パーツ</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
