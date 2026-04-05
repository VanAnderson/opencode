import { test, expect, type Page } from "../fixtures"
import { assistantText, waitSessionIdle, withSession } from "../actions"
import { promptSelector } from "../selectors"
import { modKey } from "../utils"

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

async function replacePrompt(page: Page, text: string) {
  const prompt = page.locator(promptSelector).first()
  await expect(prompt).toBeVisible()
  await prompt.click()
  await page.keyboard.press(`${modKey}+A`)
  await page.keyboard.press("Backspace")
  await page.keyboard.type(text)
  await expect.poll(async () => clean(await prompt.textContent())).toBe(text)
}

async function queueItems(project: { sdk: { session: { queue: (input: { sessionID: string }) => Promise<{ data?: any[] }> } } }, sessionID: string) {
  return (await project.sdk.session.queue({ sessionID })).data ?? []
}

function queuedPromptText(item: any) {
  if (item?.payload?.kind === "command") {
    return [item.payload.command, item.payload.arguments].filter(Boolean).join(" ")
  }
  return (item?.payload?.parts ?? [])
    .map((part: any) => (part?.type === "text" ? part.text : ""))
    .join("")
    .trim()
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

test("editing a queued follow-up updates the same pending item", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue edit ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const gate = deferred()
    const editedToken = `QUEUE_EDIT_${Date.now()}`

    await llm.hold(`QUEUE_EDIT_ACTIVE_${Date.now()}`, gate.promise)
    await llm.text(editedToken)

    await submitPrompt(page, "Start a long-running reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "Original queued follow-up", "queue")
    const pendingBefore = await expect
      .poll(() => queueItems(project, session.id), { timeout: 15_000 })
      .then((items) => items)

    expect(pendingBefore).toHaveLength(1)
    const pendingID = pendingBefore[0]?.id

    const dock = page.locator('[data-component="session-followup-dock"]').first()
    await dock.getByRole("button", { name: "Edit" }).click()
    await expect.poll(async () => clean(await page.locator(promptSelector).first().textContent())).toBe(
      "Original queued follow-up",
    )

    await replacePrompt(page, "Edited queued follow-up")
    await page.locator('[data-action="prompt-submit-queue"]').click()

    await expect
      .poll(() => queueItems(project, session.id), { timeout: 15_000 })
      .toMatchObject([{ id: pendingID }])
    await expect.poll(() => queueItems(project, session.id), { timeout: 15_000 }).toSatisfy((items) => {
      return items.length === 1 && items[0]?.id === pendingID && queuedPromptText(items[0]) === "Edited queued follow-up"
    })

    gate.resolve()
    await waitSessionIdle(project.sdk, session.id, 90_000)
    await expect.poll(() => assistantText(project.sdk, session.id), { timeout: 90_000 }).toContain(editedToken)
    await expect(dock).toHaveCount(0)
  })
})

test("deleting a queued follow-up removes it without affecting the active run", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue delete ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const gate = deferred()
    const activeToken = `QUEUE_DELETE_ACTIVE_${Date.now()}`

    await llm.hold(activeToken, gate.promise)

    await submitPrompt(page, "Start a long-running reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "Delete this queued follow-up", "queue")

    const dock = page.locator('[data-component="session-followup-dock"]').first()
    await expect(dock).toContainText("Delete this queued follow-up")

    await dock.getByRole("button", { name: "Delete" }).click()

    await expect.poll(() => queueItems(project, session.id), { timeout: 15_000 }).toHaveLength(0)
    await expect(dock).toHaveCount(0)

    gate.resolve()
    await waitSessionIdle(project.sdk, session.id, 90_000)
    await expect.poll(() => assistantText(project.sdk, session.id), { timeout: 90_000 }).toContain(activeToken)
  })
})

