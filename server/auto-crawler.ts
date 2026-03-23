/**
 * Auto-Crawler - Processes URLs from a queue file automatically.
 *
 * Reads URLs from .partcopy/crawl-queue.txt and submits them
 * to /api/extract one at a time with random delays to avoid detection.
 */
import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { logger } from './logger.js'

const QUEUE_FILE = path.resolve(process.cwd(), '.partcopy/crawl-queue.txt')
const DONE_FILE = path.resolve(process.cwd(), '.partcopy/crawl-done.txt')
const CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes
const MIN_DELAY = 30_000 // 30 seconds
const MAX_DELAY = 90_000 // 90 seconds
const API_PORT = Number(process.env.PARTCOPY_API_PORT || 3002)
const API_BASE = `http://127.0.0.1:${API_PORT}`

let active = false
let currentUrl: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

export function isAutoCrawlActive(): boolean {
  return active
}

export function getCurrentCrawlUrl(): string | null {
  return currentUrl
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
 * Remove the first URL from the queue file.
 */
async function dequeueFirst(): Promise<void> {
  const lines = await readQueue()
  if (lines.length <= 1) {
    await writeFile(QUEUE_FILE, '', 'utf-8')
  } else {
    await writeFile(QUEUE_FILE, lines.slice(1).join('\n') + '\n', 'utf-8')
  }
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

    // Poll for job completion (max 5 minutes)
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline && !stopped) {
      await new Promise(r => setTimeout(r, 5000))

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
 * Main check loop: process one URL from the queue if available.
 */
async function checkAndProcess(): Promise<void> {
  if (stopped || active) return

  const queue = await readQueue()
  if (queue.length === 0) {
    logger.debug('Auto-crawl: queue is empty')
    return
  }

  const url = queue[0]
  active = true
  currentUrl = url

  try {
    await submitAndWait(url)

    // Move URL from queue to done regardless of success/failure
    await dequeueFirst()
    await markDone(url)

    logger.info('Auto-crawl: URL processed and moved to done', { url })
  } catch (err: any) {
    logger.error('Auto-crawl: processing error', { url, error: err.message })
  } finally {
    currentUrl = null
  }

  // If there are more URLs, schedule the next one with a random delay
  if (!stopped) {
    const remaining = await readQueue()
    if (remaining.length > 0) {
      const delay = randomDelay()
      currentUrl = `次のURL待機中... (${Math.round(delay / 1000)}秒後)`
      logger.info('Auto-crawl: next URL in queue, waiting before processing', {
        nextUrl: remaining[0],
        delayMs: delay,
        remainingCount: remaining.length
      })
      timer = setTimeout(() => {
        checkAndProcess().catch(err => {
          logger.error('Auto-crawl: scheduled check failed', { error: err.message })
          active = false
          currentUrl = null
        })
      }, delay)
    } else {
      active = false
    }
  } else {
    active = false
  }
}

/**
 * Start the auto-crawler. Only starts if the queue file exists.
 */
export function startAutoCrawler(): void {
  if (!existsSync(QUEUE_FILE)) {
    logger.info('Auto-crawl: queue file not found, auto-crawler not started', { path: QUEUE_FILE })
    return
  }

  stopped = false
  logger.info('Auto-crawl: starting auto-crawler', { checkIntervalMs: CHECK_INTERVAL })

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
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
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
}> {
  const queue = await readQueue()
  const done = await readDone()
  return {
    queue,
    done,
    active,
    currentUrl
  }
}
