export interface LiveControlDisplayInfoDto {
  label?: string | undefined
  description?: string | undefined
}

export interface LiveControlOptionDto extends LiveControlDisplayInfoDto {
  /** Runtime-owned opaque value; surfaces must round-trip it unchanged. */
  value: string
}

export interface LiveThinkingControlDto extends LiveControlDisplayInfoDto {
  capability: 'thinking-control'
  value: string
  options: LiveControlOptionDto[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

export function parseLiveThinkingControlDto(value: unknown): LiveThinkingControlDto | null {
  const control = record(value)
  if (!control || control.capability !== 'thinking-control') return null
  if (typeof control.value !== 'string' || !control.value) return null
  if (!Array.isArray(control.options) || control.options.length === 0) return null

  const label = optionalText(control.label)
  const description = optionalText(control.description)
  if (label === null || description === null) return null

  const options: LiveControlOptionDto[] = []
  let hasCurrent = false
  for (const candidate of control.options) {
    const option = record(candidate)
    if (!option || typeof option.value !== 'string' || !option.value) return null
    const optionLabel = optionalText(option.label)
    const optionDescription = optionalText(option.description)
    if (optionLabel === null || optionDescription === null) return null
    if (option.value === control.value) hasCurrent = true
    options.push({
      value: option.value,
      ...(optionLabel !== undefined ? { label: optionLabel } : {}),
      ...(optionDescription !== undefined ? { description: optionDescription } : {}),
    })
  }
  if (!hasCurrent) return null

  return {
    capability: 'thinking-control',
    value: control.value,
    options,
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}
