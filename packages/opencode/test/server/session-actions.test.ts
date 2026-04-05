import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionQueue } from "../../src/session/queue"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

async function user(sessionID: SessionID, text: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: msg.id,
    type: "text",
    text,
  })
  return msg
}

async function activeAssistant(sessionID: SessionID, parentID: MessageID) {
  return Session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID,
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    time: { created: Date.now() },
  })
}

function promptPayload(text: string) {
  return {
    kind: "prompt" as const,
    agent: "default",
    model: {
      providerID: ProviderID.make("openai"),
      modelID: ModelID.make("gpt-4.1"),
    },
    variant: "default",
    parts: [
      {
        type: "text" as const,
        text,
      },
    ],
  }
}

function assistantResult(sessionID: SessionID) {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
    },
    parts: [],
  } as unknown as MessageV2.WithParts
}

function pendingText(item: SessionQueue.PendingMessage) {
  if (item.payload.kind === "command") return item.payload.arguments
  const first = item.payload.parts[0]
  return first?.type === "text" ? first.text : ""
}

describe("session action routes", () => {
  test("abort route interrupts without redispatching queued work", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const interrupt = spyOn(SessionPrompt, "interrupt").mockResolvedValue()
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/abort`, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)
        expect(interrupt).toHaveBeenCalledWith({ sessionID: session.id, holdQueuedDispatch: true })

        await Session.remove(session.id)
      },
    })
  })

  test("delete message route returns 400 when session is busy", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const busy = spyOn(SessionPrompt, "assertNotBusy").mockRejectedValue(new Session.BusyError(session.id))
        const remove = spyOn(Session, "removeMessage").mockResolvedValue(msg.id)
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/message/${msg.id}`, {
          method: "DELETE",
        })

        expect(res.status).toBe(400)
        expect(busy).toHaveBeenCalledWith(session.id)
        expect(remove).not.toHaveBeenCalled()

        await Session.remove(session.id)
      },
    })
  })

  test("queue CRUD routes manage pending messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        const created = await app.request(`/session/${session.id}/queue`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "queue",
            payload: promptPayload("first"),
            source: "app",
          }),
        })

        expect(created.status).toBe(200)
        const pending = (await created.json()) as SessionQueue.PendingMessage
        expect(pending.mode).toBe("queue")
        expect(pending.payload.kind).toBe("prompt")

        const listed = await app.request(`/session/${session.id}/queue`)
        expect(listed.status).toBe(200)
        expect(((await listed.json()) as SessionQueue.PendingMessage[]).map((item) => item.id)).toEqual([pending.id])

        const updated = await app.request(`/session/${session.id}/queue/${pending.id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            status: "failed",
            error: { message: "boom" },
          }),
        })
        expect(updated.status).toBe(200)
        expect(((await updated.json()) as SessionQueue.PendingMessage).status).toBe("failed")

        const removed = await app.request(`/session/${session.id}/queue/${pending.id}`, {
          method: "DELETE",
        })
        expect(removed.status).toBe(200)
        expect(await removed.json()).toBe(true)
        expect(await SessionQueue.list(session.id)).toEqual([])

        await Session.remove(session.id)
      },
    })
  })

  test("queue update route resumes queued dispatch when a failed item is requeued", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const runQueuedIfIdle = spyOn(SessionPrompt, "runQueuedIfIdle").mockResolvedValue()

        const pending = await SessionQueue.enqueue({
          sessionID: session.id,
          mode: "queue",
          payload: promptPayload("retry me"),
        })

        await SessionQueue.update({
          sessionID: session.id,
          pendingMessageID: pending.id,
          status: "failed",
          error: { message: "boom", code: "APIError" },
        })

        const resumed = await app.request(`/session/${session.id}/queue/${pending.id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            status: "queued",
          }),
        })

        expect(resumed.status).toBe(200)
        expect((await resumed.json()) as SessionQueue.PendingMessage).toMatchObject({
          id: pending.id,
          status: "queued",
        })
        expect(runQueuedIfIdle).toHaveBeenCalledWith(session.id)

        await Session.remove(session.id)
      },
    })
  })

  test("queue update route reconfirms blocked items and resumes queued dispatch", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const runQueuedIfIdle = spyOn(SessionPrompt, "runQueuedIfIdle").mockResolvedValue()

        const pending = await SessionQueue.enqueue({
          sessionID: session.id,
          mode: "queue",
          payload: promptPayload("resume me"),
        })

        await SessionQueue.update({
          sessionID: session.id,
          pendingMessageID: pending.id,
          status: "blocked_after_interrupt",
        })

        const resumed = await app.request(`/session/${session.id}/queue/${pending.id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            status: "queued",
          }),
        })

        expect(resumed.status).toBe(200)
        const body = (await resumed.json()) as SessionQueue.PendingMessage
        expect(body).toMatchObject({
          id: pending.id,
          status: "queued",
        })
        expect(body.error).toBeUndefined()
        expect(runQueuedIfIdle).toHaveBeenCalledWith(session.id)

        await Session.remove(session.id)
      },
    })
  })

  test("submit route executes immediately when the session is idle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(assistantResult(session.id))

        const res = await app.request(`/session/${session.id}/submit`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "queue",
            payload: promptPayload("ship it"),
            source: "app",
          }),
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
          kind: "immediate",
          message: {
            info: {
              role: "assistant",
              sessionID: session.id,
            },
          },
        })
        expect(prompt).toHaveBeenCalledWith({
          ...promptPayload("ship it"),
          sessionID: session.id,
          submission: {
            mode: "immediate",
            source: "app",
          },
        })
        expect(await SessionQueue.list(session.id)).toEqual([])

        await Session.remove(session.id)
      },
    })
  })

  test("submit route queues follow-ups while the session is busy", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const status = spyOn(SessionStatus, "get").mockResolvedValue({ type: "busy" })
        const prompt = spyOn(SessionPrompt, "prompt")

        const res = await app.request(`/session/${session.id}/submit`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "queue",
            payload: promptPayload("next"),
            source: "app",
          }),
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
          kind: "queued",
          pending: {
            sessionID: session.id,
            mode: "queue",
            position: 0,
          },
          queue: [{ sessionID: session.id, mode: "queue", position: 0 }],
          status: { type: "busy" },
        })
        expect(status).toHaveBeenCalledWith(session.id)
        expect(prompt).not.toHaveBeenCalled()

        await Session.remove(session.id)
      },
    })
  })

  test("submit route promotes steer submissions to the front while busy", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        spyOn(SessionStatus, "get").mockResolvedValue({ type: "busy" })

        const existing = await SessionQueue.enqueue({
          sessionID: session.id,
          mode: "queue",
          payload: promptPayload("existing"),
        })

        const res = await app.request(`/session/${session.id}/submit`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            payload: promptPayload("urgent"),
            source: "app",
          }),
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
          kind: "queued",
          pending: {
            sessionID: session.id,
            mode: "steer",
            position: 0,
          },
          queue: [
            { sessionID: session.id, mode: "steer", position: 0 },
            { id: existing.id, sessionID: session.id, mode: "queue", position: 1 },
          ],
          status: { type: "busy" },
        })

        await Session.remove(session.id)
      },
    })
  })

  test("submit route interrupts active work and blocks stale queued items for steer", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const active = await user(session.id, "active work")
        const app = Server.Default()
        spyOn(SessionStatus, "get").mockResolvedValue({ type: "busy" })
        const interrupt = spyOn(SessionPrompt, "interrupt").mockResolvedValue()
        const block = spyOn(SessionQueue, "markBlockedAfterInterrupt").mockResolvedValue([])
        const runQueuedIfIdle = spyOn(SessionPrompt, "runQueuedIfIdle").mockResolvedValue()

        const existing = await SessionQueue.enqueue({
          sessionID: session.id,
          mode: "queue",
          payload: promptPayload("stale"),
          createdAgainstExecutionID: active.id,
        })

        const res = await app.request(`/session/${session.id}/submit`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            payload: promptPayload("urgent"),
            source: "app",
          }),
        })

        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          kind: "queued"
          pending: SessionQueue.PendingMessage
          queue: SessionQueue.PendingMessage[]
          status: { type: "busy" }
        }
        expect(body).toMatchObject({
          kind: "queued",
          pending: {
            sessionID: session.id,
            mode: "steer",
            position: 0,
            createdAgainstExecutionID: active.id,
            supersedesExecutionID: active.id,
          },
          queue: [
            {
              sessionID: session.id,
              mode: "steer",
              position: 0,
              createdAgainstExecutionID: active.id,
              supersedesExecutionID: active.id,
            },
            {
              id: existing.id,
              sessionID: session.id,
              mode: "queue",
              position: 1,
              createdAgainstExecutionID: active.id,
            },
          ],
          status: { type: "busy" },
        })

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(interrupt).toHaveBeenCalledWith({ sessionID: session.id, holdQueuedDispatch: true })
        expect(block).toHaveBeenCalledWith({
          sessionID: session.id,
          createdAgainstExecutionID: active.id,
          preserveLatestSteer: true,
          excludePendingMessageIDs: [],
        })
        expect(runQueuedIfIdle).toHaveBeenCalledWith(session.id)

        await Session.remove(session.id)
      },
    })
  })

  test("submit route preserves only the newest steer when repeated interrupts settle", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const current = await user(session.id, "active")
        await activeAssistant(session.id, current.id)

        const cancelDeferred = Promise.withResolvers<void>()
        spyOn(SessionStatus, "get").mockResolvedValue({ type: "busy" })
        const interrupt = spyOn(SessionPrompt, "interrupt").mockImplementation(() => cancelDeferred.promise)
        const runQueuedIfIdle = spyOn(SessionPrompt, "runQueuedIfIdle").mockResolvedValue()

        const existing = await SessionQueue.enqueue({
          sessionID: session.id,
          mode: "queue",
          payload: promptPayload("existing"),
          createdAgainstExecutionID: current.id,
        })

        const first = await app.request(`/session/${session.id}/submit`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            payload: promptPayload("urgent one"),
            source: "app",
          }),
        })

        const second = await app.request(`/session/${session.id}/submit`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            payload: promptPayload("urgent two"),
            source: "app",
          }),
        })

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)

        cancelDeferred.resolve()
        await new Promise((resolve) => setTimeout(resolve, 25))

        const queue = await SessionQueue.list(session.id)
        expect(queue.map((item) => ({
          id: item.id,
          mode: item.mode,
          status: item.status,
          text: pendingText(item),
        }))).toEqual([
          {
            id: expect.any(String),
            mode: "steer",
            status: "queued",
            text: "urgent two",
          },
          {
            id: expect.any(String),
            mode: "steer",
            status: "blocked_after_interrupt",
            text: "urgent one",
          },
          {
            id: existing.id,
            mode: "queue",
            status: "blocked_after_interrupt",
            text: "existing",
          },
        ])
        expect(interrupt).toHaveBeenCalledTimes(2)
        expect(runQueuedIfIdle).toHaveBeenCalledTimes(2)

        await Session.remove(session.id)
      },
    })
  })

  test("submit route attaches follow-up queue items to the queued steer context", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()
        const current = await user(session.id, "active")
        await activeAssistant(session.id, current.id)

        const interruptDeferred = Promise.withResolvers<void>()
        spyOn(SessionStatus, "get").mockResolvedValue({ type: "busy" })
        spyOn(SessionPrompt, "interrupt").mockImplementation(() => interruptDeferred.promise)
        spyOn(SessionPrompt, "runQueuedIfIdle").mockResolvedValue()

        const steer = await app.request(`/session/${session.id}/submit`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            payload: promptPayload("urgent"),
            source: "app",
          }),
        })
        expect(steer.status).toBe(200)
        const steerBody = (await steer.json()) as {
          kind: "queued"
          pending: SessionQueue.PendingMessage
        }

        const followup = await app.request(`/session/${session.id}/submit`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "queue",
            payload: promptPayload("after steer"),
            source: "app",
          }),
        })
        expect(followup.status).toBe(200)
        const followupBody = (await followup.json()) as {
          kind: "queued"
          pending: SessionQueue.PendingMessage
        }
        expect(followupBody.pending.createdAgainstExecutionID).toBe(steerBody.pending.id)

        interruptDeferred.resolve()
        await new Promise((resolve) => setTimeout(resolve, 25))

        const queue = await SessionQueue.list(session.id)
        expect(queue.map((item) => ({
          text: pendingText(item),
          status: item.status,
          createdAgainstExecutionID: item.createdAgainstExecutionID,
        }))).toEqual([
          {
            text: "urgent",
            status: "queued",
            createdAgainstExecutionID: current.id,
          },
          {
            text: "after steer",
            status: "queued",
            createdAgainstExecutionID: steerBody.pending.id,
          },
        ])

        await Session.remove(session.id)
      },
    })
  })

  test("queue reorder, promote, and clear routes return updated queue state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        const first = await SessionQueue.enqueue({
          sessionID: session.id,
          mode: "queue",
          payload: promptPayload("first"),
        })
        const second = await SessionQueue.enqueue({
          sessionID: session.id,
          mode: "queue",
          payload: promptPayload("second"),
        })
        const third = await SessionQueue.enqueue({
          sessionID: session.id,
          mode: "queue",
          payload: promptPayload("third"),
        })

        const reordered = await app.request(`/session/${session.id}/queue/reorder`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            pendingMessageIDs: [third.id, first.id, second.id],
          }),
        })
        expect(reordered.status).toBe(200)
        expect(((await reordered.json()) as SessionQueue.PendingMessage[]).map((item) => item.id)).toEqual([
          third.id,
          first.id,
          second.id,
        ])

        const promoted = await app.request(`/session/${session.id}/queue/${second.id}/promote`, {
          method: "POST",
        })
        expect(promoted.status).toBe(200)
        expect(((await promoted.json()) as SessionQueue.PendingMessage).id).toBe(second.id)
        expect((await SessionQueue.list(session.id)).map((item) => item.id)).toEqual([second.id, third.id, first.id])

        const cleared = await app.request(`/session/${session.id}/queue/clear`, {
          method: "POST",
        })
        expect(cleared.status).toBe(200)
        expect(await cleared.json()).toBe(true)
        expect(await SessionQueue.list(session.id)).toEqual([])

        await Session.remove(session.id)
      },
    })
  })
})
