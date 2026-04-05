import { describe, expect, test } from "bun:test"

import { PendingMessageID, SessionID } from "../../src/session/schema"
import { SessionQueue } from "../../src/session/queue"

describe("SessionQueue schema", () => {
  test("parses prompt payloads", () => {
    const payload = SessionQueue.PendingMessagePayload.parse({
      kind: "prompt",
      agent: "default",
      model: {
        providerID: "openai",
        modelID: "gpt-4.1",
      },
      variant: "default",
      parts: [
        {
          type: "text",
          text: "ship it",
        },
      ],
    })

    expect(payload.kind).toBe("prompt")
    expect(payload.parts[0]?.type).toBe("text")
  })

  test("parses command payloads", () => {
    const payload = SessionQueue.PendingMessagePayload.parse({
      kind: "command",
      command: "init",
      arguments: "--force",
      agent: "default",
      model: "openai/gpt-4.1",
      variant: "default",
      parts: [
        {
          type: "file",
          mime: "text/plain",
          url: "file:///tmp/readme.md",
          filename: "readme.md",
        },
      ],
    })

    expect(payload.kind).toBe("command")
    expect(payload.parts?.[0]?.type).toBe("file")
  })

  test("parses pending message rows", () => {
    const pending = SessionQueue.PendingMessage.parse({
      id: PendingMessageID.ascending(),
      sessionID: SessionID.make("ses_testqueue123456789012345"),
      position: 0,
      mode: "queue",
      status: "queued",
      payload: {
        kind: "prompt",
        agent: "default",
        model: {
          providerID: "openai",
          modelID: "gpt-4.1",
        },
        parts: [
          {
            type: "text",
            text: "hello",
          },
        ],
      },
      source: "app",
      createdAgainstExecutionID: "exec_1",
      time: {
        created: 1,
        updated: 2,
      },
    })

    expect(pending.status).toBe("queued")
    expect(pending.payload.kind).toBe("prompt")
  })
})