test("queued follow-ups can be reordered from the dock", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue reorder ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const gate = deferred()
    await llm.hold(`QUEUE_REORDER_ACTIVE_${Date.now()}`, gate.promise)

    await submitPrompt(page, "Start a long-running reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "First queued follow-up", "queue")
    await submitPrompt(page, "Second queued follow-up", "queue")

    await expect.poll(() => queueItems(project, session.id), { timeout: 15_000 }).toSatisfy((items) => {
      return items.map(queuedPromptText).join("|") === "First queued follow-up|Second queued follow-up"
    })

    const dock = page.locator('[data-component="session-followup-dock"]').first()
    await dock.getByRole("button", { name: "Move down" }).nth(0).click()

    await expect.poll(() => queueItems(project, session.id), { timeout: 15_000 }).toSatisfy((items) => {
      return items.map(queuedPromptText).join("|") === "Second queued follow-up|First queued follow-up"
    })

    await dock.getByRole("button", { name: "Clear all" }).click()
    await expect.poll(() => queueItems(project, session.id), { timeout: 15_000 }).toHaveLength(0)

    gate.resolve()
    await waitSessionIdle(project.sdk, session.id, 90_000)
  })
})

test("steering blocks stale queued items until they are reconfirmed", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue blocked ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const steerToken = `QUEUE_BLOCK_STEER_${Date.now()}`
    const resumeToken = `QUEUE_BLOCK_RESUME_${Date.now()}`

    await llm.hang()

    await submitPrompt(page, "Start a hanging reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "Stale queued follow-up", "queue")
    await expect.poll(() => queueItems(project, session.id), { timeout: 15_000 }).toHaveLength(1)

    await llm.text(steerToken)
    await submitPrompt(page, "Interrupt with a steer follow-up", "steer")

    await waitSessionIdle(project.sdk, session.id, 90_000)
    await expect.poll(() => assistantText(project.sdk, session.id), { timeout: 90_000 }).toContain(steerToken)

    const dock = page.locator('[data-component="session-followup-dock"]').first()
    await expect(dock).toContainText("Stale queued follow-up")
    await expect(dock).toContainText("blocked after interrupt")
    await expect.poll(() => queueItems(project, session.id), { timeout: 15_000 }).toSatisfy((items) => {
      return items.length === 1 && items[0]?.status === "blocked_after_interrupt"
    })

    await llm.text(resumeToken)
    await dock.getByRole("button", { name: "Resume" }).click()

    await waitSessionIdle(project.sdk, session.id, 90_000)
    await expect.poll(() => assistantText(project.sdk, session.id), { timeout: 90_000 }).toContain(resumeToken)
    await expect(dock).toHaveCount(0)
  })
})

test("queued follow-ups survive a browser refresh while the session is busy", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue refresh ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const gate = deferred()
    const queuedToken = `QUEUE_REFRESH_${Date.now()}`

    await llm.hold(`QUEUE_REFRESH_ACTIVE_${Date.now()}`, gate.promise)
    await llm.text(queuedToken)

    await submitPrompt(page, "Start a long-running reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "Queued follow-up before refresh", "queue")
    const dock = page.locator('[data-component="session-followup-dock"]').first()
    await expect(dock).toContainText("Queued follow-up before refresh")

    await page.reload()

    await expect(page.locator(promptSelector).first()).toBeVisible()
    await expect.poll(() => queueItems(project, session.id), { timeout: 15_000 }).toHaveLength(1)
    await expect(dock).toContainText("Queued follow-up before refresh")

    gate.resolve()
    await waitSessionIdle(project.sdk, session.id, 90_000)
    await expect.poll(() => assistantText(project.sdk, session.id), { timeout: 90_000 }).toContain(queuedToken)
    await expect(dock).toHaveCount(0)
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

test("queued follow-ups persist across page reload and reconnect", async ({ page, llm, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e queue reload ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const firstToken = `RELOAD_FIRST_${Date.now()}`
    const secondToken = `RELOAD_SECOND_${Date.now()}`
    const gate = deferred()

    await llm.hold(firstToken, gate.promise)
    await llm.text(secondToken)

    await submitPrompt(page, "Start a long-running reply")
    await expect.poll(() => llm.calls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await submitPrompt(page, "Queued follow-up that should survive reload", "queue")
    await expect.poll(() => queueIDs(project, session.id), { timeout: 15_000 }).toHaveLength(1)

    await page.reload()

    const dock = page.locator('[data-component="session-followup-dock"]').first()
    await expect(dock).toContainText("Queued follow-up that should survive reload")
    await expect.poll(() => queueIDs(project, session.id), { timeout: 15_000 }).toHaveLength(1)

    gate.resolve()

    await waitSessionIdle(project.sdk, session.id, 90_000)
    await expect.poll(() => assistantText(project.sdk, session.id), { timeout: 90_000 }).toContain(secondToken)
    await expect(dock).toHaveCount(0)
  })
})
