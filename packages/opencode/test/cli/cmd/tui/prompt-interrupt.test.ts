import { describe, expect, test } from "bun:test"
import { INTERRUPT_CONFIRMATION_COUNT, nextInterruptState } from "../../../../src/cli/cmd/tui/component/prompt/interrupt"

describe("tui prompt interrupt helper", () => {
  test("requires a confirmation press before aborting", () => {
    expect(INTERRUPT_CONFIRMATION_COUNT).toBe(2)
    expect(nextInterruptState(0)).toEqual({
      count: 1,
      shouldAbort: false,
    })
  })

  test("resets the counter once the abort threshold is reached", () => {
    expect(nextInterruptState(INTERRUPT_CONFIRMATION_COUNT - 1)).toEqual({
      count: 0,
      shouldAbort: true,
    })
  })
})
