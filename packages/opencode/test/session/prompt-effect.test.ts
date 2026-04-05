import { NodeFileSystem } from "@effect/platform-node"
import { expect, spyOn } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect"
import path from "path"
import z from "zod"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { FileTime } from "../../src/file/time"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider/provider"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Server } from "../../src/server/server"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "../../src/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionQueue } from "../../src/session/queue"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { TaskTool } from "../../src/tool/task"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Log } from "../../src/util/log"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const filetime = Layer.succeed(
  FileTime.Service,
  FileTime.Service.of({
    read: () => Effect.void,
    get: () => Effect.succeed(undefined),
    assert: () => Effect.void,
    withLock: (_filepath, fn) => Effect.promise(fn),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
function makeHttp(pluginLayer = Plugin.defaultLayer) {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.layer.pipe(Layer.provide(pluginLayer)),
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    pluginLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    filetime,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    SessionQueue.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provideMerge(deps),
    ),
  )
}

const it = testEffect(makeHttp())
type RecordedPluginHook = {
  name: string
  input: unknown
}

let recordedPluginHooks: RecordedPluginHook[] = []

function resetRecordedPluginHooks() {
  recordedPluginHooks = []
}

function recordedHookCount(name: string) {
  return recordedPluginHooks.filter((hook) => hook.name === name).length
}

const recordedPluginLayer = Layer.mock(Plugin.Service)({
  trigger: <Name extends string, Input, Output>(name: Name, input: Input, output: Output) =>
    Effect.sync(() => {
      recordedPluginHooks.push({
        name,
        input,
      })
      if (name === "chat.params" && typeof output === "object" && output !== null) {
        ;(output as { temperature?: number }).temperature = 0.123
      }
      if (name === "chat.headers" && typeof output === "object" && output !== null) {
        ;((output as { headers?: Record<string, string> }).headers ??= {})["x-queue-hook"] = "queued"
      }
      return output
    }),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})

const pluginIt = testEffect(makeHttp(recordedPluginLayer))
const unix = process.platform !== "win32" ? it.live : it.live.skip

// Config that registers a custom "test" provider with a "test-model" model
// so Provider.getModel("test", "test-model") succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, sessions, chat }
})

// Loop semantics

it.live("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop calls LLM and returns assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const parts = result.parts.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop returns assistant text through local provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const session = yield* Effect.promise(() =>
        Session.create({
          title: "Prompt provider",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )

      yield* Effect.promise(() =>
        SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }),
      )

      yield* llm.text("world")

      const result = yield* Effect.promise(() => SessionPrompt.loop({ sessionID: session.id }))
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop consumes queued replies across turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const session = yield* Effect.promise(() =>
        Session.create({
          title: "Prompt provider turns",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )

      yield* Effect.promise(() =>
        SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello one" }],
        }),
      )

      yield* llm.text("world one")

      const first = yield* Effect.promise(() => SessionPrompt.loop({ sessionID: session.id }))
      expect(first.info.role).toBe("assistant")
      expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

      yield* Effect.promise(() =>
        SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello two" }],
        }),
      )

      yield* llm.text("world two")

      const second = yield* Effect.promise(() => SessionPrompt.loop({ sessionID: session.id }))
      expect(second.info.role).toBe("assistant")
      expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

      expect(yield* llm.hits).toHaveLength(2)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is tool-calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is stop but assistant has tool parts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().tool("first", { value: "first" }).stop())
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = errorTool(taskMsg.parts)
      if (!tool) return

      expect(tool.state.error).toContain("Tool execution failed")
      expect(tool.state.metadata).toBeDefined()
      expect(tool.state.metadata?.sessionId).toBeDefined()
      expect(tool.state.metadata?.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      }),
    },
  ),
)

