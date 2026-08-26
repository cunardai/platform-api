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
    // Pass the message as an ARGUMENT, never as the format string. Building the
    // first console.log arg by interpolation let a `%s`/`%d` inside the message
    // swallow `safeMeta` as a substitution — forging the line and hiding the
    // metadata. util.format does not re-scan substituted values, so specifiers
    // arriving in `safeMessage` are now printed literally.
    // CR/LF are collapsed as well, so a message cannot fake extra log lines.
    console.log('[%s] %s', level.toUpperCase(), safeMessage.replace(/[\r\n]+/g, ' '), safeMeta ?? '')
  }
}

export const logger = {
  info:  (msg: string, meta?: object) => log('info', msg, meta),
  warn:  (msg: string, meta?: object) => log('warn', msg, meta),
  error: (msg: string, meta?: object) => log('error', msg, meta),
}
