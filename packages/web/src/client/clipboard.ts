export async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
}
