import { describe, expect, test } from "bun:test"
import path from "path"

import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
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

  test("marks queued items blocked after interrupt without touching excluded or newer work", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        try {
          const first = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "queue",
            payload: promptPayload("first"),
            createdAgainstExecutionID: "run_1",
          })
          const second = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "steer",
            payload: promptPayload("second"),
            createdAgainstExecutionID: "run_1",
          })
          await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "queue",
            payload: promptPayload("third"),
            createdAgainstExecutionID: "run_2",
          })

          const blocked = await SessionQueue.markBlockedAfterInterrupt({
            sessionID: session.id,
            createdAgainstExecutionID: "run_1",
            preserveLatestSteer: false,
            excludePendingMessageIDs: [second.id],
          })

          expect(blocked.map((item) => item.id)).toEqual([first.id])

          const list = await SessionQueue.list(session.id)
          expect(list.find((item) => item.id === first.id)?.status).toBe("blocked_after_interrupt")
          expect(list.find((item) => item.id === second.id)?.status).toBe("queued")
          expect(list.find((item) => item.payload.kind === "prompt" && item.id !== first.id && item.id !== second.id)?.status).toBe(
            "queued",
          )
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("preserves the latest steer when repeated interruptions target the same execution", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        try {
          const first = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "queue",
            payload: promptPayload("first"),
            createdAgainstExecutionID: "run_1",
          })
          const steerA = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "steer",
            payload: promptPayload("steer-a"),
            createdAgainstExecutionID: "run_1",
            supersedesExecutionID: "run_1",
          })
          const steerB = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "steer",
            payload: promptPayload("steer-b"),
            createdAgainstExecutionID: "run_1",
            supersedesExecutionID: "run_1",
          })
          await SessionQueue.promote({
            sessionID: session.id,
            pendingMessageID: steerB.id,
          })
          await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "queue",
            payload: promptPayload("future"),
            createdAgainstExecutionID: "run_2",
          })

          const blocked = await SessionQueue.markBlockedAfterInterrupt({
            sessionID: session.id,
            createdAgainstExecutionID: "run_1",
            preserveLatestSteer: true,
            excludePendingMessageIDs: [],
          })

          expect(blocked.map((item) => item.id)).toEqual([first.id, steerA.id])

          const list = await SessionQueue.list(session.id)
          expect(list.find((item) => item.id === steerB.id)?.status).toBe("queued")
          expect(list.find((item) => item.id === steerA.id)?.status).toBe("blocked_after_interrupt")
          expect(list.find((item) => item.id === first.id)?.status).toBe("blocked_after_interrupt")
          expect(list.find((item) => item.payload.kind === "prompt" && item.id !== first.id && item.id !== steerA.id && item.id !== steerB.id)?.status).toBe("queued")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("rebases queued items onto the executed steer context", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        try {
          const steer = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "steer",
            payload: promptPayload("steer"),
            createdAgainstExecutionID: "run_1",
            supersedesExecutionID: "run_1",
          })
          const followup = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "queue",
            payload: promptPayload("followup"),
            createdAgainstExecutionID: steer.id,
          })

          const rebased = await SessionQueue.rebaseExecutionContext({
            sessionID: session.id,
            fromExecutionID: steer.id,
            toExecutionID: "msg_2",
          })

          expect(rebased.map((item) => item.id)).toEqual([followup.id])
          expect(rebased[0]?.createdAgainstExecutionID).toBe("msg_2")

          const list = await SessionQueue.list(session.id)
          expect(list.find((item) => item.id === steer.id)?.createdAgainstExecutionID).toBe("run_1")
          expect(list.find((item) => item.id === followup.id)?.createdAgainstExecutionID).toBe("msg_2")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("consumes the queued head and pauses when the head is blocked", async () => {
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

          const consumed = await SessionQueue.consumeHead(session.id)
          expect(consumed?.id).toBe(first.id)
          expect((await SessionQueue.list(session.id)).map((item) => [item.id, item.position])).toEqual([[second.id, 0]])

          await SessionQueue.update({
            sessionID: session.id,
            pendingMessageID: second.id,
            status: "blocked_after_interrupt",
          })

          expect(await SessionQueue.consumeHead(session.id)).toBeUndefined()
          expect((await SessionQueue.list(session.id)).map((item) => item.id)).toEqual([second.id])
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("claims queued work, removes completed items, and pauses on failed heads", async () => {
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

          const claimed = await SessionQueue.claimHead(session.id)
          expect(claimed?.id).toBe(first.id)
          expect(claimed?.status).toBe("running")
          expect((await SessionQueue.list(session.id)).map((item) => [item.id, item.status])).toEqual([
            [first.id, "running"],
            [second.id, "queued"],
          ])

          expect(await SessionQueue.claimHead(session.id)).toBeUndefined()

          const failed = await SessionQueue.fail({
            sessionID: session.id,
            pendingMessageID: first.id,
            error: { message: "boom", code: "Unknown" },
          })
          expect(failed.status).toBe("failed")
          expect((await SessionQueue.list(session.id)).map((item) => [item.id, item.status])).toEqual([
            [first.id, "failed"],
            [second.id, "queued"],
          ])
          expect(await SessionQueue.claimHead(session.id)).toBeUndefined()

          await SessionQueue.remove({
            sessionID: session.id,
            pendingMessageID: first.id,
          })

          const next = await SessionQueue.claimHead(session.id)
          expect(next?.id).toBe(second.id)
          expect(next?.status).toBe("running")

          await SessionQueue.complete({
            sessionID: session.id,
            pendingMessageID: second.id,
          })
          expect(await SessionQueue.list(session.id)).toEqual([])
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("requeue clears stale error details when a failed item is resumed", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        try {
          const item = await SessionQueue.enqueue({
            sessionID: session.id,
            mode: "queue",
            payload: promptPayload("retry me"),
          })

          await SessionQueue.update({
            sessionID: session.id,
            pendingMessageID: item.id,
            status: "failed",
            error: { message: "boom", code: "APIError" },
          })

          const resumed = await SessionQueue.update({
            sessionID: session.id,
            pendingMessageID: item.id,
            status: "queued",
          })

          expect(resumed.status).toBe("queued")
          expect(resumed.error).toBeUndefined()
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })
})
