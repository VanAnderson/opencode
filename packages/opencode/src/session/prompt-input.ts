import z from "zod"
import { ModelID, ProviderID } from "../provider/schema"
import { MessageV2 } from "./message-v2"
import { MessageID, SessionID } from "./schema"

const PromptPartInput = z.discriminatedUnion("type", [
  MessageV2.TextPart.omit({
    messageID: true,
    sessionID: true,
  })
    .partial({
      id: true,
    })
    .meta({
      ref: "TextPartInput",
    }),
  MessageV2.FilePart.omit({
    messageID: true,
    sessionID: true,
  })
    .partial({
      id: true,
    })
    .meta({
      ref: "FilePartInput",
    }),
  MessageV2.AgentPart.omit({
    messageID: true,
    sessionID: true,
  })
    .partial({
      id: true,
    })
    .meta({
      ref: "AgentPartInput",
    }),
  MessageV2.SubtaskPart.omit({
    messageID: true,
    sessionID: true,
  })
    .partial({
      id: true,
    })
    .meta({
      ref: "SubtaskPartInput",
    }),
])

export const PromptInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  agent: z.string().optional(),
  noReply: z.boolean().optional(),
  tools: z
    .record(z.string(), z.boolean())
    .optional()
    .describe("@deprecated tools and permissions have been merged, you can set permissions on the session itself now"),
  format: MessageV2.Format.optional(),
  system: z.string().optional(),
  variant: z.string().optional(),
  submission: MessageV2.Submission.optional(),
  parts: z.array(PromptPartInput),
})
export type PromptInput = z.infer<typeof PromptInput>

export const LoopInput = z.object({
  sessionID: SessionID.zod,
})
export type LoopInput = z.infer<typeof LoopInput>

export const ShellInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  agent: z.string(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  command: z.string(),
})
export type ShellInput = z.infer<typeof ShellInput>

const CommandPartInput = z.discriminatedUnion("type", [
  MessageV2.FilePart.omit({
    messageID: true,
    sessionID: true,
  }).partial({
    id: true,
  }),
])

export const CommandInput = z.object({
  messageID: MessageID.zod.optional(),
  sessionID: SessionID.zod,
  agent: z.string().optional(),
  model: z.string().optional(),
  arguments: z.string(),
  command: z.string(),
  variant: z.string().optional(),
  submission: MessageV2.Submission.optional(),
  parts: z.array(CommandPartInput).optional(),
})
export type CommandInput = z.infer<typeof CommandInput>
