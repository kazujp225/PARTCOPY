import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

// Service role client - for server-side operations (bypasses RLS)
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
})

// Anon client - for RLS-respecting operations
export const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
})

export const STORAGE_BUCKETS = {
  RAW_HTML: 'corpus-raw-html',
  SANITIZED_HTML: 'corpus-sanitized-html',
  PAGE_SCREENSHOTS: 'corpus-page-screenshots',
  SECTION_THUMBNAILS: 'corpus-section-thumbnails',
  PROJECT_ASSETS: 'project-assets',
  EXPORT_ARTIFACTS: 'export-artifacts'
} as const
