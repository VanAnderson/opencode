import { describe, expect, test } from "bun:test"
import path from "path"

import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionQueue } from "../../src/session/queue"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

function promptPayload(text: string) {
  return {
    kind: "prompt" as const,
    agent: "default",
    model: {
      providerID: "openai" as const,
      modelID: "gpt-4.1" as const,
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

function commandPayload(command: string, args: string) {
  return {
    kind: "command" as const,
    command,
    arguments: args,
    agent: "default",
    model: "openai/gpt-4.1",
    variant: "default",
    parts: [],
  }
}

describe("SessionQueue", () => {
  test("enqueue, update, remove, and clear pending messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        try {
          const first = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "queue",
            payload: promptPayload("first"),
            source: "app",
          })
          const second = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "steer",
            payload: commandPayload("init", "--force"),
            source: "tui",
          })

          expect((await SessionQueue.list(session.id)).map((item) => item.id)).toEqual([first.id, second.id])

          const updated = await SessionQueue.update({
            sessionID: session.id,
            pendingMessageID: first.id,
            status: "failed",
            error: { message: "boom" },
            source: "web",
          })

          expect(updated.status).toBe("failed")
          expect(updated.error?.message).toBe("boom")
          expect(updated.source).toBe("web")

          await SessionQueue.remove({
            sessionID: session.id,
            pendingMessageID: first.id,
          })

          const remaining = await SessionQueue.list(session.id)
          expect(remaining).toHaveLength(1)
          expect(remaining[0]?.id).toBe(second.id)
          expect(remaining[0]?.position).toBe(0)

          await SessionQueue.clear(session.id)
          expect(await SessionQueue.list(session.id)).toEqual([])
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("reorders and promotes pending messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        try {
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

          const reordered = await SessionQueue.reorder({
            sessionID: session.id,
            pendingMessageIDs: [third.id, first.id, second.id],
          })

          expect(reordered.map((item) => item.id)).toEqual([third.id, first.id, second.id])
          expect(reordered.map((item) => item.position)).toEqual([0, 1, 2])

          const promoted = await SessionQueue.promote({
            sessionID: session.id,
            pendingMessageID: second.id,
          })

          expect(promoted.id).toBe(second.id)
          expect(promoted.position).toBe(0)
          expect((await SessionQueue.list(session.id)).map((item) => item.id)).toEqual([second.id, third.id, first.id])
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("publishes full queue updates after mutations", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const pendingCounts: number[] = []
        const unsub = Bus.subscribe(SessionQueue.Event.Updated, (event) => {
          if (event.properties.sessionID !== session.id) return
          pendingCounts.push(event.properties.pending.length)
        })

        try {
          const queued = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "queue",
            payload: promptPayload("first"),
          })
          await SessionQueue.remove({
            sessionID: session.id,
            pendingMessageID: queued.id,
          })

          await new Promise((resolve) => setTimeout(resolve, 25))
          expect(pendingCounts).toEqual([1, 0])
        } finally {
          unsub()
          await Session.remove(session.id)
        }
      },
    })
  })
})
