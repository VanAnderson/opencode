import type { PendingMessage } from "@opencode-ai/sdk/v2"
import { createMemo, onMount } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { Locale } from "@/util/locale"
import {
  pendingMessageAttachmentCount,
  pendingMessagePreview,
  pendingQueueSummary,
  reorderPendingMessageIDs,
  visiblePendingMessages,
} from "../util/session-queue"

function pendingMessageModel(pending: PendingMessage) {
  if (pending.payload.kind === "command") return pending.payload.model
  if (!pending.payload.model) return undefined
  return `${pending.payload.model.providerID}/${pending.payload.model.modelID}`
}

function pendingMessageMeta(pending: PendingMessage) {
  const attachmentCount = pendingMessageAttachmentCount(pending)
  return [
    Locale.time(pending.time.created),
    pending.mode,
    pending.status.replaceAll("_", " "),
    pending.payload.agent,
    pendingMessageModel(pending),
    attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}

function pendingMessageDetails(pending: PendingMessage) {
  return [
    `Preview: ${pendingMessagePreview(pending)}`,
    `Mode: ${pending.mode}`,
    `Status: ${pending.status.replaceAll("_", " ")}`,
    `Created: ${Locale.time(pending.time.created)}`,
    `Agent: ${pending.payload.agent}`,
    pendingMessageModel(pending) ? `Model: ${pendingMessageModel(pending)}` : undefined,
    `Attachments: ${pendingMessageAttachmentCount(pending)}`,
  ]
    .filter(Boolean)
    .join("\n")
}

function queueMutationError(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (error instanceof Error) return error.message
  return "Queue action failed."
}

async function expectOk<T>(promise: Promise<{ data?: T; error?: unknown }>) {
  const result = await promise
  if (result.error) throw result.error
  return result.data
}

export function DialogSessionQueue(props: { sessionID: string }) {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const pending = createMemo(() => visiblePendingMessages(sync.data.queue[props.sessionID] ?? []))

  const reopen = () => {
    dialog.replace(() => <DialogSessionQueue sessionID={props.sessionID} />)
  }

  const clearQueue = async () => {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Clear queue",
      "Remove all queued and blocked submissions for this session?",
    )
    if (!confirmed) {
      reopen()
      return
    }

    try {
      await expectOk(sdk.client.session.queueClear({ sessionID: props.sessionID }))
      dialog.clear()
    } catch (error) {
      await DialogAlert.show(dialog, "Clear queue failed", queueMutationError(error))
      reopen()
    }
  }

  const options = createMemo((): DialogSelectOption<string>[] => {
    if (pending().length === 0) {
      return [
        {
          title: "Queue is empty",
          value: "empty",
          description: "There are no queued or blocked submissions for this session.",
        },
      ]
    }

    return [
      ...pending().map((item) => ({
        title: pendingMessagePreview(item),
        value: item.id,
        category: "Pending",
        description: pendingMessageMeta(item),
        onSelect: () => {
          dialog.replace(() => <DialogSessionQueueItem sessionID={props.sessionID} pendingMessageID={item.id} />)
        },
      })),
      {
        title: "Clear queue",
        value: "clear",
        category: "Actions",
        description: "Delete every queued or blocked submission that has not started running.",
        onSelect: () => {
          void clearQueue()
        },
      },
    ]
  })

  return <DialogSelect title="Session queue" options={options()} />
}

