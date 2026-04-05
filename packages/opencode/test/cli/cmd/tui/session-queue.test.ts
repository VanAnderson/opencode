import { describe, expect, test } from "bun:test"
import type { PendingMessage } from "@opencode-ai/sdk/v2"
import {
  pendingMessageAttachmentCount,
  pendingMessageToPromptInfo,
  pendingMessagePreview,
  pendingQueueSummary,
  reorderPendingMessageIDs,
  visiblePendingMessages,
} from "../../../../src/cli/cmd/tui/util/session-queue"

const promptPending = (id: string, status: PendingMessage["status"] = "queued") =>
  ({
    id,
    sessionID: "ses_1",
    position: 0,
    mode: "queue",
    status,
    payload: {
      kind: "prompt",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      parts: [{ type: "text", text: `prompt ${id}` }],
    },
    time: { created: 1, updated: 1 },
  }) as PendingMessage

const commandPending = (id: string, status: PendingMessage["status"] = "queued") =>
  ({
    id,
    sessionID: "ses_1",
    position: 0,
    mode: "steer",
    status,
    payload: {
      kind: "command",
      command: "review",
      arguments: "--fix",
      agent: "build",
      model: "openai/gpt-5",
      parts: [{ type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,abc" }],
    },
    time: { created: 1, updated: 1 },
  }) as PendingMessage

describe("tui session queue helpers", () => {
  test("filters out consumed and canceled items from the visible queue", () => {
    const visible = visiblePendingMessages([
      promptPending("pnd_1"),
      promptPending("pnd_2", "blocked_after_interrupt"),
      promptPending("pnd_3", "consumed"),
      promptPending("pnd_4", "canceled"),
    ])

    expect(visible.map((item) => item.id)).toEqual(["pnd_1", "pnd_2"])
  })

  test("builds prompt and command previews for queue items", () => {
    expect(pendingMessagePreview(promptPending("pnd_1"))).toBe("prompt pnd_1")
    expect(pendingMessagePreview(commandPending("pnd_2"))).toBe("/review --fix")
  })

  test("counts queued attachments from prompt and command payloads", () => {
    const promptWithAttachments = {
      payload: {
        kind: "prompt",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        parts: [
          { type: "text", text: "hi" },
          { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,abc" },
          { type: "file", mime: "text/plain", filename: "note.txt", url: "/tmp/note.txt" },
        ],
      },
    } as PendingMessage

    expect(pendingMessageAttachmentCount(commandPending("pnd_1"))).toBe(1)
    expect(pendingMessageAttachmentCount(promptWithAttachments)).toBe(1)
  })

  test("summarizes visible and blocked queue counts", () => {
    expect(
      pendingQueueSummary([
        promptPending("pnd_1"),
        promptPending("pnd_2", "blocked_after_interrupt"),
        promptPending("pnd_3", "consumed"),
      ]),
    ).toMatchObject({
      visibleCount: 2,
      blockedCount: 1,
    })
  })

  test("reorders queue ids one step at a time", () => {
    const pending = [promptPending("pnd_1"), promptPending("pnd_2"), promptPending("pnd_3")]

    expect(reorderPendingMessageIDs(pending, "pnd_2", "up")).toEqual(["pnd_2", "pnd_1", "pnd_3"])
    expect(reorderPendingMessageIDs(pending, "pnd_2", "down")).toEqual(["pnd_1", "pnd_3", "pnd_2"])
    expect(reorderPendingMessageIDs(pending, "pnd_1", "up")).toBeUndefined()
  })

  test("restores queued command payloads into editable prompt info", () => {
    expect(pendingMessageToPromptInfo(commandPending("pnd_5"))).toEqual({
      input: "/review --fix [Image 1]",
      parts: [
        {
          type: "file",
          mime: "image/png",
          filename: "a.png",
          url: "data:image/png;base64,abc",
          source: {
            type: "file",
            path: "a.png",
            text: {
              start: 14,
              end: 23,
              value: "[Image 1]",
            },
          },
        },
      ],
    })
  })

  test("restores queued prompt payloads into editable prompt info", () => {
    expect(
      pendingMessageToPromptInfo({
        ...promptPending("pnd_6"),
        payload: {
          kind: "prompt",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5" },
          parts: [
            { type: "text", text: "review @build" },
            {
              type: "agent",
              name: "build",
              source: {
                start: 7,
                end: 13,
                value: "@build",
              },
            },
            {
              type: "file",
              mime: "image/png",
              filename: "a.png",
              url: "data:image/png;base64,abc",
            },
          ],
        },
      } as PendingMessage),
    ).toEqual({
      input: "review @build [Image 1]",
      parts: [
        {
          type: "agent",
          name: "build",
          source: {
            start: 7,
            end: 13,
            value: "@build",
          },
        },
        {
          type: "file",
          mime: "image/png",
          filename: "a.png",
          url: "data:image/png;base64,abc",
          source: {
            type: "file",
            path: "a.png",
            text: {
              start: 14,
              end: 23,
              value: "[Image 1]",
            },
          },
        },
      ],
    })
  })

  test("refuses to restore unsupported queued prompt payloads with extra synthetic text", () => {
    expect(
      pendingMessageToPromptInfo({
        ...promptPending("pnd_7"),
        payload: {
          kind: "prompt",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5" },
          parts: [
            { type: "text", text: "main prompt" },
            { type: "text", text: "synthetic note", synthetic: true },
          ],
        },
      } as PendingMessage),
    ).toBeUndefined()
  })
})
