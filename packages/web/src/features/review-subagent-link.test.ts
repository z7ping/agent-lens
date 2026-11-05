import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionRelationshipDto } from '@agent-lens/protocol'
import { verifiedSubagentReviewTarget } from './review-subagent-link'

const exact = { id: 'rel', fromSessionId: 'parent', toSessionId: 'child',
  type: 'subagent', confidence: 'exact' } satisfies SessionRelationshipDto

test('only source-attested subagents from selected parent can open native Review', () => {
  assert.equal(verifiedSubagentReviewTarget(exact, 'parent'), 'child')
  assert.equal(verifiedSubagentReviewTarget(exact, 'child'), undefined)
  assert.equal(verifiedSubagentReviewTarget({ ...exact, type: 'native-parent' }, 'parent'), undefined)
  assert.equal(verifiedSubagentReviewTarget({ ...exact, type: 'fork' }, 'parent'), undefined)
  assert.equal(verifiedSubagentReviewTarget({ ...exact, confidence: 'high' }, 'parent'), undefined)
  assert.equal(verifiedSubagentReviewTarget({ ...exact, confidence: 'unknown' }, 'parent'), undefined)
  assert.equal(verifiedSubagentReviewTarget({ ...exact, toSessionId: 'parent' }, 'parent'), undefined)
  assert.equal(verifiedSubagentReviewTarget({ ...exact, toSessionId: ' ' }, 'parent'), undefined)
})
