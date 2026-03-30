import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { SourceSection, CanvasBlock, CrawlJob, JobStatus } from './types'
import { URLInput } from './components/URLInput'
import { PartsPanel } from './components/PartsPanel'
import { Canvas } from './components/Canvas'
import { Preview } from './components/Preview'
import { Library } from './components/Library'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TsxModal } from './components/TsxModal'
import { Dashboard } from './components/Dashboard'
import { FAMILY_COLORS, FAMILY_LABELS, FAMILY_ICONS } from './constants'
import './styles.css'

type View = 'dashboard' | 'editor' | 'preview' | 'library' | 'project-detail'

const CANVAS_STORAGE_KEY = 'partcopy:canvas'
const ACTIVE_PROJECT_KEY = 'partcopy:activeProjectId'
const ACTIVE_VIEW_KEY = 'partcopy:view'
const CANVAS_STORAGE_VERSION = 1
function loadCanvasFromStorage(): CanvasBlock[] {
  try {
    const raw = localStorage.getItem(CANVAS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== CANVAS_STORAGE_VERSION) return []
    return Array.isArray(parsed.canvas) ? parsed.canvas : []
  } catch { return [] }
}
function loadActiveProjectId(): string | null {
  return localStorage.getItem(ACTIVE_PROJECT_KEY) || null
}
function loadActiveView(): View {
  const v = localStorage.getItem(ACTIVE_VIEW_KEY)
  if (v && ['dashboard','editor','preview','library','project-detail'].includes(v)) return v as View
  return 'dashboard'
}