function DialogSessionQueueItem(props: { sessionID: string; pendingMessageID: string }) {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const pending = createMemo(() => visiblePendingMessages(sync.data.queue[props.sessionID] ?? []))
  const item = createMemo(() => pending().find((entry) => entry.id === props.pendingMessageID))

  const reopenList = () => {
    dialog.replace(() => <DialogSessionQueue sessionID={props.sessionID} />)
  }

  const reopenItem = () => {
    dialog.replace(() => <DialogSessionQueueItem sessionID={props.sessionID} pendingMessageID={props.pendingMessageID} />)
  }

  const mutate = async (run: () => Promise<void>, errorTitle: string, next: () => void = reopenList) => {
    try {
      await run()
      next()
    } catch (error) {
      await DialogAlert.show(dialog, errorTitle, queueMutationError(error))
      reopenItem()
    }
  }

  const inspect = async () => {
    const current = item()
    if (!current) {
      reopenList()
      return
    }
    await DialogAlert.show(dialog, "Queue item", pendingMessageDetails(current))
    reopenItem()
  }

  const resume = async () => {
    const current = item()
    if (!current) {
      reopenList()
      return
    }
    await mutate(
      async () => {
        await expectOk(
          sdk.client.session.queueUpdate({
            sessionID: props.sessionID,
            pendingMessageID: current.id,
            status: "queued",
          }),
        )
      },
      "Resume queue item failed",
      reopenItem,
    )
  }

  const promote = async () => {
    const current = item()
    if (!current) {
      reopenList()
      return
    }
    await mutate(
      async () => {
        if (current.status !== "queued") {
          await expectOk(
            sdk.client.session.queueUpdate({
              sessionID: props.sessionID,
              pendingMessageID: current.id,
              status: "queued",
            }),
          )
        }
        await expectOk(
          sdk.client.session.queuePromote({
            sessionID: props.sessionID,
            pendingMessageID: current.id,
          }),
        )
      },
      "Send now failed",
    )
  }

  const remove = async () => {
    const current = item()
    if (!current) {
      reopenList()
      return
    }
    const confirmed = await DialogConfirm.show(
      dialog,
      "Delete queue item",
      "Remove this pending submission from the session queue?",
    )
    if (!confirmed) {
      reopenItem()
      return
    }
    await mutate(
      async () => {
        await expectOk(
          sdk.client.session.queueDelete({
            sessionID: props.sessionID,
            pendingMessageID: current.id,
          }),
        )
      },
      "Delete queue item failed",
    )
  }

  const reorder = async (direction: "up" | "down") => {
    const current = item()
    if (!current) {
      reopenList()
      return
    }
    const next = reorderPendingMessageIDs(pending(), current.id, direction)
    if (!next) {
      reopenItem()
      return
    }
    await mutate(
      async () => {
        await expectOk(
          sdk.client.session.queueReorder({
            sessionID: props.sessionID,
            pendingMessageIDs: next,
          }),
        )
      },
      "Reorder queue failed",
      reopenItem,
    )
  }

  const index = createMemo(() => pending().findIndex((entry) => entry.id === props.pendingMessageID))

  const options = createMemo((): DialogSelectOption<string>[] => {
    const current = item()
    if (!current) {
      return [
        {
          title: "Queue item no longer exists",
          value: "missing",
          description: "This pending submission was removed or consumed.",
          onSelect: () => {
            reopenList()
          },
        },
      ]
    }

    const result: DialogSelectOption<string>[] = [
      {
        title: pendingMessagePreview(current),
        value: current.id,
        category: "Item",
        description: pendingMessageMeta(current),
        onSelect: () => {
          void inspect()
        },
      },
      {
        title: "Inspect details",
        value: "inspect",
        category: "Actions",
        description: "Show mode, status, metadata, and a prompt preview for this item.",
        onSelect: () => {
          void inspect()
        },
      },
    ]

    if (current.status === "blocked_after_interrupt") {
      result.push({
        title: "Resume item",
        value: "resume",
        category: "Actions",
        description: "Mark this blocked item as queued so it can run again later.",
        onSelect: () => {
          void resume()
        },
      })
    }

    if (current.status !== "running") {
      result.push({
        title: current.status === "blocked_after_interrupt" ? "Resume and send now" : "Send now",
        value: "promote",
        category: "Actions",
        description: "Move this item to the front of the queue and run it next.",
        onSelect: () => {
          void promote()
        },
      })
    }

    if (index() > 0 && current.status !== "running") {
      result.push({
        title: "Move up",
        value: "move-up",
        category: "Actions",
        description: "Swap this item with the one above it in queue order.",
        onSelect: () => {
          void reorder("up")
        },
      })
    }

    if (index() !== -1 && index() < pending().length - 1 && current.status !== "running") {
      result.push({
        title: "Move down",
        value: "move-down",
        category: "Actions",
        description: "Swap this item with the one below it in queue order.",
        onSelect: () => {
          void reorder("down")
        },
      })
    }

    if (current.status !== "running") {
      result.push({
        title: "Delete item",
        value: "delete",
        category: "Actions",
        description: "Remove this pending submission from the queue.",
        onSelect: () => {
          void remove()
        },
      })
    }

    result.push({
      title: "Back to queue",
      value: "back",
      category: "Navigation",
      description: "Return to the full session queue list.",
      onSelect: () => {
        reopenList()
      },
    })

    return result
  })

  return <DialogSelect title="Queue item" options={options()} />
}
