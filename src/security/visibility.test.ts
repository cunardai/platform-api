import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVisibleTo, browseScope, isOwnerOf } from './serializers'

const publicMcp  = { org_id: 'org-a', is_public: true }
const privateMcp = { org_id: 'org-a', is_public: false }

// ── isVisibleTo (PA-4, single-record reads) ─────────────────────────────────

test('a public row is visible to everyone, including anonymous', () => {
  assert.equal(isVisibleTo(undefined, publicMcp), true)
  assert.equal(isVisibleTo(null, publicMcp), true)
  assert.equal(isVisibleTo('org-b', publicMcp), true)
  assert.equal(isVisibleTo('org-a', publicMcp), true)
})

test('a private row is visible ONLY to the org that owns it', () => {
  assert.equal(isVisibleTo('org-a', privateMcp), true)
  // The IDOR: these all used to return the full record.
  assert.equal(isVisibleTo('org-b', privateMcp), false)
  assert.equal(isVisibleTo(undefined, privateMcp), false)
  assert.equal(isVisibleTo(null, privateMcp), false)
  assert.equal(isVisibleTo('', privateMcp), false)
})

test('a null org on the row is never matched by a null caller org', () => {
  // Two unknowns must not compare equal into ownership.
  assert.equal(isVisibleTo(null, { org_id: null, is_public: false }), false)
  assert.equal(isVisibleTo(undefined, { org_id: null, is_public: false }), false)
  assert.equal(isOwnerOf(null, null), false)
  assert.equal(isOwnerOf('', ''), false)
})

// ── browseScope (PA-4, registry listing) ────────────────────────────────────

test('no ?org= filter lists public rows only', () => {
  assert.deepEqual(browseScope(undefined, 'org-a'), { org_id: undefined, public_only: true })
  assert.deepEqual(browseScope(undefined, null),    { org_id: undefined, public_only: true })
})

test('?org=<my own org> lists that org including its private rows', () => {
  assert.deepEqual(browseScope('org-a', 'org-a'), { org_id: 'org-a', public_only: false })
})

test('?org=<someone else> lists only their PUBLIC rows', () => {
  // The bug: `public_only: !org` made any supplied org id disable the filter,
  // so this enumerated another tenant's private records.
  assert.deepEqual(browseScope('org-b', 'org-a'), { org_id: 'org-b', public_only: true })
})

test('an anonymous caller cannot widen the listing with ?org=', () => {
  assert.deepEqual(browseScope('org-a', null),      { org_id: 'org-a', public_only: true })
  assert.deepEqual(browseScope('org-a', undefined), { org_id: 'org-a', public_only: true })
  assert.deepEqual(browseScope('org-a', ''),        { org_id: 'org-a', public_only: true })
})

test('the org filter is still applied when narrowing to another org', () => {
  // Public-only must not silently drop the org filter — a caller asking for
  // org-b's public rows should get org-b's, not the whole registry's.
  const scope = browseScope('org-b', 'org-a')
  assert.equal(scope.org_id, 'org-b')
  assert.equal(scope.public_only, true)
})
