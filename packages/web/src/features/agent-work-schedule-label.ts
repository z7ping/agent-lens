/** Only prettify known Hermes "every Ns/Nm/Nh/Nd" strings.
 * Preserve all other native schedules verbatim (including cron expressions). */
export type AgentWorkIntervalUnit = 's' | 'm' | 'h' | 'd'

export function formatAgentWorkSchedule(
  schedule: string,
  format: (unit: AgentWorkIntervalUnit, count: number) => string,
): string {
  const match = /^every\s+([1-9]\d*)\s*([smhd])$/i.exec(schedule.trim())
  if (!match) return schedule
  const count = Number(match[1])
  if (!Number.isSafeInteger(count)) return schedule
  return format(match[2]!.toLowerCase() as AgentWorkIntervalUnit, count)
}
