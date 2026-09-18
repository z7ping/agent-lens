export type StartupSessionStage =
  | 'runtime.ready'
  | 'projection.run.dirty'
  | 'source.prepare.started'
  | 'source.prepare.completed'
  | 'source.capture.started'
  | 'history.latest.started'
  | 'history.latest.source.completed'
  | 'history.latest.completed'
  | 'observation.firstCommitted'
  | 'sessionSummary.firstReady'
  | 'review.firstQuery'
  | 'review.firstSessionVisible'

export interface StartupSessionMark {
  stage: StartupSessionStage
  at: string
  elapsedMs: number
  sourceId?: string
  records?: number
  visibleCount?: number
}

export interface StartupSessionDiagnosticsSnapshot {
  startedAt: string
  updatedAt: string
  marks: StartupSessionMark[]
}

const MAX_MARKS = 64

export class StartupSessionDiagnostics {
  private readonly startedAtMs: number
  private readonly startedAtIso: string
  private readonly marks: StartupSessionMark[] = []
  private readonly firstStages = new Set<StartupSessionStage>()

  constructor(startedAtMs = Date.now()) {
    this.startedAtMs = startedAtMs
    this.startedAtIso = new Date(startedAtMs).toISOString()
  }

  mark(
    stage: StartupSessionStage,
    details: Pick<StartupSessionMark, 'sourceId' | 'records' | 'visibleCount'> = {},
  ): void {
    if (this.marks.length >= MAX_MARKS) return
    const now = Date.now()
    this.marks.push({
      stage,
      at: new Date(now).toISOString(),
      elapsedMs: Math.max(0, now - this.startedAtMs),
      ...details,
    })
  }

  markFirst(
    stage: StartupSessionStage,
    details: Pick<StartupSessionMark, 'sourceId' | 'records' | 'visibleCount'> = {},
  ): void {
    if (this.firstStages.has(stage)) return
    this.firstStages.add(stage)
    this.mark(stage, details)
  }

  snapshot(): StartupSessionDiagnosticsSnapshot {
    return {
      startedAt: this.startedAtIso,
      updatedAt: this.marks.at(-1)?.at ?? this.startedAtIso,
      marks: this.marks.map(mark => ({ ...mark })),
    }
  }
}
