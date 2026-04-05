import type { PendingMessage } from "@opencode-ai/sdk/v2"

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
