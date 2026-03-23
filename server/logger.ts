type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const MIN_LEVEL = (process.env.LOG_LEVEL as LogLevel) || 'info'

function log(level: LogLevel, message: string, context?: Record<string, any>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...context
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(JSON.stringify(entry))
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, any>) => log('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, any>) => log('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, any>) => log('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, any>) => log('error', msg, ctx),
}
