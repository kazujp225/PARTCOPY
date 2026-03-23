import React from 'react'
import { SourceSection, CanvasBlock } from '../types'

interface Props {
  sections: SourceSection[]
  canvas: CanvasBlock[]
}

export function Dashboard({ sections, canvas }: Props) {
  // Calculate stats
  const totalParts = sections.length
  const families = new Map<string, number>()
  const sites = new Map<string, number>()

  sections.forEach(s => {
    const fam = s.block_family || 'unknown'
    families.set(fam, (families.get(fam) || 0) + 1)
    const dom = s.source_sites?.normalized_domain || '?'
    sites.set(dom, (sites.get(dom) || 0) + 1)
  })

  const topFamilies = [...families.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const topSites = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>ダッシュボード</h2>
        <p className="dashboard-subtitle">パーツライブラリの概要</p>
      </div>

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

      <div className="dashboard-grid">
        <div className="dash-card">
          <h3>パーツ種別の内訳</h3>
          <div className="dash-bar-chart">
            {topFamilies.map(([family, count]) => (
              <div key={family} className="dash-bar-row">
                <span className="dash-bar-label">{family}</span>
                <div className="dash-bar-track">
                  <div
                    className="dash-bar-fill"
                    style={{ width: `${(count / totalParts) * 100}%` }}
                  />
                </div>
                <span className="dash-bar-count">{count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="dash-card">
          <h3>取得サイト一覧</h3>
          <div className="dash-site-list">
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
