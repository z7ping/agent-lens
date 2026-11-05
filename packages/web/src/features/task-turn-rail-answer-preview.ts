/** Build a compact rail hint only from already loaded, actual message text.
 * Unloaded/partial turns must keep the native index's original prompt preview. */
export function taskTurnRailAnswerPreview(
  prompt: string | undefined,
  answer: string | undefined,
  labels: { question: string; answer: string },
): string {
  const trim = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
  const question = trim(prompt)
  const response = trim(answer)
  if (!response) return question
  const excerpt = (value: string, limit: number) => value.length > limit
    ? `${value.slice(0, limit - 1)}…` : value
  if (!question) return `${labels.answer}: ${excerpt(response, 75)}`
  return `${labels.question}: ${excerpt(question, 34)} · ${labels.answer}: ${excerpt(response, 36)}`
}
