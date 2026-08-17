import { deepMaskObject, redactSecretsInString } from '../security/masking/mask'

const isProduction = process.env.NODE_ENV === 'production'

function log(level: string, message: string, meta?: object) {
  // A.8.11 / A.8.15: scrub secrets, emails and IPs from log output.
  const safeMessage = redactSecretsInString(message)
  const safeMeta = meta ? (deepMaskObject(meta) as Record<string, unknown>) : undefined
  const entry = { timestamp: new Date().toISOString(), level, message: safeMessage, ...(safeMeta ?? {}) }
  if (isProduction) {
    process.stdout.write(JSON.stringify(entry) + '\n')
  } else {
    console.log(`[${level.toUpperCase()}] ${safeMessage}`, safeMeta ?? '')
  }
}

export const logger = {
  info:  (msg: string, meta?: object) => log('info', msg, meta),
  warn:  (msg: string, meta?: object) => log('warn', msg, meta),
  error: (msg: string, meta?: object) => log('error', msg, meta),
}
