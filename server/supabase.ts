import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { STORAGE_BUCKETS } from './storage-config.js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
export const HAS_SUPABASE = Boolean(SUPABASE_URL && (SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY))

// Service role client - for server-side operations (bypasses RLS)
export const supabaseAdmin = HAS_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY, {
      auth: { persistSession: false }
    })
  : null as any

// Anon client - for RLS-respecting operations
export const supabaseAnon = HAS_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false }
    })
  : null as any
