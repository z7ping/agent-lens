import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { profiledDshSourceDefinition } from './index'

test('DSH detection maps multiple profile roots to RuntimeProfile identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-dsh-profiled-'))
  const profiles = join(root, 'profiles')
  try {
    for (const name of ['default', 'work']) {
      const profile = join(profiles, name)
      await mkdir(profile, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({ name: `dsh-${name}` }), 'utf8')
    }

    const detected = await profiledDshSourceDefinition.detect({
      host: {
        id: 'host-test',
        name: 'test',
        platform: process.platform,
        arch: process.arch,
        createdAt: '2026-09-16T00:00:00.000Z',
        lastSeenAt: '2026-09-16T00:00:00.000Z',
      },
      env: { DSH_HOME: root },
    })

    assert.equal(detected.length, 2)
    assert.deepEqual(
      detected.map(item => item.runtimeProfile?.nativeProfileId).sort(),
      ['default', 'work'],
    )
    assert.equal(detected.every(item => item.sourceId === 'dsh' && item.productId === 'dsh'), true)
    assert.equal(detected.every(item => Boolean(item.runtimeProfile?.configRoot && item.runtimeProfile?.dataRoot)), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
