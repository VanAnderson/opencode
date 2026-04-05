import { test, expect, type Page } from "../fixtures"
import { assistantText, waitSessionIdle, withSession } from "../actions"
import { promptSelector } from "../selectors"

test.describe.configure({ timeout: 120_000 })

function clean(value: string | null) {
  return (value ?? "").replace(/\u200B/g, "").trim()
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function submitPrompt(page: Page, text: string, action?: "queue" | "steer") {
  const prompt = page.locator(promptSelector).first()
  await expect(prompt).toBeVisible()
  await prompt.click()
  await page.keyboard.type(text)
  await expect.poll(async () => clean(await prompt.textContent())).toBe(text)

  if (!action) {
    await page.keyboard.press("Enter")
    return
  }

  await page.locator(`[data-action="prompt-submit-${action}"]`).click()
}

async function queueIDs(
  project: {
    sdk: {
      session: {
        queue: (input: { sessionID: string }) => Promise<{ data?: Array<{ id: string }> }>
      }
    }
  },
  sessionID: string,
) {
  return project.sdk.session.queue({ sessionID }).then((result) => (result.data ?? []).map((item) => item.id))
}

test("queue button enqueues a busy follow-up and dispatches it after idle", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue busy ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const firstToken = `QUEUE_FIRST_${Date.now()}`
    const secondToken = `QUEUE_SECOND_${Date.now()}`
    const gate = deferred()

    await llm.hold(firstToken, gate.promise)
    await llm.text(secondToken)

    await submitPrompt(page, "Start a long-running reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "Queued follow-up after the active run", "queue")

    const dock = page.locator('[data-component="session-followup-dock"]').first()
    await expect(dock).toBeVisible()
    await expect(dock).toContainText("Queued follow-up after the active run")

    await expect
      .poll(
        () =>
          project.sdk.session
            .queue({ sessionID: session.id })
            .then((result) => (result.data ?? []).map((item) => item.status)),
        { timeout: 15_000 },
      )
      .toContain("queued")

    gate.resolve()

    await waitSessionIdle(project.sdk, session.id, 90_000)
    await expect.poll(() => assistantText(project.sdk, session.id), { timeout: 90_000 }).toContain(secondToken)
    await expect(dock).toHaveCount(0)
  })
})

test("steer button interrupts active work and submits a steer follow-up", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e steer busy ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const steerToken = `STEER_${Date.now()}`

    await llm.hang()

    await submitPrompt(page, "Start a hanging reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await llm.text(steerToken)
    await submitPrompt(page, "Interrupt with a steer follow-up", "steer")

    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    await waitSessionIdle(project.sdk, session.id, 90_000)
    await expect.poll(() => assistantText(project.sdk, session.id), { timeout: 90_000 }).toContain(steerToken)
  })
})

test("delete removes a queued follow-up from the dock and backend queue", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue delete ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const gate = deferred()
    await llm.hold(`DELETE_${Date.now()}`, gate.promise)

    await submitPrompt(page, "Start a long-running reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "Queued follow-up to delete", "queue")

    const dock = page.locator('[data-component="session-followup-dock"]').first()
    await expect(dock).toContainText("Queued follow-up to delete")
    await expect.poll(() => queueIDs(project, session.id), { timeout: 15_000 }).toHaveLength(1)

    await dock.getByRole("button", { name: "Delete" }).click()

    await expect.poll(() => queueIDs(project, session.id), { timeout: 15_000 }).toHaveLength(0)
    await expect(dock).toHaveCount(0)

    gate.resolve()
    await waitSessionIdle(project.sdk, session.id, 90_000)
  })
})

test("move up reorders queued follow-ups in the backend queue", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue reorder ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const gate = deferred()
    await llm.hold(`REORDER_${Date.now()}`, gate.promise)

    await submitPrompt(page, "Start a long-running reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "Queued follow-up A", "queue")
    await submitPrompt(page, "Queued follow-up B", "queue")

    await expect.poll(() => queueIDs(project, session.id), { timeout: 15_000 }).toHaveLength(2)

    const before = await queueIDs(project, session.id)
    const dock = page.locator('[data-component="session-followup-dock"]').first()
    const moveUpButtons = dock.locator('button[aria-label="Move up"]')
    await moveUpButtons.nth(1).click()

    await expect.poll(() => queueIDs(project, session.id), { timeout: 15_000 }).toEqual([before[1], before[0]])

    gate.resolve()
    await waitSessionIdle(project.sdk, session.id, 90_000)
  })
})

test("steer leaves older queued items blocked with an explicit resume affordance", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue blocked ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const steerToken = `BLOCKED_STEER_${Date.now()}`

    await llm.hang()

    await submitPrompt(page, "Start a hanging reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "Queued follow-up that should be blocked", "queue")
    await expect.poll(() => queueIDs(project, session.id), { timeout: 15_000 }).toHaveLength(1)

    await llm.text(steerToken)
    await submitPrompt(page, "Interrupt with a steer follow-up", "steer")

    await waitSessionIdle(project.sdk, session.id, 90_000)
    await expect.poll(() => assistantText(project.sdk, session.id), { timeout: 90_000 }).toContain(steerToken)
    await expect
      .poll(
        () =>
          project.sdk.session
            .queue({ sessionID: session.id })
            .then((result) => (result.data ?? []).map((item) => item.status)),
        { timeout: 15_000 },
      )
      .toEqual(["blocked_after_interrupt"])

    const dock = page.locator('[data-component="session-followup-dock"]').first()
    await expect(dock).toContainText("Queued follow-up that should be blocked")
    await expect(dock).toContainText("blocked after interrupt")
    await expect(dock.getByRole("button", { name: "Resume" })).toBeVisible()
  })
})
