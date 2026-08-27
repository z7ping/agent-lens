import type { SequenceDecision } from './types'

export interface SequenceState {
  ackSequence: number
  incomingSequence: number
  incomingHash: string
  committedHash?: string
}

export function evaluateSequence(state: SequenceState): SequenceDecision {
  if (!Number.isInteger(state.ackSequence) || state.ackSequence < 0) {
    throw new TypeError('ackSequence must be a non-negative integer')
  }
  if (!Number.isInteger(state.incomingSequence) || state.incomingSequence < 1) {
    throw new TypeError('incomingSequence must be a positive integer')
  }

  if (state.incomingSequence === state.ackSequence + 1) return { action: 'process' }
  if (state.incomingSequence > state.ackSequence + 1) {
    return { action: 'reject', errorCode: 'SEQUENCE_GAP' }
  }

  if (state.committedHash && state.committedHash === state.incomingHash) {
    return { action: 'retry-ack' }
  }
  return { action: 'reject', errorCode: 'SEQUENCE_REUSE_CONFLICT' }
}