it.live(
  "loop sets status to busy then idle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(chat.id)).type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

// Cancel semantics

it.live(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* seed(chat.id)

        yield* llm.hang

        yield* user(chat.id, "more")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
        }
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.info
          if (info.role === "assistant") {
            expect(info.error?.name).toBe("MessageAbortedError")
          }
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const init = spyOn(TaskTool, "init").mockImplementation(async () => ({
            description: "task",
            parameters: z.object({
              description: z.string(),
              prompt: z.string(),
              subagent_type: z.string(),
              task_id: z.string().optional(),
              command: z.string().optional(),
            }),
            execute: async (_args, ctx) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              await new Promise<void>(() => {})
              return {
                title: "",
                metadata: {
                  sessionId: SessionID.make("task"),
                  model: ref,
                },
                output: "",
              }
            },
          }))
          yield* Effect.addFinalizer(() => Effect.sync(() => init.mockRestore()))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        yield* prompt.cancel(chat.id)
        const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(exitA)).toBe(true)
        expect(Exit.isSuccess(exitB)).toBe(true)
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
          expect(exitA.value.info.id).toBe(exitB.value.info.id)
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Queue semantics

it.live(
  "idle transition dispatches queued prompts without blocking the completed run",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Queued follow-up" })
        const firstGate = defer<void>()
        const secondGate = defer<void>()

        yield* llm.hold("first reply", firstGate.promise)
        yield* llm.hold("second reply", secondGate.promise)
        yield* user(chat.id, "hello first")

        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        yield* queue.enqueue({
          sessionID: chat.id,
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello second" }],
          },
          source: "test",
        })

        firstGate.resolve()
        yield* llm.wait(2)

        const firstExit = yield* Fiber.await(first).pipe(Effect.timeoutOption("1 second"))
        expect(Option.isSome(firstExit)).toBe(true)
        if (Option.isSome(firstExit)) {
          expect(Exit.isSuccess(firstExit.value)).toBe(true)
          if (Exit.isSuccess(firstExit.value)) {
            expect(firstExit.value.value.parts.some((part) => part.type === "text" && part.text === "first reply")).toBe(
              true,
            )
          }
        }

        secondGate.resolve()

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            const pending = await Effect.runPromise(queue.list(chat.id))
            const assistants = msgs.filter((msg) => msg.info.role === "assistant")
            if (
              assistants.length === 2 &&
              assistants.at(-1)?.parts.some((part) => part.type === "text" && part.text === "second reply") &&
              pending.length === 0
            ) {
              return
            }
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for queued follow-up")
        })

        expect(yield* llm.calls).toBe(2)
        expect(yield* queue.list(chat.id)).toEqual([])

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const users = msgs.filter((msg) => msg.info.role === "user")
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(users).toHaveLength(2)
        expect(assistants).toHaveLength(2)
        expect(users.at(-1)?.parts.some((part) => part.type === "text" && part.text === "hello second")).toBe(true)
        expect(assistants.at(-1)?.parts.some((part) => part.type === "text" && part.text === "second reply")).toBe(
          true,
        )
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live(
  "queued prompts do not dispatch while the session is still busy",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Queued while busy" })
        const firstGate = defer<void>()

        yield* llm.hold("first reply", firstGate.promise)
        yield* llm.text("second reply")
        yield* user(chat.id, "hello first")

        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const queued = yield* queue.enqueue({
          sessionID: chat.id,
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello second" }],
          },
          source: "test",
        })

        yield* Effect.sleep("150 millis")

        expect(yield* llm.calls).toBe(1)
        expect((yield* queue.list(chat.id)).map((item) => [item.id, item.status])).toEqual([[queued.id, "queued"]])

        const before = yield* sessions.messages({ sessionID: chat.id })
        const beforeUserTexts = before
          .filter((msg) => msg.info.role === "user")
          .map((msg) => msg.parts.find((part) => part.type === "text"))
          .map((part) => (part?.type === "text" ? part.text : undefined))
        expect(beforeUserTexts).toEqual(["hello first"])

        firstGate.resolve()

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const pending = await Effect.runPromise(queue.list(chat.id))
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            const assistants = msgs.filter((msg) => msg.info.role === "assistant")
            if (
              pending.length === 0 &&
              assistants.length === 2 &&
              assistants.at(-1)?.parts.some((part) => part.type === "text" && part.text === "second reply")
            ) {
              return
            }
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for queued dispatch after busy run")
        })

        const exit = yield* Fiber.await(first)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live(
  "idle redispatch drains multiple queued prompts in FIFO order",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Queued FIFO follow-ups" })
        const firstGate = defer<void>()

        yield* llm.hold("first reply", firstGate.promise)
        yield* llm.text("second reply")
        yield* llm.text("third reply")
        yield* user(chat.id, "hello first")

        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        yield* queue.enqueue({
          sessionID: chat.id,
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello second" }],
          },
          source: "test",
        })
        yield* queue.enqueue({
          sessionID: chat.id,
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello third" }],
          },
          source: "test",
        })

        firstGate.resolve()
        yield* Fiber.await(first)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            const pending = await Effect.runPromise(queue.list(chat.id))
            const assistantTexts = msgs
              .filter((msg) => msg.info.role === "assistant")
              .map((msg) => msg.parts.find((part) => part.type === "text"))
              .map((part) => (part?.type === "text" ? part.text : undefined))
            if (assistantTexts.at(-1) === "third reply" && pending.length === 0) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for FIFO queued follow-ups")
        })

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const userTexts = msgs
          .filter((msg) => msg.info.role === "user")
          .map((msg) => msg.parts.find((part) => part.type === "text"))
          .map((part) => (part?.type === "text" ? part.text : undefined))
        const assistantTexts = msgs
          .filter((msg) => msg.info.role === "assistant")
          .map((msg) => msg.parts.find((part) => part.type === "text"))
          .map((part) => (part?.type === "text" ? part.text : undefined))

        expect(yield* llm.calls).toBe(3)
        expect(yield* queue.list(chat.id)).toEqual([])
        expect(userTexts).toEqual(["hello first", "hello second", "hello third"])
        expect(assistantTexts).toEqual(["first reply", "second reply", "third reply"])

        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs[1]?.messages)).toContain("hello second")
        expect(JSON.stringify(inputs[1]?.messages)).not.toContain("hello third")
        expect(JSON.stringify(inputs[2]?.messages)).toContain("hello third")
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live(
  "queued dispatch pauses on failure and leaves later items pending",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Queued failure pause" })
        const firstGate = defer<void>()

        yield* llm.hold("first reply", firstGate.promise)
        yield* llm.error(400, { error: { message: "no_kv_space" } })
        yield* llm.text("third reply")
        yield* user(chat.id, "hello first")

        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const second = yield* queue.enqueue({
          sessionID: chat.id,
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello second" }],
          },
          source: "test",
        })
        const third = yield* queue.enqueue({
          sessionID: chat.id,
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello third" }],
          },
          source: "test",
        })

        firstGate.resolve()
        yield* Fiber.await(first)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const pending = await Effect.runPromise(queue.list(chat.id))
            if (
              pending.length === 2 &&
              pending[0]?.id === second.id &&
              pending[0]?.status === "failed" &&
              pending[1]?.id === third.id &&
              pending[1]?.status === "queued"
            ) {
              return
            }
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for failed queued state")
        })

        expect(yield* llm.calls).toBe(2)

        const pending = yield* queue.list(chat.id)
        expect(pending.map((item) => [item.id, item.status])).toEqual([
          [second.id, "failed"],
          [third.id, "queued"],
        ])
        expect(pending[0]?.error).toEqual({
          message: "no_kv_space",
          code: "APIError",
        })

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const userTexts = msgs
          .filter((msg) => msg.info.role === "user")
          .map((msg) => msg.parts.find((part) => part.type === "text"))
          .map((part) => (part?.type === "text" ? part.text : undefined))
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        const lastAssistant = assistants.at(-1)

        expect(userTexts).toEqual(["hello first", "hello second"])
        expect(assistants).toHaveLength(2)
        expect(lastAssistant?.info.role).toBe("assistant")
        if (lastAssistant?.info.role === "assistant") {
          expect(lastAssistant.info.error?.name).toBe("APIError")
        }
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

