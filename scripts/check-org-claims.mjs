#!/usr/bin/env node
// ── X-2: no handler may take an org identity from the client ─────────────────
//
// The through-line of the audit this implements: services AUTHENTICATED but
// did not AUTHORIZE, because identity was asserted by the caller — an
// X-Org-Id header, an X-On-Behalf-Of-Org header, or an org field in the body —
// and trusted without checking the caller owns it. Every fix removes one of
// those reads. This script stops the next one being added.
//
// The rule: org scope comes from `req.caller`, which is built only from a
// JWKS-verified JWT, a hashed API key, or the service token. Reading an org
// out of req.headers / req.body / req.query is a finding.
//
// Usage:
//   node scripts/check-org-claims.mjs             # scan src/, exit 1 on a finding
//   node scripts/check-org-claims.mjs --list      # print the allowlist and exit
//   node scripts/check-org-claims.mjs --self-test # check the patterns themselves
//
// To allow a genuinely safe read, add it to ALLOWLIST below WITH a reason. The
// bar is that the file itself establishes the caller owns that org — being
// "behind auth" is not enough, since that was true of every finding in the
// audit.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SCAN_DIRS = ['src']

// `(req.body as any).orgId` and `(req.body as { org_id?: string }).org_id` are
// how most of this codebase actually reads request fields, so patterns that
// only matched a bare `req.body.orgId` would find almost nothing. `CAST`
// allows an optional TypeScript cast plus the closing parenthesis that goes
// with it, between the request object and the property being read.
//
// The cast body must not span lines. Allowing it to made the pattern run past
// the end of the statement and rejoin a `req.caller?.org_id` several lines
// later, reporting the safe read as a finding — the kind of false positive
// that gets a check switched off.
const CAST = String.raw`(?:\s+as\s+[^)\n]*)?\s*\)?\s*`
const from = (prop) => String.raw`\(?\s*req\s*\.\s*${prop}${CAST}`
const KEY = (name) => String.raw`\[\s*['"\`]${name}['"\`]\s*\]`

// Patterns that read an org identity from something the client controls.
const PATTERNS = [
  { re: new RegExp(from('headers') + KEY('x-org-id'), 'gi'),            what: "req.headers['x-org-id']" },
  { re: new RegExp(from('headers') + KEY('x-on-behalf-of-org'), 'gi'),  what: "req.headers['x-on-behalf-of-org']" },
  { re: new RegExp(from('body') + String.raw`\.\s*org(_?id)?\b`, 'gi'), what: 'req.body.org / req.body.orgId' },
  { re: new RegExp(from('body') + KEY('org(_?id)?'), 'gi'),             what: 'req.body["org_id"]' },
  { re: new RegExp(from('query') + String.raw`\.\s*org_?id\b`, 'gi'),   what: 'req.query.orgId' },
  { re: new RegExp(from('query') + KEY('org_?id'), 'gi'),               what: 'req.query["org_id"]' },
  // Destructuring hides the read from the patterns above.
  { re: /\{[^{}]*\borg_?id\b[^{}]*\}\s*=\s*\(?\s*req\s*\.\s*(body|query|headers)\b/gi, what: 'destructured org_id from req.body / req.query' },
]

// file → [{ what, why }]. A reason is mandatory; an entry without one fails.
const ALLOWLIST = {
  'src/middleware/auth.middleware.ts': [
    {
      what: "req.headers['x-on-behalf-of-org']",
      why: 'The service-token path. Read only AFTER the shared service token is verified in constant time, and only for a caller the platform itself trusts — never for a user or API-key caller. This is the single sanctioned entry point; requireService in middleware/authz.ts is what keeps privileged routes limited to it.',
    },
  ],
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(p)
  }
  return out
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

function scanText(text) {
  const hits = []
  for (const { re, what } of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      hits.push({ what, line: lineOf(text, m.index), snippet: m[0].replace(/\s+/g, ' ').trim() })
      if (m.index === re.lastIndex) re.lastIndex++ // zero-length match guard
    }
  }
  return hits
}

