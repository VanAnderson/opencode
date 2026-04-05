import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Message, Part, PendingMessage, Session } from "@opencode-ai/sdk/v2/client"

let createSyncForTest!: () => ReturnType<typeof import("./sync").useSync>

let globalSyncMock: any
let sdkMock: any

const directory = "/repo/main"
const sessionID = "ses_1"

const session = (id: string) =>
  ({
    id,
    title: "Queued Session",
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
    agent: "build",
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

function createState() {
  return createStore({
    project: "",
    path: { state: "", config: "", worktree: "", directory, home: "" },
    status: "complete" as const,
    provider_ready: true,
    provider: { all: [], connected: [], default: {} },
    config: {},
    agent: [],
    command: [],
    session: [] as Session[],
    sessionTotal: 0,
    session_status: {} as Record<string, unknown>,
    session_diff: {} as Record<string, unknown>,
    queue: {} as Record<string, PendingMessage[] | undefined>,
    todo: {} as Record<string, unknown>,
    permission: {} as Record<string, unknown>,
    question: {} as Record<string, unknown>,
    mcp_ready: false,
    mcp: {},
    lsp_ready: false,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {} as Record<string, Message[] | undefined>,
    part: {} as Record<string, Part[] | undefined>,
  })
}

beforeAll(async () => {
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: (input: { init: () => unknown }) => {
      createSyncForTest = input.init as typeof createSyncForTest
      return {
        use: () => undefined,
        provider: () => undefined,
      }
    },
  }))

  mock.module("./global-sync", () => ({
    useGlobalSync: () => globalSyncMock,
  }))

  mock.module("./sdk", () => ({
    useSDK: () => sdkMock,
  }))

  await import("./sync.tsx?sync-test")
})

beforeEach(() => {
  const [store, setStore] = createState()

  let getCalls = 0
  let messageCalls = 0
  let queueCalls = 0

  sdkMock = {
    directory,
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          getCalls += 1
          return { data: session(sessionID) }
        },
        messages: async ({ sessionID }: { sessionID: string }) => {
          messageCalls += 1
          const msg = message("msg_1", sessionID)
          return {
            data: [{ info: msg, parts: [part("prt_1", sessionID, msg.id)] }],
            response: { headers: new Headers() },
          }
        },
        queue: async ({ sessionID }: { sessionID: string }) => {
          queueCalls += 1
          return { data: [pending("pnd_1", sessionID)] }
        },
      },
    },
  }

  globalSyncMock = {
    data: {
      project: [],
      session_todo: {},
    },
    todo: {
      set: () => undefined,
    },
    child: (requestedDirectory: string) => {
      expect(requestedDirectory).toBe(directory)
      return [store, setStore] as const
    },
    __calls: {
      get: () => getCalls,
      messages: () => messageCalls,
      queue: () => queueCalls,
    },
  }
})

describe("sync session hydration", () => {
  test("hydrates queue alongside session transcript data", async () => {
    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        Promise.resolve()
          .then(async () => {
            const sync = createSyncForTest()
            await sync.session.sync(sessionID)

            const [store] = globalSyncMock.child(directory)
            expect(store.session.map((item: Session) => item.id)).toEqual([sessionID])
            expect(store.message[sessionID]?.map((item: Message) => item.id)).toEqual(["msg_1"])
            expect(store.part.msg_1?.map((item: Part) => item.id)).toEqual(["prt_1"])
            expect(store.queue[sessionID]?.map((item: PendingMessage) => item.id)).toEqual(["pnd_1"])
            expect(globalSyncMock.__calls.get()).toBe(1)
            expect(globalSyncMock.__calls.messages()).toBe(1)
            expect(globalSyncMock.__calls.queue()).toBe(1)
          })
          .then(resolve, reject)
          .finally(dispose)
      })
    })
  })
})
