import path from "path"
import { fileURLToPath } from "url"
import type { PendingMessage, TextPart } from "@opencode-ai/sdk/v2"
import type { PromptInfo } from "../component/prompt/history"

const PREVIEW_LIMIT = 96

function truncate(value: string) {
  if (value.length <= PREVIEW_LIMIT) return value
  return value.slice(0, PREVIEW_LIMIT - 1) + "…"
}

function firstMeaningfulLine(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

function primaryTextPart(pending: PendingMessage) {
  if (pending.payload.kind !== "prompt") return undefined
  const visible = pending.payload.parts
    .filter((part): part is TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)

  return visible.reduce((best: TextPart | undefined, part) => {
    if (!best) return part
    if (part.text.length > best.text.length) return part
    return best
  }, undefined)
}

function appendVirtualText(input: string, virtualText: string) {
  const separator = input.length > 0 && !/\s$/.test(input) ? " " : ""
  const start = input.length + separator.length
  return {
    input: input + separator + virtualText,
    start,
    end: start + virtualText.length,
  }
}

function filePathForRestore(part: Extract<PromptInfo["parts"][number], { type: "file" }>) {
  if (part.source?.type === "file") return part.source.path
  if (!part.url.startsWith("file://")) return part.filename ?? part.url
  try {
    return fileURLToPath(part.url)
  } catch {
    return part.filename ?? part.url
  }
}

function restoreFilePart(input: string, part: Extract<PromptInfo["parts"][number], { type: "file" }>, index: number) {
  if (part.source?.text) {
    return { input, part }
  }

  const restoredPath = filePathForRestore(part)
  const fallbackName = part.filename ?? (path.basename(restoredPath || part.url) || "file")
  const virtualText = part.url.startsWith("data:")
    ? `[${part.mime.startsWith("image/") ? "Image" : "Attachment"} ${index}]`
    : `@${fallbackName}`
  const next = appendVirtualText(input, virtualText)

  return {
    input: next.input,
    part: {
      ...part,
      source: {
        type: "file" as const,
        path: restoredPath,
        text: {
          start: next.start,
          end: next.end,
          value: virtualText,
        },
      },
    } satisfies Extract<PromptInfo["parts"][number], { type: "file" }>,
  }
}

function restoreAgentPart(input: string, part: Extract<PromptInfo["parts"][number], { type: "agent" }>) {
  if (part.source) {
    return { input, part }
  }

  const virtualText = `@${part.name}`
  const next = appendVirtualText(input, virtualText)

  return {
    input: next.input,
    part: {
      ...part,
      source: {
        start: next.start,
        end: next.end,
        value: virtualText,
      },
    } satisfies Extract<PromptInfo["parts"][number], { type: "agent" }>,
  }
}

export function visiblePendingMessages(pending: PendingMessage[]) {
  return pending.filter((item) => item.status !== "consumed" && item.status !== "canceled")
}

export function pendingMessagePreview(pending: PendingMessage) {
  if (pending.payload.kind === "command") {
    const value = `/${pending.payload.command}${pending.payload.arguments ? ` ${pending.payload.arguments}` : ""}`.trim()
    return truncate(value)
  }

  const text = firstMeaningfulLine(
    pending.payload.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  )
  if (text) return truncate(text)

  const attachment = pending.payload.parts.find((part) => part.type === "file" && part.url.startsWith("data:"))
  if (attachment?.type === "file") {
    return `[attachment:${attachment.filename ?? "file"}]`
  }

  return "[pending message]"
}

export function pendingMessageAttachmentCount(pending: Pick<PendingMessage, "payload">) {
  if (pending.payload.kind === "command") return pending.payload.parts?.length ?? 0
  return pending.payload.parts.reduce((count, part) => {
    if (part.type !== "file" || !part.url.startsWith("data:")) return count
    return count + 1
  }, 0)
}

export function pendingQueueSummary(pending: PendingMessage[]) {
  const visible = visiblePendingMessages(pending)
  const blocked = visible.filter((item) => item.status === "blocked_after_interrupt").length
  return {
    visible,
    visibleCount: visible.length,
    blockedCount: blocked,
  }
}

export function pendingMessageToPromptInfo(pending: PendingMessage): PromptInfo | undefined {
  if (pending.payload.kind === "command") {
    let input = `/${pending.payload.command}${pending.payload.arguments ? ` ${pending.payload.arguments}` : ""}`.trim()
    let attachmentIndex = 0
    const parts = (pending.payload.parts ?? []).map((part) => {
      attachmentIndex += 1
      const restored = restoreFilePart(input, part, attachmentIndex)
      input = restored.input
      return restored.part
    })

    return {
      input,
      parts,
    }
  }

  const mainText = primaryTextPart(pending)
  let input = mainText?.text ?? ""
  let attachmentIndex = 0
  const parts = [] as PromptInfo["parts"]

  for (const part of pending.payload.parts) {
    if (part.type === "subtask") return undefined
    if (part.type === "text") {
      if (part === mainText) continue
      return undefined
    }
    if (part.type === "file") {
      attachmentIndex += 1
      const restored = restoreFilePart(input, part, attachmentIndex)
      input = restored.input
      parts.push(restored.part)
      continue
    }

    const restored = restoreAgentPart(input, part)
    input = restored.input
    parts.push(restored.part)
  }

  return {
    input,
    parts,
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
