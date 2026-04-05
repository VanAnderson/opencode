export const INTERRUPT_CONFIRMATION_COUNT = 2

export function nextInterruptState(current: number) {
  const next = current + 1
  if (next >= INTERRUPT_CONFIRMATION_COUNT) {
    return {
      count: 0,
      shouldAbort: true,
    }
  }

  return {
    count: next,
    shouldAbort: false,
  }
}
