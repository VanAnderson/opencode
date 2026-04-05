import type { Message, Part, PendingMessage, Session, Todo } from "@opencode-ai/sdk/v2"
import { Binary } from "@opencode-ai/util/binary"
import { produce, reconcile } from "solid-js/store"
import type { Snapshot } from "@/snapshot"

export type SessionMessageItem = {
  info: Message
  parts: Part[]
}

export type TuiSessionSyncState = {
  session: Session[]
  session_diff: {
    [sessionID: string]: Snapshot.FileDiff[] | undefined
  }
  queue: {
    [sessionID: string]: PendingMessage[] | undefined
  }
  todo: {
    [sessionID: string]: Todo[] | undefined
  }
  message: {
    [sessionID: string]: Message[] | undefined
  }
  part: {
    [messageID: string]: Part[] | undefined
  }
}

export function applyQueueUpdated(input: {
  setStore: (...args: unknown[]) => unknown
  sessionID: string
  pending: PendingMessage[]
}) {
  input.setStore("queue", input.sessionID, reconcile(input.pending, { key: "id" }))
}

export function applySessionHydration(input: {
  setStore: (...args: unknown[]) => unknown
  sessionID: string
  session: Session
  messages: SessionMessageItem[]
  todo: Todo[]
  diff: Snapshot.FileDiff[]
  queue: PendingMessage[]
}) {
  input.setStore(
    produce((draft: TuiSessionSyncState) => {
      const match = Binary.search(draft.session, input.sessionID, (session) => session.id)
      if (match.found) draft.session[match.index] = input.session
      if (!match.found) draft.session.splice(match.index, 0, input.session)
      draft.todo[input.sessionID] = input.todo
      draft.queue[input.sessionID] = input.queue
      draft.message[input.sessionID] = input.messages.map((message) => message.info)
      for (const message of input.messages) {
        draft.part[message.info.id] = message.parts
      }
      draft.session_diff[input.sessionID] = input.diff
    }),
  )
}
