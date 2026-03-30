/**
 * Auto-Crawler - Processes URLs from a queue file automatically.
 *
 * Reads URLs from .partcopy/crawl-queue.txt and submits them
 * to /api/extract with parallel processing (up to CONCURRENCY).
 */
import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { logger } from './logger.js'

const QUEUE_FILE = path.resolve(process.cwd(), '.partcopy/crawl-queue.txt')
const DONE_FILE = path.resolve(process.cwd(), '.partcopy/crawl-done.txt')
const CHECK_INTERVAL = 10_000 // 10秒ごとにキューをチェック
const MIN_DELAY = 2_000 // 2秒（バッチ間の待機）
const MAX_DELAY = 5_000 // 5秒
const CONCURRENCY = 2 // 同時処理数
const API_PORT = Number(process.env.PARTCOPY_API_PORT || 3002)
const API_BASE = `http://127.0.0.1:${API_PORT}`

let activeCount = 0
let activeUrls: string[] = []
let stopped = false

export function isAutoCrawlActive(): boolean {
  return activeCount > 0
}

export function getCurrentCrawlUrl(): string | null {
  if (activeUrls.length === 0) return null
  if (activeUrls.length === 1) return activeUrls[0]
  return `${activeUrls.length}件を並列処理中`
}

/**
 * Read the queue file and return non-empty, trimmed lines.
 */
async function readQueue(): Promise<string[]> {
  if (!existsSync(QUEUE_FILE)) return []
  try {
    const content = await readFile(QUEUE_FILE, 'utf-8')
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && /^https?:\/\//i.test(line))
  } catch {
    return []
  }
}

/**
 * Read the done file and return completed URLs.
 */
async function readDone(): Promise<string[]> {
  if (!existsSync(DONE_FILE)) return []
  try {
    const content = await readFile(DONE_FILE, 'utf-8')
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
  } catch {
    return []
  }
}

/**
 * Remove specific URLs from the queue file.
 */
async function dequeueUrls(urls: string[]): Promise<void> {
  const removeSet = new Set(urls)
  const lines = await readQueue()
  const remaining = lines.filter(line => !removeSet.has(line))
  await writeFile(QUEUE_FILE, remaining.length > 0 ? remaining.join('\n') + '\n' : '', 'utf-8')
}

/**
 * Append a URL to the done file with a timestamp.
 */
async function markDone(url: string): Promise<void> {
  const dir = path.dirname(DONE_FILE)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  const entry = `${url}\t${new Date().toISOString()}\n`
  await appendFile(DONE_FILE, entry, 'utf-8')
}

/**
 * Submit a URL to the extract API and wait for the job to complete.
 */
