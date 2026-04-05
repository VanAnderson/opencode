import type {
  Part,
  PendingMessage,
  PendingMessageCommandPayload,
  PendingMessagePromptPayload,
} from "@opencode-ai/sdk/v2/client"
import { createPathHelpers } from "@/context/file/path"
import type { ContextItem, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { buildRequestParts } from "@/components/prompt-input/build-request-parts"
import { Identifier } from "@/utils/id"
import { readCommentMetadata } from "@/utils/comment-note"
import { extractPromptFromParts } from "@/utils/prompt"

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

export type FollowupEdit = Pick<FollowupDraft, "prompt" | "context"> & { id: string }

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

const selectionFromUrl = (url: string) => {
  const index = url.indexOf("?")
  if (index === -1) return undefined
  const params = new URLSearchParams(url.slice(index + 1))
  const startLine = Number(params.get("start"))
  const endLine = Number(params.get("end"))
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined
  return {
    startLine,
    startChar: 0,
    endLine,
    endChar: 0,
  }
}

const contextKey = (
  path: string,
  selection?: {
    startLine: number
    startChar: number
    endLine: number
    endChar: number
  },
) =>
  `${path}:${selection?.startLine ?? ""}:${selection?.startChar ?? ""}:${selection?.endLine ?? ""}:${selection?.endChar ?? ""}`

const formatPromptPreview = (prompt: Prompt) => {
  const text = prompt
    .map((part) => {
      if (part.type === "image") return ""
      if (part.type === "file") return `[file:${part.path}]`
      if (part.type === "agent") return `@${part.name}`
      return part.content
    })
    .join("")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => !!line)

  if (text) return text
  const image = prompt.find((part) => part.type === "image")
  if (image?.type === "image") return `[image:${image.filename}]`
  return "[attachment]"
}

const promptPartsToMessageParts = (
  parts: PendingMessagePromptPayload["parts"],
  sessionID: string,
  messageID: string,
) => {
  return parts.flatMap((part): Part[] => {
    if (part.type === "subtask") return []
    return [
      {
        ...part,
        id: part.id ?? Identifier.ascending("part"),
        sessionID,
        messageID,
      } satisfies Part,
    ]
  })
}

const commandPrompt = (payload: PendingMessageCommandPayload) => {
  const text = `/${payload.command}${payload.arguments ? ` ${payload.arguments}` : ""}`
  const prompt: Prompt = [{ type: "text", content: text, start: 0, end: text.length }]
  for (const part of payload.parts ?? []) {
    if (!part.url.startsWith("data:")) continue
    prompt.push({
      type: "image",
      id: part.id ?? Identifier.ascending("part"),
      filename: part.filename ?? "attachment",
      mime: part.mime,
      dataUrl: part.url,
    })
  }
  return prompt
}

const promptContext = (payload: PendingMessagePromptPayload, sessionDirectory: string): FollowupDraft["context"] => {
  const normalizePath = createPathHelpers(() => sessionDirectory).normalize
  const commentKeys = new Set<string>()
  const plainKeys = new Set<string>()
  const context: FollowupDraft["context"] = []

  for (const part of payload.parts) {
    if (part.type !== "text") continue
    const comment = readCommentMetadata(part.metadata)
    if (!comment) continue
    const key = contextKey(comment.path, comment.selection)
    if (commentKeys.has(key)) continue
    commentKeys.add(key)
    context.push({
      key: `ctx:${context.length}`,
      type: "file",
      path: comment.path,
      selection: comment.selection,
      comment: comment.comment,
      preview: comment.preview,
      commentOrigin: comment.origin,
    })
  }

  for (const part of payload.parts) {
    if (part.type !== "file" || part.source || part.url.startsWith("data:")) continue
    const path = normalizePath(part.url)
    const selection = selectionFromUrl(part.url)
    const key = contextKey(path, selection)
    if (commentKeys.has(key) || plainKeys.has(key)) continue
    plainKeys.add(key)
    context.push({
      key: `ctx:${context.length}`,
      type: "file",
      path,
      selection,
    })
  }

  return context
}

export function buildPendingMessagePayload(
  draft: FollowupDraft,
  commandNames: string[],
): PendingMessagePromptPayload | PendingMessageCommandPayload {
  const text = draftText(draft.prompt)
  const images = draftImages(draft.prompt)
  const [head, ...tail] = text.split(" ")
  const command = head?.startsWith("/") ? head.slice(1) : undefined

  if (command && commandNames.includes(command)) {
    return {
      kind: "command",
      command,
      arguments: tail.join(" "),
      agent: draft.agent,
      model: `${draft.model.providerID}/${draft.model.modelID}`,
      variant: draft.variant,
      parts: images.map((attachment) => ({
        id: Identifier.ascending("part"),
        type: "file" as const,
        mime: attachment.mime,
        url: attachment.dataUrl,
        filename: attachment.filename,
      })),
    }
  }

  const { requestParts } = buildRequestParts({
    prompt: draft.prompt,
    context: draft.context,
    images,
    text,
    messageID: Identifier.ascending("message"),
    sessionID: draft.sessionID,
    sessionDirectory: draft.sessionDirectory,
  })

  return {
    kind: "prompt",
    agent: draft.agent,
    model: draft.model,
    variant: draft.variant,
    parts: requestParts,
  }
}

export function pendingMessagePreview(pending: PendingMessage) {
  if (pending.payload.kind === "command") {
    return formatPromptPreview(commandPrompt(pending.payload))
  }

  const prompt = extractPromptFromParts(
    promptPartsToMessageParts(pending.payload.parts, pending.sessionID, Identifier.ascending("message")),
    { directory: "/" },
  )
  return formatPromptPreview(prompt)
}

export function pendingMessageToEdit(pending: PendingMessage, sessionDirectory: string): FollowupEdit {
  if (pending.payload.kind === "command") {
    return {
      id: pending.id,
      prompt: commandPrompt(pending.payload),
      context: [],
    }
  }

  return {
    id: pending.id,
    prompt: extractPromptFromParts(
      promptPartsToMessageParts(pending.payload.parts, pending.sessionID, Identifier.ascending("message")),
      { directory: sessionDirectory },
    ),
    context: promptContext(pending.payload, sessionDirectory),
  }
}

export function reorderPendingMessageIDs(
  pending: Pick<PendingMessage, "id">[],
  pendingMessageID: string,
  direction: "up" | "down",
) {
  const index = pending.findIndex((item) => item.id === pendingMessageID)
  if (index === -1) return

  const nextIndex = direction === "up" ? index - 1 : index + 1
  if (nextIndex < 0 || nextIndex >= pending.length) return

  const next = pending.map((item) => item.id)
  ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
  return next
}
