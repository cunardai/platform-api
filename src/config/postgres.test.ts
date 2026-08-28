import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveDatabaseUrl } from './postgres'

test('resolveDatabaseUrl prefers Azure secret name over legacy DATABASE_URL', () => {
  const previous = {
    POSTGRESQLSANDBOXPLATEFORMAPIURI: process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI,
    DATABASE_URL: process.env.DATABASE_URL,
  }

  process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI = 'postgresql://vault-secret.example/db'
  process.env.DATABASE_URL = 'postgresql://legacy.example/db'

  try {
    assert.equal(resolveDatabaseUrl(), 'postgresql://vault-secret.example/db')
  } finally {
    if (previous.POSTGRESQLSANDBOXPLATEFORMAPIURI === undefined) delete process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI
    else process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI = previous.POSTGRESQLSANDBOXPLATEFORMAPIURI

    if (previous.DATABASE_URL === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous.DATABASE_URL
  }
})

test('resolveDatabaseUrl ignores malformed host-only values like base', () => {
  const previous = {
    POSTGRESQLSANDBOXPLATEFORMAPIURI: process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI,
    DATABASE_URL: process.env.DATABASE_URL,
  }

  process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI = 'base'
  process.env.DATABASE_URL = 'postgresql://safe.example/db'

  try {
    assert.equal(resolveDatabaseUrl(), 'postgresql://safe.example/db')
  } finally {
    if (previous.POSTGRESQLSANDBOXPLATEFORMAPIURI === undefined) delete process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI
    else process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI = previous.POSTGRESQLSANDBOXPLATEFORMAPIURI

    if (previous.DATABASE_URL === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous.DATABASE_URL
  }
})
