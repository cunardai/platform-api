const isProduction = process.env.NODE_ENV === 'production'

function log(level: string, message: string, meta?: object) {
  const entry = { timestamp: new Date().toISOString(), level, message, ...meta }
  if (isProduction) {
    process.stdout.write(JSON.stringify(entry) + '\n')
  } else {
    console.log(`[${level.toUpperCase()}] ${message}`, meta ?? '')
  }
}

export const logger = {
  info:  (msg: string, meta?: object) => log('info', msg, meta),
  warn:  (msg: string, meta?: object) => log('warn', msg, meta),
  error: (msg: string, meta?: object) => log('error', msg, meta),
}
