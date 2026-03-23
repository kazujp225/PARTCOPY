import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const sb = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

const sql = readFileSync('supabase/migrations/00003_editable_layer.sql', 'utf-8')

// Execute each statement separately
const statements = sql
  .split(';')
  .map(s => s.trim())
  .filter(s => s.length > 5 && !s.startsWith('--'))

async function run() {
  let success = 0
  let failed = 0

  for (const stmt of statements) {
    try {
      const { error } = await sb.rpc('exec_sql', { sql_text: stmt + ';' })
      if (error) {
        console.log('WARN:', stmt.slice(0, 80), '→', error.message)
        failed++
      } else {
        success++
      }
    } catch (err: any) {
      console.log('ERR:', stmt.slice(0, 80), '→', err.message)
      failed++
    }
  }

  console.log(`Done: ${success} success, ${failed} failed`)
}

run()