async function submitAndWait(url: string): Promise<boolean> {
  try {
    logger.info('Auto-crawl: submitting URL', { url })

    const res = await fetch(`${API_BASE}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, genre: '', tags: ['auto-crawl'] })
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logger.warn('Auto-crawl: extract API returned error', { url, status: res.status, body })
      return false
    }

    const { jobId } = await res.json() as { jobId: string }
    logger.info('Auto-crawl: job created', { url, jobId })

    // Poll for job completion (max 3 minutes)
    const deadline = Date.now() + 3 * 60 * 1000
    while (Date.now() < deadline && !stopped) {
      await new Promise(r => setTimeout(r, 2000))

      try {
        const statusRes = await fetch(`${API_BASE}/api/jobs/${jobId}`)
        if (!statusRes.ok) continue
        const { job } = await statusRes.json() as { job: { status: string; error_message?: string } }
        if (!job) continue

        if (job.status === 'done') {
          logger.info('Auto-crawl: job completed', { url, jobId })
          return true
        }
        if (job.status === 'failed') {
          logger.warn('Auto-crawl: job failed', { url, jobId, error: job.error_message })
          return false
        }
      } catch {
        // transient error, keep polling
      }
    }

    logger.warn('Auto-crawl: job timed out waiting for completion', { url, jobId })
    return false
  } catch (err: any) {
    logger.error('Auto-crawl: submit failed', { url, error: err.message })
    return false
  }
}

/**
 * Generate a random delay between MIN_DELAY and MAX_DELAY.
 */
function randomDelay(): number {
  return MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY))
}

/**
 * Main check loop: take up to CONCURRENCY URLs and process in parallel.
 */
async function checkAndProcess(): Promise<void> {
  if (stopped || activeCount > 0) return

  const queue = await readQueue()
  if (queue.length === 0) {
    logger.debug('Auto-crawl: queue is empty')
    return
  }

  // Take up to CONCURRENCY URLs
  const batch = queue.slice(0, CONCURRENCY)
  activeCount = batch.length
  activeUrls = [...batch]

  logger.info('Auto-crawl: starting batch', { count: batch.length, urls: batch })

  const results = await Promise.allSettled(
    batch.map(async (url) => {
      try {
        await submitAndWait(url)
      } finally {
        await markDone(url)
        // Remove from active list as each completes
        activeUrls = activeUrls.filter(u => u !== url)
      }
    })
  )

  // Remove processed URLs from queue
  await dequeueUrls(batch)

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      logger.error('Auto-crawl: processing error', { url: batch[i], error: (results[i] as PromiseRejectedResult).reason?.message })
    } else {
      logger.info('Auto-crawl: URL processed', { url: batch[i] })
    }
  }

  activeCount = 0
  activeUrls = []

  // If there are more URLs, schedule the next batch with a delay
  if (!stopped) {
    const remaining = await readQueue()
    if (remaining.length > 0) {
      const delay = randomDelay()
      activeUrls = [`次のバッチ待機中... (${Math.round(delay / 1000)}秒後)`]
      logger.info('Auto-crawl: more URLs in queue, waiting before next batch', {
        delayMs: delay,
        remainingCount: remaining.length
      })
      setTimeout(() => {
        activeUrls = []
        checkAndProcess().catch(err => {
          logger.error('Auto-crawl: scheduled check failed', { error: err.message })
          activeCount = 0
          activeUrls = []
        })
      }, delay)
    }
  }
}

/**
 * Start the auto-crawler. Periodically checks for queued URLs.
 */
export function startAutoCrawler(): void {

  stopped = false
  logger.info('Auto-crawl: starting auto-crawler', { checkIntervalMs: CHECK_INTERVAL, concurrency: CONCURRENCY })

  // Initial check
  checkAndProcess().catch(err => {
    logger.error('Auto-crawl: initial check failed', { error: err.message })
  })

  // Periodic check every CHECK_INTERVAL
  const interval = setInterval(() => {
    if (stopped) {
      clearInterval(interval)
      return
    }
    checkAndProcess().catch(err => {
      logger.error('Auto-crawl: periodic check failed', { error: err.message })
    })
  }, CHECK_INTERVAL)

  // Don't block process exit
  interval.unref()
}

/**
 * Stop the auto-crawler gracefully.
 */
export function stopAutoCrawler(): void {
  stopped = true
  logger.info('Auto-crawl: stopped')
}

/**
 * Append URLs to the queue file.
 */
export async function appendToQueue(urls: string[]): Promise<number> {
  const dir = path.dirname(QUEUE_FILE)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  const validUrls = urls
    .map(u => u.trim())
    .filter(u => u.length > 0 && /^https?:\/\//i.test(u))

  if (validUrls.length === 0) return 0

  await appendFile(QUEUE_FILE, validUrls.join('\n') + '\n', 'utf-8')
  return validUrls.length
}

/**
 * Clear the queue file.
 */
export async function clearQueue(): Promise<void> {
  if (existsSync(QUEUE_FILE)) {
    await writeFile(QUEUE_FILE, '', 'utf-8')
  }
}

/**
 * Get queue status for API responses.
 */
export async function getQueueStatus(): Promise<{
  queue: string[]
  done: string[]
  active: boolean
  currentUrl: string | null
  concurrency: number
}> {
  const queue = await readQueue()
  const done = await readDone()

  // メモリ変数がtrueならそれを使う（workerプロセス内）
  if (activeCount > 0) {
    return { queue, done, active: true, currentUrl: getCurrentCrawlUrl(), concurrency: CONCURRENCY }
  }

  // APIサーバーからの呼び出し: キューにURLがあれば実行中とみなす
  const isProcessing = queue.length > 0
  const processingUrl = queue.length > 0 ? queue[0] : null

  return {
    queue,
    done,
    active: isProcessing,
    currentUrl: processingUrl,
    concurrency: CONCURRENCY
  }
}
