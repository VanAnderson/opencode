import { describe, expect, mock, test } from "bun:test"
import { dispatchPromptSubmit, usesQueuedSubmit } from "../../../../src/cli/cmd/tui/component/prompt/submit"

function createClient() {
  return {
    session: {
      prompt: mock(async (_input: unknown) => undefined),
      command: mock(async (_input: unknown) => undefined),
      shell: mock(async (_input: unknown) => undefined),
      queueUpdate: mock(async (_input: unknown) => undefined),
      submit: mock(async (_input: unknown) => undefined),
    },
  }
}

describe("tui prompt submit", () => {
  test("detects queued-submit mode only for busy non-shell requests", () => {
    expect(
      usesQueuedSubmit({
        status: { type: "busy" },
        request: {
          kind: "prompt",
          sessionID: "ses_1",
          messageID: "msg_1",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5" },
          parts: [{ type: "text", text: "hi" }],
        },
      }),
    ).toBe(true)

    expect(
      usesQueuedSubmit({
        status: { type: "busy" },
        request: {
          kind: "shell",
          sessionID: "ses_1",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5" },
          command: "pwd",
        },
      }),
    ).toBe(false)
  })

  test("routes busy prompt submissions through session.submit with queue mode by default", async () => {
    const client = createClient()

    await dispatchPromptSubmit({
      client,
      status: { type: "busy" },
      request: {
        kind: "prompt",
        sessionID: "ses_1",
        messageID: "msg_1",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "fast",
        parts: [{ type: "text", text: "queued" }],
      },
    })

    expect(client.session.submit).toHaveBeenCalledTimes(1)
    expect(client.session.submit).toHaveBeenCalledWith({
      sessionID: "ses_1",
      mode: "queue",
      source: "tui",
      payload: {
        kind: "prompt",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "fast",
        parts: [{ type: "text", text: "queued" }],
      },
    })
    expect(client.session.prompt).toHaveBeenCalledTimes(0)
    expect(client.session.command).toHaveBeenCalledTimes(0)
  })

  test("routes busy slash-command submissions through session.submit with explicit steer mode", async () => {
    const client = createClient()

    await dispatchPromptSubmit({
      client,
      status: { type: "busy" },
      requestedMode: "steer",
      request: {
        kind: "command",
        sessionID: "ses_1",
        messageID: "msg_1",
        command: "review",
        arguments: "--fix",
        agent: "build",
        model: "openai/gpt-5",
        variant: "max",
        parts: [
          {
            type: "file",
            mime: "image/png",
            filename: "a.png",
            url: "data:image/png;base64,abc",
          },
        ],
      },
    })

    expect(client.session.submit).toHaveBeenCalledTimes(1)
    expect(client.session.submit).toHaveBeenCalledWith({
      sessionID: "ses_1",
      mode: "steer",
      source: "tui",
      payload: {
        kind: "command",
        command: "review",
        arguments: "--fix",
        agent: "build",
        model: "openai/gpt-5",
        variant: "max",
        parts: [
          {
            type: "file",
            mime: "image/png",
            filename: "a.png",
            url: "data:image/png;base64,abc",
          },
        ],
      },
    })
    expect(client.session.command).toHaveBeenCalledTimes(0)
    expect(client.session.queueUpdate).toHaveBeenCalledTimes(0)
  })

  test("keeps idle prompt submissions on the immediate prompt endpoint", async () => {
    const client = createClient()

    await dispatchPromptSubmit({
      client,
      status: { type: "idle" },
      request: {
        kind: "prompt",
        sessionID: "ses_1",
        messageID: "msg_1",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        parts: [{ type: "text", text: "now" }],
      },
    })

    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).toHaveBeenCalledWith({
      sessionID: "ses_1",
      messageID: "msg_1",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      variant: undefined,
      parts: [{ type: "text", text: "now" }],
    })
    expect(client.session.submit).toHaveBeenCalledTimes(0)
    expect(client.session.queueUpdate).toHaveBeenCalledTimes(0)
  })

  test("keeps shell submissions on the shell endpoint even while busy", async () => {
    const client = createClient()

    await dispatchPromptSubmit({
      client,
      status: { type: "busy" },
      requestedMode: "steer",
      request: {
        kind: "shell",
        sessionID: "ses_1",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        command: "pwd",
      },
    })

    expect(client.session.shell).toHaveBeenCalledTimes(1)
    expect(client.session.shell).toHaveBeenCalledWith({
      sessionID: "ses_1",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      command: "pwd",
    })
    expect(client.session.submit).toHaveBeenCalledTimes(0)
    expect(client.session.queueUpdate).toHaveBeenCalledTimes(0)
  })

  test("updates the same queued prompt item when editing instead of creating a new submission", async () => {
    const client = createClient()

    await dispatchPromptSubmit({
      client,
      status: { type: "busy" },
      requestedMode: "steer",
      editingPendingMessage: {
        pendingMessageID: "pending_1",
        mode: "queue",
      },
      request: {
        kind: "prompt",
        sessionID: "ses_1",
        messageID: "msg_1",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        parts: [{ type: "text", text: "edited" }],
      },
    })

    expect(client.session.queueUpdate).toHaveBeenCalledTimes(1)
    expect(client.session.queueUpdate).toHaveBeenCalledWith({
      sessionID: "ses_1",
      pendingMessageID: "pending_1",
      payload: {
        kind: "prompt",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: undefined,
        parts: [{ type: "text", text: "edited" }],
      },
    })
    expect(client.session.submit).toHaveBeenCalledTimes(0)
    expect(client.session.prompt).toHaveBeenCalledTimes(0)
  })

  test("updates the same queued command item when editing instead of re-steering it", async () => {
    const client = createClient()

    await dispatchPromptSubmit({
      client,
      status: { type: "busy" },
      requestedMode: "steer",
      editingPendingMessage: {
        pendingMessageID: "pending_2",
        mode: "steer",
      },
      request: {
        kind: "command",
        sessionID: "ses_1",
        messageID: "msg_1",
        command: "review",
        arguments: "--fix",
        agent: "build",
        model: "openai/gpt-5",
        parts: [
          {
            type: "file",
            mime: "image/png",
            filename: "a.png",
            url: "data:image/png;base64,abc",
          },
        ],
      },
    })

    expect(client.session.queueUpdate).toHaveBeenCalledTimes(1)
    expect(client.session.queueUpdate).toHaveBeenCalledWith({
      sessionID: "ses_1",
      pendingMessageID: "pending_2",
      payload: {
        kind: "command",
        command: "review",
        arguments: "--fix",
        agent: "build",
        model: "openai/gpt-5",
        variant: undefined,
        parts: [
          {
            type: "file",
            mime: "image/png",
            filename: "a.png",
            url: "data:image/png;base64,abc",
          },
        ],
      },
    })
    expect(client.session.submit).toHaveBeenCalledTimes(0)
    expect(client.session.command).toHaveBeenCalledTimes(0)
  })
})