pluginIt.live(
  "queued prompts stay dormant while busy and fire plugin hooks exactly once when consumed",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        resetRecordedPluginHooks()

        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Queued plugin hooks" })
        const firstGate = defer<void>()
        const secondGate = defer<void>()

        yield* llm.hold("first reply", firstGate.promise)
        yield* llm.hold("second reply", secondGate.promise)
        yield* user(chat.id, "hello first")

        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        expect(recordedHookCount("chat.message")).toBe(0)
        expect(recordedHookCount("experimental.chat.messages.transform")).toBe(1)
        expect(recordedHookCount("chat.params")).toBe(1)
        expect(recordedHookCount("chat.headers")).toBe(1)

        yield* queue.enqueue({
          sessionID: chat.id,
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello second" }],
          },
          source: "test",
        })

        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(1)
        expect((yield* queue.list(chat.id)).map((item) => item.status)).toEqual(["queued"])
        expect(recordedHookCount("chat.message")).toBe(0)
        expect(recordedHookCount("experimental.chat.messages.transform")).toBe(1)
        expect(recordedHookCount("chat.params")).toBe(1)
        expect(recordedHookCount("chat.headers")).toBe(1)

        firstGate.resolve()
        yield* llm.wait(2)

        const firstExit = yield* Fiber.await(first)
        expect(Exit.isSuccess(firstExit)).toBe(true)

        secondGate.resolve()

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const pending = await Effect.runPromise(queue.list(chat.id))
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            const assistants = msgs.filter((msg) => msg.info.role === "assistant")
            if (
              pending.length === 0 &&
              assistants.length === 2 &&
              assistants.at(-1)?.parts.some((part) => part.type === "text" && part.text === "second reply")
            ) {
              return
            }
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for queued plugin hook dispatch")
        })

        expect(recordedHookCount("chat.message")).toBe(1)
        expect(recordedHookCount("experimental.chat.messages.transform")).toBe(2)
        expect(recordedHookCount("chat.params")).toBe(2)
        expect(recordedHookCount("chat.headers")).toBe(2)

        const chatMessageHook = recordedPluginHooks.find((hook) => hook.name === "chat.message")
        expect(chatMessageHook?.input).toMatchObject({
          sessionID: chat.id,
          agent: "build",
        })

        const hits = yield* llm.hits
        const lastHeaders = hits.at(-1)?.headers as Headers | Record<string, string> | undefined
        expect(hits.at(-1)?.body.temperature).toBe(0.123)
        expect(
          lastHeaders instanceof Headers ? lastHeaders.get("x-queue-hook") : lastHeaders?.["x-queue-hook"],
        ).toBe("queued")
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "queued prompt dispatch persists submission provenance on the executed user message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Queued submission provenance" })
        const firstGate = defer<void>()

        yield* llm.hold("first reply", firstGate.promise)
        yield* llm.text("second reply")
        yield* user(chat.id, "hello first")

        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const pending = yield* queue.enqueue({
          sessionID: chat.id,
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello second" }],
          },
          source: "test",
        })

        firstGate.resolve()
        yield* llm.wait(2)

        const firstExit = yield* Fiber.await(first)
        expect(Exit.isSuccess(firstExit)).toBe(true)

        const queuedUser = yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            const secondUser = msgs
              .filter((msg): msg is MessageV2.WithParts & { info: MessageV2.User } => msg.info.role === "user")
              .find((msg) => msg.parts.some((part) => part.type === "text" && part.text === "hello second"))
            if (secondUser) return secondUser
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for queued user message")
        })

        expect(queuedUser.info.submission).toMatchObject({
          mode: "queue",
          source: "test",
          queuedAt: pending.time.created,
          createdFromPendingMessageID: pending.id,
        })
        expect(typeof queuedUser.info.submission?.dispatchedAt).toBe("number")
        expect(queuedUser.info.submission?.dispatchedAt).toBeGreaterThanOrEqual(pending.time.created)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "steer prompt dispatch preserves steer submission provenance on the executed user message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Steer submission provenance" })
        const firstGate = defer<void>()

        yield* llm.pushMatch(
          (hit) => JSON.stringify(hit.body).includes("hello first"),
          reply().wait(firstGate.promise).text("first reply").stop().item(),
        )
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("hello steer"), "second reply")
        yield* user(chat.id, "hello first")

        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const pending = yield* queue.enqueue({
          sessionID: chat.id,
          mode: "steer",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello steer" }],
          },
          source: "test",
          supersedesExecutionID: "run_1",
        })

        firstGate.resolve()
        yield* llm.wait(2)

        const firstExit = yield* Fiber.await(first)
        expect(Exit.isSuccess(firstExit)).toBe(true)

        const steerUser = yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            const user = msgs
              .filter((msg): msg is MessageV2.WithParts & { info: MessageV2.User } => msg.info.role === "user")
              .find((msg) => msg.parts.some((part) => part.type === "text" && part.text === "hello steer"))
            if (user) return user
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for steer user message")
        })

        expect(steerUser.info.submission).toMatchObject({
          mode: "steer",
          source: "test",
          queuedAt: pending.time.created,
          supersedesExecutionID: "run_1",
          createdFromPendingMessageID: pending.id,
        })
        expect(typeof steerUser.info.submission?.dispatchedAt).toBe("number")
        expect(steerUser.info.submission?.dispatchedAt).toBeGreaterThanOrEqual(pending.time.created)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "steer while LLM is hanging interrupts the active run and blocks stale queued work",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const chat = yield* Effect.promise(() => Session.create({ title: "Steer hanging run" }))
        const app = Server.Default()

        const submit = (body: {
          mode: "queue" | "steer"
          payload: SessionQueue.PendingMessagePayload
          source: string
        }) =>
          Effect.promise(() =>
            Promise.resolve(
              app.request(`/session/${chat.id}/submit`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-opencode-directory": dir,
                },
                body: JSON.stringify(body),
              }),
            ),
          )

        yield* llm.reset
        yield* llm.pushMatch((hit) => JSON.stringify(hit.body).includes("hello first"), reply().hang().item())
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("hello steer"), "steered reply")
        const active = yield* user(chat.id, "hello first")

        const first = yield* Effect.promise(() => SessionPrompt.loop({ sessionID: chat.id })).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const staleRes = yield* submit({
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello stale" }],
          },
          source: "test",
        })
        expect(staleRes.status).toBe(200)
        const staleBody = (yield* Effect.promise(() => staleRes.json())) as {
          kind: "queued"
          pending: SessionQueue.PendingMessage
        }
        expect(staleBody.pending.createdAgainstExecutionID).toBe(active.id)

        const steerRes = yield* submit({
          mode: "steer",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello steer" }],
          },
          source: "test",
        })
        expect(steerRes.status).toBe(200)
        const steerBody = (yield* Effect.promise(() => steerRes.json())) as {
          kind: "queued"
          pending: SessionQueue.PendingMessage
        }
        expect(steerBody.pending.mode).toBe("steer")
        expect(steerBody.pending.createdAgainstExecutionID).toBe(active.id)
        expect(steerBody.pending.supersedesExecutionID).toBe(active.id)

        const firstExit = yield* Fiber.await(first)
        expect(Exit.isSuccess(firstExit)).toBe(true)
        if (Exit.isSuccess(firstExit) && firstExit.value.info.role === "assistant") {
          expect(firstExit.value.info.error?.name).toBe("MessageAbortedError")
        }

        const result = yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const pending = await SessionQueue.list(chat.id)
            const msgs = await Session.messages({ sessionID: chat.id })
            const steerUser = msgs.find((msg): msg is MessageV2.WithParts & { info: MessageV2.User } => {
              if (msg.info.role !== "user") return false
              return msg.parts.some((part) => part.type === "text" && part.text === "hello steer")
            })
            const steerAssistant = msgs.find((msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } => {
              if (msg.info.role !== "assistant") return false
              return msg.parts.some((part) => part.type === "text" && part.text === "steered reply")
            })
            const blocked = pending.find((item) => item.id === staleBody.pending.id)
            if (steerUser && steerAssistant && blocked?.status === "blocked_after_interrupt") {
              return { steerUser, blocked }
            }
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for steer interruption results")
        })

        expect(result.steerUser.info.submission).toMatchObject({
          mode: "steer",
          createdFromPendingMessageID: steerBody.pending.id,
          supersedesExecutionID: active.id,
        })
        expect(result.blocked.createdAgainstExecutionID).toBe(active.id)
        expect(yield* llm.calls).toBe(2)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