export default function App() {
  const [sections, setSections] = useState<SourceSection[]>([])
  const [canvas, setCanvas] = useState<CanvasBlock[]>(loadCanvasFromStorage)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [view, setViewState] = useState<View>(loadActiveView)
  const pollRef = useRef<NodeJS.Timeout | null>(null)
  const [tsxResult, setTsxResult] = useState<{ tsx: string; familyName?: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<{ message: string; current?: number; total?: number; sectionName?: string; estimate?: string } | null>(null)
  const [includeImages, setIncludeImages] = useState(true)
  const [selectedSite, setSelectedSite] = useState<string | null>(null)
  const [projectList, setProjectList] = useState<Array<{id: string; name: string; canvas_json: any[]; created_at: string}>>([])
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(loadActiveProjectId)

  // Auto-crawl state
  const [crawlQueueCount, setCrawlQueueCount] = useState(0)
  const [crawlDoneCount, setCrawlDoneCount] = useState(0)
  const [crawlActive, setCrawlActive] = useState(false)
  const [crawlCurrentUrl, setCrawlCurrentUrl] = useState<string | null>(null)
  const [crawlUrls, setCrawlUrls] = useState('')
  const [crawlExpanded, setCrawlExpanded] = useState(false)
  const [crawlSubmitting, setCrawlSubmitting] = useState(false)
  const [crawlStep, setCrawlStep] = useState(1)
  const [keywordSearch, setKeywordSearch] = useState('')
  const [keywordSearching, setKeywordSearching] = useState(false)
  const [keywordResult, setKeywordResult] = useState<{ keywords: string[]; urls: string[] } | null>(null)
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set())
  const [newProjectName, setNewProjectName] = useState('')
  const [showNewProject, setShowNewProject] = useState(false)
  const [saveToast, setSaveToast] = useState<{ projectId: string; projectName: string } | null>(null)
  const [lastCrawlSections, setLastCrawlSections] = useState<SourceSection[]>([])
  const [lastCrawlNewCount, setLastCrawlNewCount] = useState(0)

  const [saveError, setSaveError] = useState<string | null>(null)

  // Save status indicator
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

  // activeProjectIdとviewをlocalStorageに永続化するラッパー
  const setActiveProjectId = useCallback((id: string | null) => {
    setActiveProjectIdState(id)
    if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id)
    else localStorage.removeItem(ACTIVE_PROJECT_KEY)
  }, [])
  const setView = useCallback((v: View) => {
    setViewState(v)
    localStorage.setItem(ACTIVE_VIEW_KEY, v)
  }, [])

  // 初回ロード時にSupabaseからcanvas復元するまで自動保存を抑止
  const initializedRef = useRef(false)

  // Persist canvas to localStorage + Supabase project (debounced)
  useEffect(() => {
    if (!initializedRef.current) return // 初回ロード中は保存しない
    const timer = setTimeout(() => {
      localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ version: CANVAS_STORAGE_VERSION, canvas }))
      // プロジェクトが選択されていれば自動保存
      if (activeProjectId) {
        setSaveStatus('saving')
        fetch(`/api/projects/${activeProjectId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canvas_json: canvas })
        })
          .then(r => {
            if (!r.ok) throw new Error(`保存失敗: ${r.status}`)
            setSaveError(null)
            setSaveStatus('saved')
            setLastSavedAt(new Date())
          })
          .catch(err => {
            setSaveError(err.message)
            setSaveStatus('error')
          })
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [canvas])

  // Warn before closing if there are unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (saveStatus === 'saving') {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [saveStatus])

  // canvas_json内のsectionIdが実際にsectionsに存在するもののみカウントするヘルパー
  const resolvedPartCount = useCallback((canvasJson: any[]) => {
    if (!canvasJson?.length) return 0
    return canvasJson.filter((b: any) => sections.some(s => s.id === b.sectionId)).length
  }, [sections])

  // Load projects on mount & restore active project canvas from Supabase
  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(d => {
        const projects = d.projects || []
        setProjectList(projects)
        // アクティブプロジェクトがあればSupabaseのcanvas_jsonで復元（localStorageより信頼性が高い）
        if (activeProjectId) {
          const active = projects.find((p: any) => p.id === activeProjectId)
          if (active && Array.isArray(active.canvas_json)) {
            setCanvas(active.canvas_json)
          }
        }
        // 初期ロード完了 → 自動保存を有効化
        initializedRef.current = true
      })
      .catch((err: any) => {
        setSaveError(err?.message || 'プロジェクトの読み込みに失敗しました')
        // 初期ロードが失敗しても自動保存は有効化（localStorageのデータで動作可能）
        initializedRef.current = true
      })
  }, [])

  // Load all sections from library on mount
  useEffect(() => {
    fetch('/api/library?limit=500&sort=newest')
      .then(r => r.ok ? r.json() : { sections: [] })
      .then(data => {
        const libSections: SourceSection[] = data.sections || []
        setSections(prev => {
          const seen = new Set(prev.map(s => s.id))
          const next = [...prev]
          for (const s of libSections) {
            if (!seen.has(s.id)) {
              seen.add(s.id)
              next.push(s)
            }
          }
          return next
        })
      })
      .catch((err: any) => { setSaveError(err?.message || 'ライブラリの読み込みに失敗しました') })
  }, [])

  // Validate canvas on load: remove blocks whose sectionId no longer exists
  const canvasCleanedRef = useRef(false)
  useEffect(() => {
    if (!initializedRef.current || canvasCleanedRef.current) return
    if (sections.length === 0 || canvas.length === 0) return
    const sectionIdSet = new Set(sections.map(s => s.id))
    const cleaned = canvas.filter(b => sectionIdSet.has(b.sectionId))
    if (cleaned.length < canvas.length) {
      const removedCount = canvas.length - cleaned.length
      console.warn(`[PARTCOPY] Removed ${removedCount} orphaned canvas block(s) on load`)
      setCanvas(cleaned)
      // Auto-save cleaned canvas back to server
      if (activeProjectId) {
        fetch(`/api/projects/${activeProjectId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canvas_json: cleaned })
        }).catch((err: any) => {
          setSaveError(err?.message || 'クリーンアップ後の自動保存に失敗しました')
        })
      }
    }
    canvasCleanedRef.current = true
  }, [sections, canvas])

  // Cycle crawl steps 1→2→3→4 every 8 seconds while active
  useEffect(() => {
    if (!crawlActive) { setCrawlStep(1); return }
    const interval = setInterval(() => {
      setCrawlStep(prev => prev >= 3 ? 1 : prev + 1)
    }, 6000)
    return () => clearInterval(interval)
  }, [crawlActive])

  // Poll crawl queue status (only when the auto-crawl section is expanded)
  useEffect(() => {
    if (!crawlExpanded) return

    const fetchCrawlStatus = async () => {
      try {
        const res = await fetch('/api/crawl-queue')
        if (res.ok) {
          const data = await res.json()
          setCrawlQueueCount(data.queue?.length || 0)
          setCrawlDoneCount(data.done?.length || 0)
          setCrawlActive(data.active || false)
          setCrawlCurrentUrl(data.currentUrl || null)
        }
      } catch {
        // Server likely down, ignore silently
      }
    }
    fetchCrawlStatus()
    const interval = setInterval(fetchCrawlStatus, 10_000)
    return () => clearInterval(interval)
  }, [crawlExpanded])

  const handleCrawlSubmit = useCallback(async () => {
    const urls = crawlUrls
      .split('\n')
      .map(u => u.trim())
      .filter(u => u.length > 0)
    if (urls.length === 0) return

    setCrawlSubmitting(true)
    try {
      const res = await fetch('/api/crawl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls })
      })
      if (res.ok) {
        const data = await res.json()
        setCrawlQueueCount(data.queue?.length || 0)
        setCrawlDoneCount(data.done?.length || 0)
        setCrawlActive(data.active || false)
        setCrawlUrls('')
      }
    } catch (err: any) {
      setSaveError(err?.message || 'クロールキューへの追加に失敗しました')
    }
    setCrawlSubmitting(false)
  }, [crawlUrls])

  const handleCrawlClear = useCallback(async () => {
    try {
      const res = await fetch('/api/crawl-queue', { method: 'DELETE' })
      if (res.ok) {
        setCrawlQueueCount(0)
      }
    } catch (err: any) {
      setSaveError(err?.message || 'クロールキューのクリアに失敗しました')
    }
  }, [])

  const handleKeywordSearch = useCallback(async () => {
    if (!keywordSearch.trim()) return
    setKeywordSearching(true)
    setKeywordResult(null)
    setSelectedUrls(new Set())
    try {
      const res = await fetch('/api/keyword-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: keywordSearch.trim() })
      })
      if (res.ok) {
        const data = await res.json()
        setKeywordResult({ keywords: data.expandedKeywords, urls: data.urls })
        // デフォルトで全選択
        setSelectedUrls(new Set(data.urls))
      }
    } catch (err: any) {
      setSaveError(err?.message || 'キーワード検索に失敗しました')
    }
    setKeywordSearching(false)
  }, [keywordSearch])

  const handleAddSelectedToQueue = useCallback(async () => {
    if (selectedUrls.size === 0) return
    try {
      const res = await fetch('/api/crawl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [...selectedUrls] })
      })
      if (res.ok) {
        const data = await res.json()
        setCrawlQueueCount(data.queue?.length || 0)
        setCrawlActive(data.active || false)
        setKeywordResult(null)
        setSelectedUrls(new Set())
      }
    } catch (err: any) {
      setSaveError(err?.message || 'キューへの追加に失敗しました')
    }
  }, [selectedUrls])

  const sourceCount = new Set(
    sections
      .map(section => section.source_sites?.normalized_domain)
      .filter((domain): domain is string => Boolean(domain))
  ).size

  // Category counts for sidebar (STOCK DESIGN style)
  const familyCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    sections.forEach(s => {
      const fam = s.block_family || 'content'
      counts[fam] = (counts[fam] || 0) + 1
    })
    return counts
  }, [sections])

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => () => stopPolling(), [])

  const pollJob = useCallback((jobId: string) => {
    stopPolling()
    let pollCount = 0
    let consecutiveFailures = 0
    const MAX_POLL_COUNT = 150 // 5 minutes at 2s interval
    const MAX_CONSECUTIVE_FAILURES = 5
    pollRef.current = setInterval(async () => {
      pollCount++
      if (pollCount > MAX_POLL_COUNT) {
        stopPolling()
        setError('ジョブがタイムアウトしました。リトライしてください')
        setLoading(false)
        setJobStatus(null)
        return
      }
      try {
        const res = await fetch(`/api/jobs/${jobId}`)
        if (!res.ok) {
          consecutiveFailures++
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            stopPolling()
            setError('サーバーとの通信に連続して失敗しました。リトライしてください')
            setLoading(false)
            setJobStatus(null)
          }
          return
        }
        consecutiveFailures = 0
        const { job } = await res.json() as { job: CrawlJob }
        if (!job) return
        const detail = job.status_detail || ''
        setJobStatus(`${job.status}${detail ? ` - ${detail}` : ''}${job.section_count ? ` (${job.section_count} sections)` : ''}`)

        if (job.status === 'done') {
          stopPolling()
          // Fetch sections
          const secRes = await fetch(`/api/jobs/${jobId}/sections`)
          if (!secRes.ok) { setLoading(false); setJobStatus(null); return }
          const secData = await secRes.json()
          const secs = secData.sections || []
          setLastCrawlSections(secs)
          setSections(prev => {
            const seen = new Set(prev.map(section => section.id))
            const next = [...prev]
            let newCount = 0
            for (const section of secs) {
              if (seen.has(section.id)) continue
              seen.add(section.id)
              next.push(section)
              newCount++
            }
            setLastCrawlNewCount(newCount)
            return next
          })
          // loadingは維持（ターミナル画面で「抽出結果を見る」ボタンを表示）
          setJobStatus(null)
          setView('editor')
        } else if (job.status === 'failed') {
          stopPolling()
          setError(job.error_message || '取得に失敗しました')
          setLoading(false)
          setJobStatus(null)
        }
      } catch {
        consecutiveFailures++
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopPolling()
          setError('サーバーとの通信に連続して失敗しました。リトライしてください')
          setLoading(false)
          setJobStatus(null)
        }
      }
    }, 2000)
  }, [])

  const handleExtract = useCallback(async (url: string, genre: string, tags: string[]) => {
    setLoading(true)
    setError(null)
    setJobStatus('準備中...')
    setLastCrawlSections([])
    setLastCrawlNewCount(0)
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, genre, tags })
      })
      if (!res.ok) {
        let message = 'ジョブの作成に失敗しました'
        try {
          const data = await res.json()
          message = data.error || message
        } catch {}
        throw new Error(message)
      }
      const { jobId } = await res.json()
      setJobStatus('処理待ち...')
      pollJob(jobId)
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
      setJobStatus(null)
    }
  }, [pollJob])

  const addToCanvas = useCallback((sectionId: string) => {
    setCanvas(prev => {
      if (prev.some(c => c.sectionId === sectionId)) return prev
      return [...prev, { id: crypto.randomUUID(), sectionId, position: prev.length }]
    })
  }, [])

  const addSavedToCanvas = useCallback((section: SourceSection) => {
    // Add to sections if not already present
    setSections(prev => {
      if (prev.find(s => s.id === section.id)) return prev
      return [...prev, section]
    })
    setCanvas(prev => {
      if (prev.some(c => c.sectionId === section.id)) return prev
      return [...prev, { id: crypto.randomUUID(), sectionId: section.id, position: prev.length }]
    })
    setView('editor')
  }, [])

  const removeFromCanvas = useCallback((canvasId: string) => {
    setCanvas(prev => prev.filter(c => c.id !== canvasId))
  }, [])

  const moveBlock = useCallback((fromIndex: number, toIndex: number) => {
    setCanvas(prev => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next.map((c, i) => ({ ...c, position: i }))
    })
  }, [])

  const removeSection = useCallback(async (sectionId: string) => {
    try {
      await fetch(`/api/sections/${sectionId}`, { method: 'DELETE' })
    } catch (err: any) {
      setSaveError(err?.message || 'セクションの削除に失敗しました')
    }
    setSections(prev => prev.filter(s => s.id !== sectionId))
    setCanvas(prev => prev.filter(c => c.sectionId !== sectionId))
  }, [])

  const handleViewTsx = useCallback(async (sectionId: string) => {
    try {
      const res = await fetch(`/api/sections/${sectionId}/tsx`)
      if (!res.ok) {
        let message = 'TSXが見つかりません'
        try {
          const data = await res.json()
          message = data.error || message
        } catch {}
        throw new Error(message)
      }
      const { tsx, blockFamily } = await res.json()
      setTsxResult({ tsx, familyName: blockFamily })
    } catch (err: any) {
      alert(err.message)
    }
  }, [])

  const handleExportZip = useCallback(async () => {
    if (canvas.length === 0) return
    setExporting(true)
    try {
      // Pre-check: filter canvas to only include blocks with existing sections
      const sectionIdSet = new Set(sections.map(s => s.id))
      const validBlocks = canvas.filter(b => sectionIdSet.has(b.sectionId))
      const orphanedCount = canvas.length - validBlocks.length
      if (orphanedCount > 0) {
        alert(`${orphanedCount}件の無効なパーツ参照を除外してエクスポートします`)
        // Auto-clean canvas state
        setCanvas(validBlocks)
        if (activeProjectId) {
          fetch(`/api/projects/${activeProjectId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ canvas_json: validBlocks })
          }).catch((err: any) => {
            setSaveError(err?.message || 'Canvasのクリーンアップ保存に失敗しました')
          })
        }
      }
      if (validBlocks.length === 0) {
        alert('エクスポートできるパーツがありません')
        return
      }
      const sectionIds = validBlocks.map(c => c.sectionId)

      // Step 1: Pre-convert sections that don't have TSX yet (one by one with progress)
      const toConvert = validBlocks.filter(b => {
        const sec = sections.find(s => s.id === b.sectionId)
        return sec && !sec.tsx_code_storage_path
      })

      if (toConvert.length > 0) {
        const estimateMin = Math.max(1, Math.ceil(toConvert.length * 1.5))
        for (let i = 0; i < toConvert.length; i++) {
          const block = toConvert[i]
          const sec = sections.find(s => s.id === block.sectionId)
          const familyName = sec?.block_family || 'section'
          setExportProgress({
            message: 'ただいま変換しております',
            estimate: `約${estimateMin}分ほどお待ちください`,
            current: i,
            total: toConvert.length,
            sectionName: familyName
          })
          try {
            const convRes = await fetch(`/api/sections/${block.sectionId}/convert-tsx`, {
              method: 'POST',
              signal: AbortSignal.timeout(360_000) // 6 min per section
            })
            if (convRes.ok) {
              setSections(prev => prev.map(s =>
                s.id === block.sectionId ? { ...s, tsx_code_storage_path: `${s.id}/component.tsx` } : s
              ))
            }
          } catch {
            // Failed — ZIP will use HTML fallback for this section
          }
          setExportProgress({
            message: 'ただいま変換しております',
            estimate: `約${estimateMin}分ほどお待ちください`,
            current: i + 1,
            total: toConvert.length,
            sectionName: familyName
          })
        }
      }

      // Step 2: Generate ZIP (conversions done, server skips already-converted)
      setExportProgress({ message: 'ZIP生成中...' })
      const res = await fetch('/api/export/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionIds, includeImages }),
        signal: AbortSignal.timeout(300_000) // 5 min for ZIP generation
      })
      if (!res.ok) throw new Error('ZIP出力に失敗しました')
      setExportProgress({ message: 'ダウンロード準備中...' })
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'partcopy-export.zip'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setExporting(false)
      setExportProgress(null)
    }
  }, [canvas, sections, includeImages, activeProjectId])

  const handleNewProject = async (name: string) => {
    try {
      const res = await fetch('/api/projects', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name}) })
      if (!res.ok) throw new Error(`プロジェクト作成に失敗しました (${res.status})`)
      const { project } = await res.json()
      setProjectList(prev => [project, ...prev])
      // Save current canvas to old project before switching
      if (activeProjectId) {
        await fetch(`/api/projects/${activeProjectId}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({canvas_json: canvas}) })
      }
      setActiveProjectId(project.id)
      setCanvas([])
      setView('editor')
    } catch (err: any) {
      setSaveError(err?.message || 'プロジェクトの作成に失敗しました')
    }
  }

  const handleSwitchProject = async (projectId: string) => {
    // Save current project's canvas before switching
    if (activeProjectId) {
      try {
        const r = await fetch(`/api/projects/${activeProjectId}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({canvas_json: canvas}) })
        if (!r.ok) throw new Error(`保存失敗: ${r.status}`)
      } catch (err: any) {
        setSaveError(err?.message || '現在のプロジェクトの保存に失敗しました')
        return // Save failed — do NOT proceed with switch
      }
      setProjectList(prev => prev.map(p =>
        p.id === activeProjectId ? { ...p, canvas_json: canvas } : p
      ))
    }
    const target = projectList.find(p => p.id === projectId)
    if (target) {
      const rawCanvas: CanvasBlock[] = target.canvas_json || []
      // Filter out orphaned sectionIds that no longer exist
      const sectionIdSet = new Set(sections.map(s => s.id))
      const validCanvas = rawCanvas.filter(b => sectionIdSet.has(b.sectionId))
      if (validCanvas.length < rawCanvas.length) {
        console.warn(`[PARTCOPY] Removed ${rawCanvas.length - validCanvas.length} orphaned block(s) on project switch`)
        // Auto-save cleaned canvas
        fetch(`/api/projects/${projectId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canvas_json: validCanvas })
        }).catch((err: any) => {
          setSaveError(err?.message || 'クリーンアップ後の保存に失敗しました')
        })
        setProjectList(prev => prev.map(p =>
          p.id === projectId ? { ...p, canvas_json: validCanvas } : p
        ))
      }
      setCanvas(validCanvas)
      setActiveProjectId(projectId)
      setView('editor')
    }
  }

  const handleSaveProject = async () => {
    let projectId = activeProjectId
    let projectName = projectList.find(p => p.id === projectId)?.name || ''

    // プロジェクトが未作成の場合は自動作成
    if (!projectId) {
      const name = prompt('プロジェクト名を入力してください', '新規プロジェクト')
      if (!name) return
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        })
        if (!res.ok) return
        const { project } = await res.json()
        setProjectList(prev => [project, ...prev])
        setActiveProjectId(project.id)
        projectId = project.id
        projectName = project.name
      } catch (err: any) {
        setSaveError(err?.message || 'プロジェクトの作成に失敗しました')
        return
      }
    }

    try {
      const saveRes = await fetch(`/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvas_json: canvas })
      })
      if (!saveRes.ok) throw new Error(`保存に失敗しました (${saveRes.status})`)

      // ローカルのprojectListも更新（パーツ数が反映されるように）
      setProjectList(prev => prev.map(p =>
        p.id === projectId ? { ...p, canvas_json: canvas } : p
      ))

      // トースト通知を表示
      setSaveToast({ projectId: projectId!, projectName })
      setTimeout(() => setSaveToast(null), 5000)
    } catch (err: any) {
      setSaveError(err.message || '保存に失敗しました')
    }
  }

  const handleDeleteProject = async (projectId: string) => {
    if (!confirm('プロジェクトを削除しますか？')) return
    try {
      await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
    } catch (err: any) {
      setSaveError(err?.message || 'プロジェクトの削除に失敗しました')
      return
    }
    setProjectList(prev => prev.filter(p => p.id !== projectId))
    if (activeProjectId === projectId) {
      setActiveProjectId(null)
      setCanvas([])
    }
  }

  const filteredSections = selectedSite
    ? sections.filter(s => s.source_sites?.normalized_domain === selectedSite)
    : sections

  const canvasItems = canvas.map(c => ({
    canvas: c,
    section: sections.find(s => s.id === c.sectionId)!
  })).filter(c => c.section)

  return (
    <div className="app">
      <ErrorBoundary>
      {saveError && (
        <div className="save-error-toast" onClick={() => setSaveError(null)}>
          保存エラー: {saveError}
        </div>
      )}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <h1>PARTCOPY</h1>
          <span className="sidebar-tagline">Web Design Parts Gallery</span>
        </div>

        <div className="sidebar-total">
          <span className="sidebar-total-num">{sections.length}</span>
          <span className="sidebar-total-label">DESIGN STOCK</span>
        </div>

        <nav className="sidebar-nav">
          <span className="sidebar-nav-label">MENU</span>
          <button className={`sidebar-nav-btn ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')}>
            <span className="sidebar-nav-icon">&#9632;</span> ダッシュボード
          </button>
          <button className={`sidebar-nav-btn ${view === 'editor' ? 'active' : ''}`} onClick={() => setView('editor')}>
            <span className="sidebar-nav-icon">&#9998;</span> エディタ
            {canvas.length > 0 && <span className="sidebar-nav-count">{canvas.length}</span>}
          </button>
          <button className={`sidebar-nav-btn ${view === 'preview' ? 'active' : ''}`} onClick={() => setView('preview')}>
            <span className="sidebar-nav-icon">&#9655;</span> プレビュー
          </button>
        </nav>

        <div className="sidebar-saved-projects">
          <span className="sidebar-nav-label">SAVED PROJECTS</span>
          {projectList.map(p => (
            <button
              key={p.id}
              className={`sidebar-saved-btn ${p.id === activeProjectId && view === 'project-detail' ? 'active' : ''}`}
              onClick={() => { setActiveProjectId(p.id); setCanvas(p.canvas_json || []); setView('project-detail') }}
            >
              <span className="sidebar-saved-name">{p.name}</span>
              <span className="sidebar-saved-meta">{resolvedPartCount(p.canvas_json)}パーツ</span>
            </button>
          ))}
          {canvasItems.length > 0 && (
            <button className="sidebar-save-new-btn" onClick={handleSaveProject}>
              + 現在のCanvasを保存
            </button>
          )}
          {projectList.length === 0 && canvasItems.length === 0 && (
            <p className="sidebar-saved-empty">パーツを選んで保存しましょう</p>
          )}
        </div>

        <nav className="sidebar-categories">
          <span className="sidebar-nav-label">SEARCH BY PARTS</span>
          <button
            className={`sidebar-cat-btn ${view === 'library' && !selectedSite ? 'active' : ''}`}
            onClick={() => { setView('library'); setSelectedSite(null) }}
          >
            <span className="sidebar-cat-icon">&#9733;</span>
            <span className="sidebar-cat-name">すべて</span>
            <span className="sidebar-cat-count">{sections.length}</span>
          </button>
          {Object.entries(familyCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([family, count]) => (
              <button
                key={family}
                className={`sidebar-cat-btn ${view === 'library' && selectedSite === family ? 'active' : ''}`}
                onClick={() => { setView('library'); setSelectedSite(family) }}
              >
                <span className="sidebar-cat-icon" style={{ color: FAMILY_COLORS[family] || '#94a3b8' }}>
                  {FAMILY_ICONS[family] || '●'}
                </span>
                <span className="sidebar-cat-name">{FAMILY_LABELS[family] || family}</span>
                <span className="sidebar-cat-count">{count}</span>
              </button>
            ))}
        </nav>

        <div className="sidebar-projects">
          <span className="sidebar-nav-label">PROJECT</span>
          {projectList.map(p => (
            <button
              key={p.id}
              className={`sidebar-project-btn ${p.id === activeProjectId ? 'active' : ''}`}
              onClick={() => handleSwitchProject(p.id)}
            >
              <div className="sidebar-project-info">
                <span className="sidebar-project-name">{p.name}</span>
                <span className="sidebar-project-meta">
                  {resolvedPartCount(p.canvas_json)} パーツ
                  {p.id === activeProjectId && ' · 編集中'}
                </span>
              </div>
              {p.id !== activeProjectId && (
                <span className="sidebar-project-delete" onClick={e => { e.stopPropagation(); handleDeleteProject(p.id) }}>×</span>
              )}
            </button>
          ))}
          {projectList.length === 0 && !showNewProject && (
            <p className="sidebar-project-empty">プロジェクトを作成して、パーツを組み合わせましょう</p>
          )}
          {showNewProject ? (
            <div className="sidebar-project-input">
              <input
                type="text"
                placeholder="プロジェクト名（例: 自社LP）"
                value={newProjectName}
                onChange={e => setNewProjectName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newProjectName.trim()) {
                    handleNewProject(newProjectName.trim())
                    setNewProjectName('')
                    setShowNewProject(false)
                  }
                  if (e.key === 'Escape') setShowNewProject(false)
                }}
                autoFocus
              />
              <button onClick={() => {
                if (newProjectName.trim()) {
                  handleNewProject(newProjectName.trim())
                  setNewProjectName('')
                  setShowNewProject(false)
                }
              }}>作成</button>
            </div>
          ) : (
            <button className="sidebar-project-new" onClick={() => setShowNewProject(true)}>
              + 新規プロジェクト
            </button>
          )}
        </div>

        <div className="sidebar-stats">
          <div className="sidebar-stat"><span>{sourceCount}</span> サイト</div>
          <div className="sidebar-stat"><span>{Object.keys(familyCounts).length}</span> 種別</div>
          <div className="sidebar-stat"><span>{canvas.length}</span> Canvas</div>
        </div>

        {activeProjectId && (
          <div className={`save-status save-status--${saveStatus}`}>
            {saveStatus === 'saving' && '保存中...'}
            {saveStatus === 'saved' && lastSavedAt && `保存済み ${lastSavedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`}
            {saveStatus === 'error' && '保存エラー'}
            {saveStatus === 'idle' && ''}
          </div>
        )}
      </aside>

      <main className="main-content">

      {view === 'dashboard' && <Dashboard sections={sections} canvas={canvas} onNavigate={(v) => setView(v as any)} onExtract={(url) => handleExtract(url, '', [])} extractLoading={loading} />}

      {view === 'project-detail' && (() => {
        const project = projectList.find(p => p.id === activeProjectId)
        if (!project) return <div className="project-detail-empty">プロジェクトが見つかりません</div>
        const projectSections = (project.canvas_json || []).map((block: any) => {
          const section = sections.find(s => s.id === block.sectionId)
          return section ? { canvas: block, section } : null
        }).filter(Boolean) as Array<{ canvas: any; section: any }>
        return (
          <div className="project-detail">
            <div className="project-detail-header">
              <div>
                <h2 className="project-detail-title">{project.name}</h2>
                <p className="project-detail-meta">
                  {projectSections.length} パーツ · 作成日 {new Date(project.created_at).toLocaleDateString('ja-JP')}
                </p>
              </div>
              <div className="project-detail-actions">
                <button className="project-detail-btn edit" onClick={() => { handleSwitchProject(project.id) }}>
                  編集する
                </button>
                <button className="project-detail-btn export" onClick={() => { handleSwitchProject(project.id); setTimeout(() => { setView('preview'); setTimeout(() => handleExportZip(), 300) }, 300) }}>
                  ZIP出力
                </button>
                <button className="project-detail-btn delete" onClick={() => { handleDeleteProject(project.id); setView('dashboard') }}>
                  削除
                </button>
              </div>
            </div>
            {projectSections.length === 0 ? (
              <div className="project-detail-empty-parts">
                <p>このプロジェクトにはまだパーツがありません</p>
                <button className="project-detail-btn edit" onClick={() => handleSwitchProject(project.id)}>パーツを追加する</button>
              </div>
            ) : (
              <div className="project-detail-parts">
                <h3>パーツ一覧</h3>
                <div className="project-detail-grid">
                  {projectSections.map((item, i) => (
                    <div key={item.canvas.id || i} className="project-part-card">
                      <div className="project-part-thumb">
                        {item.section.thumbnail_storage_path ? (
                          <img src={`/assets/${item.section.thumbnail_storage_path}`} alt={item.section.block_family} loading="lazy" />
                        ) : item.section.thumbnailUrl ? (
                          <img src={item.section.thumbnailUrl} alt={item.section.block_family} loading="lazy" />
                        ) : (
                          <div className="project-part-placeholder">{i + 1}</div>
                        )}
                      </div>
                      <div className="project-part-info">
                        <span className="project-part-family">{item.section.block_family}</span>
                        <span className="project-part-domain">{item.section.source_sites?.normalized_domain || ''}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {view === 'editor' && (
        <div className="editor-layout">
          <PartsPanel sections={filteredSections} onAdd={addToCanvas} onRemove={removeSection} onViewTsx={handleViewTsx} />
          <Canvas items={canvasItems} onRemove={removeFromCanvas} onMove={moveBlock} onViewTsx={handleViewTsx} onExportZip={handleExportZip} exporting={exporting} exportProgress={exportProgress} includeImages={includeImages} onToggleIncludeImages={setIncludeImages} onSaveProject={handleSaveProject} onNewProject={() => setShowNewProject(true)} />
        </div>
      )}

      {view === 'preview' && (
        <>
          <Preview items={canvasItems} onExportZip={handleExportZip} exporting={exporting} exportProgress={exportProgress} includeImages={includeImages} onToggleIncludeImages={setIncludeImages} />
          {canvasItems.length > 0 && (
            <div className="preview-project-bar">
              <button className="preview-save-btn" onClick={handleSaveProject}>
                &#128190; プロジェクトとして保存
              </button>
              {activeProjectId && (
                <span className="preview-project-active">
                  編集中: {projectList.find(p => p.id === activeProjectId)?.name || ''}
                </span>
              )}
            </div>
          )}
          {projectList.length > 0 && (
            <div className="project-gallery">
              <h3 className="project-gallery-title">保存済みプロジェクト</h3>
              <div className="project-gallery-grid">
                {projectList.map(p => (
                  <div
                    key={p.id}
                    className={`project-card ${p.id === activeProjectId ? 'active' : ''}`}
                    onClick={() => handleSwitchProject(p.id)}
                  >
                    <div className="project-card-header">
                      <span className="project-card-name">{p.name}</span>
                      {p.id === activeProjectId && <span className="project-card-badge">編集中</span>}
                    </div>
                    <div className="project-card-meta">
                      {resolvedPartCount(p.canvas_json)} パーツ · {new Date(p.created_at).toLocaleDateString('ja-JP')}
                    </div>
                    <div className="project-card-actions">
                      <button className="project-card-edit" onClick={(e) => { e.stopPropagation(); handleSwitchProject(p.id) }}>
                        編集する
                      </button>
                      <button className="project-card-export" onClick={async (e) => {
                        e.stopPropagation()
                        if (!p.canvas_json?.length) return
                        handleSwitchProject(p.id)
                        setTimeout(() => handleExportZip(), 500)
                      }}>
                        ZIP出力
                      </button>
                      {p.id !== activeProjectId && (
                        <button className="project-card-delete" onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id) }}>
                          削除
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {view === 'library' && <Library onAddToCanvas={addSavedToCanvas} initialFamily={selectedSite} />}

      {tsxResult && (
        <TsxModal
          tsx={tsxResult.tsx}
          familyName={tsxResult.familyName}
          onClose={() => setTsxResult(null)}
        />
      )}

      {saveToast && (
        <div className="save-toast">
          <span className="save-toast-check">&#10003;</span>
          <span>「{saveToast.projectName}」に保存しました</span>
          <button
            className="save-toast-btn"
            onClick={() => {
              handleSwitchProject(saveToast.projectId)
              setView('preview')
              setSaveToast(null)
            }}
          >
            プレビューで見る &rarr;
          </button>
          <button className="save-toast-close" onClick={() => setSaveToast(null)}>&times;</button>
        </div>
      )}

      {loading && (
        <div className="loading-overlay">
          <div className="loading-terminal">
            <div className="terminal-header">
              <span className="terminal-dot red" />
              <span className="terminal-dot yellow" />
              <span className="terminal-dot green" />
              <span className="terminal-title">PARTCOPY — 解析中</span>
            </div>
            <div className="terminal-body">
              <div className="terminal-line typing-1">
                <span className="terminal-prompt">$</span> サイトに接続しています...
              </div>
              <div className="terminal-line typing-2">
                <span className="terminal-prompt">$</span> HTML / CSS / 画像 / フォントをダウンロード中...
              </div>
              <div className="terminal-line typing-3">
                <span className="terminal-prompt">$</span> セクションを検出しています...
              </div>
              <div className="terminal-line typing-4">
                <span className="terminal-prompt">$</span> パーツを分類しています...
              </div>
              <div className="terminal-line typing-5">
                <span className="terminal-prompt">&gt;</span> ライブラリに保存中...
              </div>
              {jobStatus && (
                <div className="terminal-status">
                  <span className="terminal-cursor" />
                  {jobStatus}
                </div>
              )}
              {jobStatus && (
                <button className="terminal-cancel-btn" onClick={() => { stopPolling(); setLoading(false); setJobStatus(null) }}>
                  中断する
                </button>
              )}
              {!jobStatus && sections.length > 0 && (
                <>
                  <div className="terminal-done">
                    <span>✓ 抽出完了 — 今回 {lastCrawlSections.length} パーツ取得（新規 {lastCrawlNewCount} 件）</span>
                  </div>
                  <div className="terminal-done-sub">
                    <span>ライブラリ合計: {sections.length} パーツ</span>
                  </div>
                  <div className="terminal-results">
                    {(lastCrawlSections.length > 0 ? lastCrawlSections.slice(-10) : sections.slice(-10)).map((s, i) => (
                      <div key={s.id} className="terminal-result-line" style={{ animationDelay: `${i * 0.15}s` }}>
                        <span className="terminal-prompt">→</span>
                        <span className="result-family">[{s.block_family}]</span>
                        <span className="result-domain">{s.source_sites?.normalized_domain || ''}</span>
                        {s.tsx_code_storage_path && <span className="result-tsx">TSX</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            {!jobStatus && sections.length > 0 && (
              <div className="terminal-footer">
                <button className="terminal-view-btn" onClick={() => { setLoading(false); setView('library') }}>
                  抽出結果を見る →
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      </main>
      </ErrorBoundary>
    </div>
  )
}
