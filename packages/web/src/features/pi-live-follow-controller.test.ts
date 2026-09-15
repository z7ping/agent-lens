import assert from 'node:assert/strict'
import test from 'node:test'
import { PiLiveFollowController } from './pi-live-follow-controller'

test('reader detaches on user upward intent and does not get pulled back by programmatic scroll events', () => {
  const controller = new PiLiveFollowController(140)
  controller.detach()
  assert.equal(controller.isFollowing, false)

  controller.beginProgrammaticScroll()
  assert.equal(controller.observeScroll(0), false)
  controller.endProgrammaticScroll()
  assert.equal(controller.isFollowing, false)
})

test('reader resumes follow only after user returns near bottom or explicitly restores', () => {
  const controller = new PiLiveFollowController(140)
  controller.markUserIntent()
  assert.equal(controller.observeScroll(320), false)

  controller.markUserIntent()
  assert.equal(controller.observeScroll(80), true)

  controller.detach()
  controller.restore()
  assert.equal(controller.isFollowing, true)
  assert.equal(controller.snapshot().detachCount, 2)
  assert.equal(controller.snapshot().restoreCount, 1)
})

test('programmatic scroll writes are counted independently from user follow decisions', () => {
  const controller = new PiLiveFollowController()
  controller.beginProgrammaticScroll()
  controller.recordScrollWrite()
  controller.observeScroll(0)
  controller.endProgrammaticScroll()
  assert.equal(controller.snapshot().scrollWrites, 1)
  assert.equal(controller.isFollowing, true)
})
