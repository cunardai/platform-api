import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveDatabaseUrl } from './postgres'

test('resolveDatabaseUrl prefers Azure secret name over legacy DATABASE_URL', () => {
  const previous = {
    POSTGRESQLDBSANDBOXURI: process.env.POSTGRESQLDBSANDBOXURI,
    DATABASE_URL: process.env.DATABASE_URL,
  }

  process.env.POSTGRESQLDBSANDBOXURI = 'postgresql://vault-secret.example/db'
  process.env.DATABASE_URL = 'postgresql://legacy.example/db'

  try {
    assert.equal(resolveDatabaseUrl(), 'postgresql://vault-secret.example/db')
  } finally {
    if (previous.POSTGRESQLDBSANDBOXURI === undefined) delete process.env.POSTGRESQLDBSANDBOXURI
    else process.env.POSTGRESQLDBSANDBOXURI = previous.POSTGRESQLDBSANDBOXURI

    if (previous.DATABASE_URL === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous.DATABASE_URL
  }
})
