import { describe, expect, test } from "bun:test"
import type { Message, Part, PendingMessage, Session, Todo } from "@opencode-ai/sdk/v2"
import { createStore } from "solid-js/store"
import type { Snapshot } from "../../../src/snapshot"
import {
  applyQueueUpdated,
  applySessionHydration,
  type TuiSessionSyncState,
} from "../../../src/cli/cmd/tui/context/sync-state"

const session = (id: string) =>
  ({
    id,
    time: {
      created: 1,
      updated: 1,
    },
  }) as Session

const message = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt-5" },
  }) as Message

const part = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) as Part

const pending = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    position: 0,
    mode: "queue",
    status: "queued",
    payload: {
      kind: "prompt",
      parts: [{ type: "text", text: id }],
    },
    time: { created: 1, updated: 1 },
  }) as PendingMessage

const todo = (id: string) =>
  ({
    id,
    content: id,
    status: "pending",
    priority: "medium",
  }) as Todo

const diff = (file: string) =>
  ({
    file,
    before: "old",
    after: "new",
    additions: 1,
    deletions: 0,
    status: "modified",
  }) as Snapshot.FileDiff

const baseState = (input: Partial<TuiSessionSyncState> = {}) =>
  ({
    session: [],
    session_diff: {},
    queue: {},
    todo: {},
    message: {},
    part: {},
    ...input,
  }) as TuiSessionSyncState

describe("tui sync state", () => {
  test("replaces queue state from queue events", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        queue: { [sessionID]: [pending("pnd_1", sessionID)] },
      }),
    )

    applyQueueUpdated({
      setStore,
      sessionID,
      pending: [pending("pnd_2", sessionID), pending("pnd_3", sessionID)],
    })

    expect(store.queue[sessionID]?.map((item) => item.id)).toEqual(["pnd_2", "pnd_3"])
  })

  test("hydrates queue alongside session transcript data", () => {
    const sessionID = "ses_1"
    const info = session(sessionID)
    const msg = message("msg_1", sessionID)
    const [store, setStore] = createStore(baseState())

    applySessionHydration({
      setStore,
      sessionID,
      session: info,
      messages: [{ info: msg, parts: [part("prt_1", sessionID, msg.id)] }],
      todo: [todo("todo_1")],
      diff: [diff("src/index.ts")],
      queue: [pending("pnd_1", sessionID)],
    })

    expect(store.session.map((item) => item.id)).toEqual([sessionID])
    expect(store.message[sessionID]?.map((item) => item.id)).toEqual([msg.id])
    expect(store.part[msg.id]?.map((item) => item.id)).toEqual(["prt_1"])
    expect(store.todo[sessionID]?.map((item) => item.content)).toEqual(["todo_1"])
    expect(store.session_diff[sessionID]?.map((item) => item.file)).toEqual(["src/index.ts"])
    expect(store.queue[sessionID]?.map((item) => item.id)).toEqual(["pnd_1"])
  })
})