unix(
  "steer while a shell tool is running interrupts the tool and blocks stale queued work",
  () =>
    withSh(() =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const chat = yield* Effect.promise(() => Session.create({ title: "Steer running tool" }))
          const app = Server.Default()

          const submit = (body: {
            mode: "queue" | "steer"
            payload: SessionQueue.PendingMessagePayload
            source: string
          }) =>
            Effect.promise(() =>
              Promise.resolve(
                app.request(`/session/${chat.id}/submit`, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-opencode-directory": dir,
                  },
                  body: JSON.stringify(body),
                }),
              ),
            )

          yield* llm.reset
          yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("hello steer shell"), "steered shell reply")

          const shell = yield* Effect.promise(() =>
            SessionPrompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }),
          ).pipe(Effect.forkChild)

          const active = yield* Effect.promise(async () => {
            const end = Date.now() + 5000
            while (Date.now() < end) {
              const msgs = await Session.messages({ sessionID: chat.id })
              const activeUser = msgs.find((msg): msg is MessageV2.WithParts & { info: MessageV2.User } => {
                if (msg.info.role !== "user") return false
                return msg.parts.some(
                  (part) => part.type === "text" && part.text === "The following tool was executed by the user",
                )
              })
              const activeAssistant = msgs.find(
                (msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } =>
                  msg.info.role === "assistant" && msg.parts.some((part) => part.type === "tool"),
              )
              const tool = activeAssistant ? toolPart(activeAssistant.parts) : undefined
              if (activeUser && tool?.state.status === "running") return activeUser
              await new Promise((done) => setTimeout(done, 20))
            }
            throw new Error("timed out waiting for running shell tool")
          })

          const staleRes = yield* submit({
            mode: "queue",
            payload: {
              kind: "prompt",
              agent: "build",
              model: ref,
              variant: "default",
              parts: [{ type: "text", text: "hello stale shell" }],
            },
            source: "test",
          })
          expect(staleRes.status).toBe(200)
          const staleBody = (yield* Effect.promise(() => staleRes.json())) as {
            kind: "queued"
            pending: SessionQueue.PendingMessage
          }
          expect(staleBody.pending.createdAgainstExecutionID).toBe(active.info.id)

          const steerRes = yield* submit({
            mode: "steer",
            payload: {
              kind: "prompt",
              agent: "build",
              model: ref,
              variant: "default",
              parts: [{ type: "text", text: "hello steer shell" }],
            },
            source: "test",
          })
          expect(steerRes.status).toBe(200)
          const steerBody = (yield* Effect.promise(() => steerRes.json())) as {
            kind: "queued"
            pending: SessionQueue.PendingMessage
          }
          expect(steerBody.pending.mode).toBe("steer")
          expect(steerBody.pending.createdAgainstExecutionID).toBe(active.info.id)
          expect(steerBody.pending.supersedesExecutionID).toBe(active.info.id)

          const shellExit = yield* Fiber.await(shell)
          expect(Exit.isSuccess(shellExit)).toBe(true)
          if (Exit.isSuccess(shellExit)) {
            const tool = completedTool(shellExit.value.parts)
            if (tool) expect(tool.state.output).toContain("User aborted the command")
          }

          const result = yield* Effect.promise(async () => {
            const end = Date.now() + 5000
            while (Date.now() < end) {
              const pending = await SessionQueue.list(chat.id)
              const msgs = await Session.messages({ sessionID: chat.id })
              const steerUser = msgs.find((msg): msg is MessageV2.WithParts & { info: MessageV2.User } => {
                if (msg.info.role !== "user") return false
                return msg.parts.some((part) => part.type === "text" && part.text === "hello steer shell")
              })
              const steerAssistant = msgs.find((msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } => {
                if (msg.info.role !== "assistant") return false
                return msg.parts.some((part) => part.type === "text" && part.text === "steered shell reply")
              })
              const blocked = pending.find((item) => item.id === staleBody.pending.id)
              if (steerUser && steerAssistant && blocked?.status === "blocked_after_interrupt") {
                return { steerUser, blocked }
              }
              await new Promise((done) => setTimeout(done, 20))
            }
            throw new Error("timed out waiting for steer shell interruption results")
          })

          expect(result.steerUser.info.submission).toMatchObject({
            mode: "steer",
            createdFromPendingMessageID: steerBody.pending.id,
            supersedesExecutionID: active.info.id,
          })
          expect(result.blocked.createdAgainstExecutionID).toBe(active.info.id)
          expect(yield* llm.calls).toBe(1)
        }),
        { git: true, config: providerCfg },
      ),
    ),
  30_000,
)

