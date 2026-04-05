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

describe("session action routes", () => {
  test("abort route calls SessionPrompt.cancel", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue()
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/abort`, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)
        expect(cancel).toHaveBeenCalledWith(session.id)

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
