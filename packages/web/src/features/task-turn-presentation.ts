export type TaskTurnSemanticKind = 'prompt' | 'assistant' | 'process' | 'artifact' | 'meta'

/**
 * 只根据一轮内已经确认的语义角色识别最终 Assistant 段：
 * 最后一个明确 process 驱动事实之后出现的 Assistant 文本，才有资格成为最终输出。
 *
 * 调用方仍负责使用自己的原生事实排除“带 Tool Call 的中间 Assistant”等来源特例；
 * 本函数不根据相邻时间或文本内容猜测。
 */
export function taskTurnFinalAssistantIndexes<T>(
  items: readonly T[],
  classify: (item: T, index: number) => TaskTurnSemanticKind,
): Set<number> {
  let lastProcessIndex = -1
  for (let index = 0; index < items.length; index += 1) {
    if (classify(items[index]!, index) === 'process') lastProcessIndex = index
  }

  const result = new Set<number>()
  for (let index = lastProcessIndex + 1; index < items.length; index += 1) {
    if (classify(items[index]!, index) === 'assistant') result.add(index)
  }
  return result
}