it.live(
  "queued prompt dispatch still executes downstream tool calls",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const queue = yield* SessionQueue.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Queued tool path",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const firstGate = defer<void>()

        yield* llm.hold("first reply", firstGate.promise)
        yield* llm.tool("bash", { command: "printf queued-tool", description: "Print queued tool" })
        yield* llm.text("second reply")
        yield* user(chat.id, "hello first")

        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        yield* queue.enqueue({
          sessionID: chat.id,
          mode: "queue",
          payload: {
            kind: "prompt",
            agent: "build",
            model: ref,
            variant: "default",
            parts: [{ type: "text", text: "hello second" }],
          },
          source: "test",
        })

        firstGate.resolve()
        yield* Fiber.await(first)

        const queuedResult = yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const pending = await Effect.runPromise(queue.list(chat.id))
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            const finalAssistant = msgs.findLast((msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } => {
              if (msg.info.role !== "assistant") return false
              return msg.parts.some((part) => part.type === "text" && part.text === "second reply")
            })
            const toolAssistant = msgs.find((msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } => {
              if (msg.info.role !== "assistant") return false
              return msg.parts.some((part) => part.type === "tool" && part.state.status === "completed")
            })
            if (pending.length === 0 && finalAssistant && toolAssistant) {
              return { finalAssistant, toolAssistant }
            }
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for queued tool execution")
        })

        expect(yield* llm.calls).toBe(3)
        expect(queuedResult.finalAssistant.parts.some((part) => part.type === "text" && part.text === "second reply")).toBe(true)
        const tool = completedTool(queuedResult.toolAssistant.parts)
        expect(tool?.tool).toBe("bash")
        expect(tool?.state.input).toMatchObject({ command: "printf queued-tool" })
        expect(tool?.state.output).toContain("queued-tool")
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* prompt.assertNotBusy(chat.id)
      }),
    { git: true },
  ),
)

it.live(
  "concurrent loop callers all receive same error result",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.fail("boom")
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const a = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)

        const id = MessageID.ascending()
        const b = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
        expect(last.info.parentID).toBe(id)
        expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* prompt.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { git: true },
  ),
)

// Shell semantics

it.live(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* prompt.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell completes a fast command on the preferred shell", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("pwd")
        expect(tool.state.output).toContain(dir)
        expect(tool.state.metadata.output).toContain(dir)
        yield* prompt.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell lists files from the project directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# e2e\n"))

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command ls",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("command ls")
        expect(tool.state.output).toContain("README.md")
        expect(tool.state.metadata.output).toContain("README.md")
        yield* prompt.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell captures stderr from a failing command", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("not found")
        expect(tool.state.metadata.output).toContain("not found")
        yield* prompt.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = await MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

it.live(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* prompt.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)