// ── --self-test: the patterns must actually catch the shapes we care about ──
if (process.argv.includes('--self-test')) {
  const MUST_CATCH = [
    `req.headers['x-org-id']`,
    `req.headers["x-on-behalf-of-org"]`,
    `(req.body as any).orgId`,
    `(req.body as any).org`,
    `(req.body as { org_id?: string }).org_id`,
    `(req.body as any)['org_id']`,
    `req.query.org_id`,
    `(req.query as Record<string, string>)['orgId']`,
    `const { org_id } = req.body as any`,
    `const orgId = req.headers [ 'x-org-id' ]`,
  ]
  // Legitimate reads that must NOT be flagged, or the check becomes noise
  // developers learn to ignore.
  const MUST_IGNORE = [
    `req.caller?.org_id`,
    `req.caller.org_id ?? null`,
    `const { org, limit } = req.query`, // registry browse filter, made safe by browseScope
    `organizations.org_id`,
    `row.org_id === caller.org_id`,
    `payload.org_id as string`,
    // A cast on one line and a safe `req.caller...org_id` further down must not
    // be joined into a single match across the intervening lines.
    [
      `const { org, limit } = req.query as Record<string, string | undefined>`,
      `const mcps = await listMcps({`,
      `  ...browseScope(org, req.caller?.org_id),`,
      `})`,
    ].join('\n'),
  ]
  let failed = 0
  for (const s of MUST_CATCH) {
    if (scanText(s).length === 0) {
      console.error(`  MISSED: ${s}`)
      failed++
    }
  }
  for (const s of MUST_IGNORE) {
    const hits = scanText(s)
    if (hits.length) {
      console.error(`  FALSE POSITIVE: ${s} -> ${hits.map((h) => h.what).join(', ')}`)
      failed++
    }
  }
  if (failed) {
    console.error(`\n✗ self-test: ${failed} case(s) wrong`)
    process.exit(1)
  }
  console.log(`✓ self-test: ${MUST_CATCH.length} caught, ${MUST_IGNORE.length} correctly ignored`)
  process.exit(0)
}

if (process.argv.includes('--list')) {
  for (const [file, entries] of Object.entries(ALLOWLIST)) {
    console.log(`\n${file}`)
    for (const e of entries) console.log(`  ${e.what}\n    ${e.why}`)
  }
  process.exit(0)
}

const badAllowlist = Object.entries(ALLOWLIST).flatMap(([file, entries]) =>
  entries.filter((e) => !e.why || e.why.trim().length < 20).map((e) => `${file}: "${e.what}" has no usable reason`),
)
if (badAllowlist.length) {
  console.error('✗ Allowlist entries must carry a real justification:')
  for (const b of badAllowlist) console.error(`  ${b}`)
  process.exit(1)
}

const findings = []
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split(sep).join('/')
    const allowed = new Set((ALLOWLIST[rel] ?? []).map((e) => e.what))
    for (const hit of scanText(readFileSync(file, 'utf8'))) {
      if (!allowed.has(hit.what)) findings.push({ rel, ...hit })
    }
  }
}

if (findings.length === 0) {
  console.log('✓ no unverified org-identity reads in src/')
  process.exit(0)
}

console.error(`✗ ${findings.length} unverified org-identity read(s):\n`)
for (const f of findings.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
  console.error(`  ${f.rel}:${f.line}  ${f.snippet}`)
}
console.error(`
Org scope must be derived from a VERIFIED credential, not asserted by the
caller. Use req.caller.org_id (set by authenticate() from a verified JWT, a
hashed API key, or the service token) and role-check privileged actions with
middleware/authz.ts.

If a read really is safe, add it to ALLOWLIST in scripts/check-org-claims.mjs
with a reason explaining how the caller's ownership of that org is established.`)
process.exit(1)
