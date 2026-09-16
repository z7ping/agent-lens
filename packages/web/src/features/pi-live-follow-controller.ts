export interface PiLiveFollowDiagnostics {
  scrollWrites: number
  detachCount: number
  restoreCount: number
}

/**
 * Single owner for Pi Live reader follow state.
 *
 * User input may detach immediately; programmatic scroll events never change
 * the decision unless a user gesture happened while the write was in flight.
 */
export class PiLiveFollowController {
  private following = true
  private programmatic = false
  private userIntent = false
  private diagnostics: PiLiveFollowDiagnostics = {
    scrollWrites: 0,
    detachCount: 0,
    restoreCount: 0,
  }

  constructor(private readonly bottomThresholdPx = 140) {}

  get isFollowing(): boolean {
    return this.following
  }

  markUserIntent(): void {
    this.userIntent = true
  }

  detach(): void {
    if (this.following) this.diagnostics.detachCount += 1
    this.following = false
    this.userIntent = false
  }

  restore(): void {
    if (!this.following) this.diagnostics.restoreCount += 1
    this.following = true
    this.userIntent = false
  }

  beginProgrammaticScroll(): void {
    this.programmatic = true
  }

  endProgrammaticScroll(): void {
    this.programmatic = false
  }

  recordScrollWrite(): void {
    this.diagnostics.scrollWrites += 1
  }

  observeScroll(distanceFromBottomPx: number): boolean {
    if (this.programmatic && !this.userIntent) return this.following
    const nearBottom = distanceFromBottomPx < this.bottomThresholdPx
    const wasFollowing = this.following
    if (this.userIntent || !nearBottom) this.following = nearBottom
    else if (nearBottom) this.following = true
    if (wasFollowing && !this.following) this.diagnostics.detachCount += 1
    this.userIntent = false
    return this.following
  }

  snapshot(): PiLiveFollowDiagnostics {
    return { ...this.diagnostics }
  }
}
