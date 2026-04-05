import z from "zod"

import { SessionPrompt } from "./prompt"
import { PendingMessageID, SessionID } from "./schema"

export namespace SessionQueue {
  export const PendingMessageMode = z.enum(["queue", "steer"]).meta({
    ref: "PendingMessageMode",
  })
  export type PendingMessageMode = z.infer<typeof PendingMessageMode>

  export const PendingMessageStatus = z
    .enum(["queued", "running", "blocked_after_interrupt", "failed", "canceled", "consumed"])
    .meta({
      ref: "PendingMessageStatus",
    })
  export type PendingMessageStatus = z.infer<typeof PendingMessageStatus>

  export const PendingMessagePromptPayload = SessionPrompt.PromptInput.omit({
    sessionID: true,
    messageID: true,
    noReply: true,
  })
    .extend({
      kind: z.literal("prompt"),
    })
    .meta({
      ref: "PendingMessagePromptPayload",
    })
  export type PendingMessagePromptPayload = z.infer<typeof PendingMessagePromptPayload>

  export const PendingMessageCommandPayload = SessionPrompt.CommandInput.omit({
    sessionID: true,
    messageID: true,
  })
    .extend({
      kind: z.literal("command"),
    })
    .meta({
      ref: "PendingMessageCommandPayload",
    })
  export type PendingMessageCommandPayload = z.infer<typeof PendingMessageCommandPayload>

  export const PendingMessagePayload = z.discriminatedUnion("kind", [
    PendingMessagePromptPayload,
    PendingMessageCommandPayload,
  ])
  export type PendingMessagePayload = z.infer<typeof PendingMessagePayload>

  export const PendingMessageError = z
    .object({
      message: z.string(),
      code: z.string().optional(),
    })
    .meta({
      ref: "PendingMessageError",
    })
  export type PendingMessageError = z.infer<typeof PendingMessageError>

  export const PendingMessage = z
    .object({
      id: PendingMessageID.zod,
      sessionID: SessionID.zod,
      position: z.number().int().nonnegative(),
      mode: PendingMessageMode,
      status: PendingMessageStatus,
      payload: PendingMessagePayload,
      source: z.string().optional(),
      createdAgainstExecutionID: z.string().optional(),
      supersedesExecutionID: z.string().optional(),
      error: PendingMessageError.optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({
      ref: "PendingMessage",
    })
  export type PendingMessage = z.infer<typeof PendingMessage>
}

export type PendingMessageMode = SessionQueue.PendingMessageMode
export type PendingMessageStatus = SessionQueue.PendingMessageStatus
export type PendingMessagePayload = SessionQueue.PendingMessagePayload
export type PendingMessageError = SessionQueue.PendingMessageError
export type PendingMessage = SessionQueue.PendingMessage
