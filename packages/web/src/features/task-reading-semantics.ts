/**
 * One source-neutral reading contract for Live and Review. This layer decides
 * information hierarchy, never manufactures native message phases or events.
 */
export type TaskReadingFactKind =
  | 'prompt'
  | 'reasoning'
  | 'commentary'
  | 'tool'
  | 'answer'
  | 'unclassified-answer'
  | 'auxiliary'

export interface TaskReadingFact<T> {
  id: string
  kind: TaskReadingFactKind
  value: T
  error?: boolean
}

export interface TaskReadingProjection<T> {
  prompts: TaskReadingFact<T>[]
  process: TaskReadingFact<T>[]
  answers: TaskReadingFact<T>[]
  auxiliary: TaskReadingFact<T>[]
  processCounts: {
    thinking: number
    commentary: number
    tools: number
    errors: number
  }
}

/**
 * Keep native order inside each semantic lane. Unknown assistant phase stays
 * visible as unclassified text; it is never silently promoted to native final.
 */
export function projectTaskReading<T>(facts: readonly TaskReadingFact<T>[]): TaskReadingProjection<T> {
  const prompts: TaskReadingFact<T>[] = []
  const process: TaskReadingFact<T>[] = []
  const answers: TaskReadingFact<T>[] = []
  const auxiliary: TaskReadingFact<T>[] = []
  let thinking = 0
  let commentary = 0
  let tools = 0
  let errors = 0

  for (const fact of facts) {
    switch (fact.kind) {
      case 'prompt':
        prompts.push(fact)
        break
      case 'reasoning':
        process.push(fact)
        thinking += 1
        break
      case 'commentary':
        process.push(fact)
        commentary += 1
        break
      case 'tool':
        process.push(fact)
        tools += 1
        if (fact.error) errors += 1
        break
      case 'answer':
      case 'unclassified-answer':
        answers.push(fact)
        break
      case 'auxiliary':
        auxiliary.push(fact)
        break
    }
  }
  return {
    prompts, process, answers, auxiliary,
    processCounts: { thinking, commentary, tools, errors },
  }
}
