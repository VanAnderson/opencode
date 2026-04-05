import { describe, expect, test } from "bun:test"
import type { PendingMessage } from "@opencode-ai/sdk/v2/client"
import type { Prompt } from "@/context/prompt"
import {
  buildPendingMessagePayload,
  pendingMessageAttachmentCount,
  pendingMessagePreview,
  pendingMessageToEdit,
  reorderPendingMessageIDs,
  type FollowupDraft,
} from "./session-queue"

const prompt = (text: string): Prompt => [{ type: "text", content: text, start: 0, end: text.length }]

const draft = (text: string): FollowupDraft => ({
  sessionID: "ses_1",
  sessionDirectory: "/repo",
  prompt: prompt(text),
  context: [],
  agent: "builder",
  model: {
    providerID: "openai",
    modelID: "gpt-5",
  },
})

const pending = (payload: ReturnType<typeof buildPendingMessagePayload>): PendingMessage =>
  ({
    id: "pnd_1",
    sessionID: "ses_1",
    position: 0,
    mode: "queue",
    status: "queued",
    payload,
    time: {
      created: 1,
      updated: 1,
    },
  }) as PendingMessage

describe("session queue helpers", () => {
  test("round-trips prompt payloads into preview and edit state", () => {
    const payload = buildPendingMessagePayload(draft("outline the plan"), [])
    expect(payload.kind).toBe("prompt")

    const item = pending(payload)
    expect(pendingMessagePreview(item)).toBe("outline the plan")
    expect(pendingMessageToEdit(item, "/repo")).toMatchObject({
      id: "pnd_1",
      prompt: prompt("outline the plan"),
      context: [],
    })
  })

  test("round-trips command payloads into preview and edit state", () => {
    const payload = buildPendingMessagePayload(draft("/review src/index.ts"), ["review"])
    expect(payload).toMatchObject({
      kind: "command",
      command: "review",
      arguments: "src/index.ts",
    })

    const item = pending(payload)
    expect(pendingMessagePreview(item)).toBe("/review src/index.ts")
    expect(pendingMessageToEdit(item, "/repo")).toMatchObject({
      id: "pnd_1",
      prompt: prompt("/review src/index.ts"),
      context: [],
    })
  })

  test("reorders pending IDs one slot at a time", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }] as Array<Pick<PendingMessage, "id">>

    expect(reorderPendingMessageIDs(items, "b", "up")).toEqual(["b", "a", "c"])
    expect(reorderPendingMessageIDs(items, "b", "down")).toEqual(["a", "c", "b"])
    expect(reorderPendingMessageIDs(items, "a", "up")).toBeUndefined()
    expect(reorderPendingMessageIDs(items, "c", "down")).toBeUndefined()
  })

  test("counts only queued attachment parts", () => {
    expect(
      pendingMessageAttachmentCount({
        payload: {
          kind: "prompt",
          parts: [
            { type: "text", text: "hello" },
            { type: "file", url: "file:///tmp/test.txt", mime: "text/plain" },
            { type: "file", url: "data:image/png;base64,AAA", mime: "image/png" },
          ],
        },
      } as Pick<PendingMessage, "payload">),
    ).toBe(1)

    expect(
      pendingMessageAttachmentCount({
        payload: {
          kind: "command",
          command: "read",
          arguments: "foo",
          parts: [{ type: "file", url: "data:image/png;base64,AAA", mime: "image/png" }],
        },
      } as Pick<PendingMessage, "payload">),
    ).toBe(1)
  })
})
