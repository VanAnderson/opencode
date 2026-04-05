import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"
import { Database, NotFoundError, and, asc, desc, eq } from "../storage/db"
import { Effect, Layer, ServiceMap } from "effect"
import z from "zod"

import * as SessionPromptInput from "./prompt-input"
import { PendingMessageID, SessionID } from "./schema"
import { PendingMessageTable } from "./session.sql"

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

  export const PendingMessagePromptPayload = SessionPromptInput.PromptInput.omit({
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

  export const PendingMessageCommandPayload = SessionPromptInput.CommandInput.omit({
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

  export const Event = {
    Updated: BusEvent.define(
      "session.queue.updated",
      z.object({
        sessionID: SessionID.zod,
        pending: z.array(PendingMessage),
      }),
    ),
  }

  export const EnqueueInput = z.object({
    sessionID: SessionID.zod,
    mode: PendingMessageMode,
    payload: PendingMessagePayload,
    source: z.string().optional(),
    createdAgainstExecutionID: z.string().optional(),
    supersedesExecutionID: z.string().optional(),
    error: PendingMessageError.optional(),
  })
  export type EnqueueInput = z.infer<typeof EnqueueInput>

  export const UpdateInput = z.object({
    sessionID: SessionID.zod,
    pendingMessageID: PendingMessageID.zod,
    mode: PendingMessageMode.optional(),
    status: PendingMessageStatus.optional(),
    payload: PendingMessagePayload.optional(),
    source: z.string().nullable().optional(),
    createdAgainstExecutionID: z.string().nullable().optional(),
    supersedesExecutionID: z.string().nullable().optional(),
    error: PendingMessageError.nullable().optional(),
  })
  export type UpdateInput = z.infer<typeof UpdateInput>

  export const RemoveInput = z.object({
    sessionID: SessionID.zod,
    pendingMessageID: PendingMessageID.zod,
  })
  export type RemoveInput = z.infer<typeof RemoveInput>

  export const ReorderInput = z.object({
    sessionID: SessionID.zod,
    pendingMessageIDs: z.array(PendingMessageID.zod),
  })
  export type ReorderInput = z.infer<typeof ReorderInput>

  export const PromoteInput = z.object({
    sessionID: SessionID.zod,
    pendingMessageID: PendingMessageID.zod,
  })
  export type PromoteInput = z.infer<typeof PromoteInput>

  export const MarkBlockedAfterInterruptInput = z.object({
    sessionID: SessionID.zod,
    createdAgainstExecutionID: z.string().optional(),
    excludePendingMessageIDs: z.array(PendingMessageID.zod).optional().default([]),
  })
  export type MarkBlockedAfterInterruptInput = z.infer<typeof MarkBlockedAfterInterruptInput>

  export const CompleteInput = z.object({
    sessionID: SessionID.zod,
    pendingMessageID: PendingMessageID.zod,
  })
  export type CompleteInput = z.infer<typeof CompleteInput>

  export const FailInput = z.object({
    sessionID: SessionID.zod,
    pendingMessageID: PendingMessageID.zod,
    error: PendingMessageError,
  })
  export type FailInput = z.infer<typeof FailInput>

  export interface Interface {
    readonly list: (sessionID: SessionID) => Effect.Effect<PendingMessage[]>
    readonly get: (input: RemoveInput) => Effect.Effect<PendingMessage>
    readonly enqueue: (input: EnqueueInput) => Effect.Effect<PendingMessage>
    readonly update: (input: UpdateInput) => Effect.Effect<PendingMessage>
    readonly remove: (input: RemoveInput) => Effect.Effect<void>
    readonly clear: (sessionID: SessionID) => Effect.Effect<void>
    readonly reorder: (input: ReorderInput) => Effect.Effect<PendingMessage[]>
    readonly promote: (input: PromoteInput) => Effect.Effect<PendingMessage>
    readonly markBlockedAfterInterrupt: (input: MarkBlockedAfterInterruptInput) => Effect.Effect<PendingMessage[]>
    readonly claimHead: (sessionID: SessionID) => Effect.Effect<PendingMessage | undefined>
    readonly complete: (input: CompleteInput) => Effect.Effect<void>
    readonly fail: (input: FailInput) => Effect.Effect<PendingMessage>
    readonly consumeHead: (sessionID: SessionID) => Effect.Effect<PendingMessage | undefined>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionQueue") {}

  type Row = typeof PendingMessageTable.$inferSelect

  function fromRow(row: Row): PendingMessage {
    return {
      id: row.id,
      sessionID: row.session_id,
      position: row.position,
      mode: row.mode,
      status: row.status,
      payload: row.payload,
      source: row.source ?? undefined,
      createdAgainstExecutionID: row.created_against_execution_id ?? undefined,
      supersedesExecutionID: row.supersedes_execution_id ?? undefined,
      error: row.error ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function listRows(db: Database.TxOrDb, sessionID: SessionID) {
    return db
      .select()
      .from(PendingMessageTable)
      .where(eq(PendingMessageTable.session_id, sessionID))
      .orderBy(asc(PendingMessageTable.position), asc(PendingMessageTable.time_created), asc(PendingMessageTable.id))
      .all()
  }

  function getRow(db: Database.TxOrDb, input: RemoveInput) {
    const row = db
      .select()
      .from(PendingMessageTable)
      .where(
        and(
          eq(PendingMessageTable.session_id, input.sessionID),
          eq(PendingMessageTable.id, input.pendingMessageID),
        ),
      )
      .get()
    if (!row) throw new NotFoundError({ message: `Pending message not found: ${input.pendingMessageID}` })
    return row
  }

  function normalizePositions(db: Database.TxOrDb, sessionID: SessionID, timeUpdated: number) {
    const rows = listRows(db, sessionID)
    rows.forEach((row, index) => {
      if (row.position === index) return
      db.update(PendingMessageTable)
        .set({
          position: index,
          time_updated: timeUpdated,
        })
        .where(eq(PendingMessageTable.id, row.id))
        .run()
    })
  }

  function reorderRows(db: Database.TxOrDb, input: ReorderInput, timeUpdated: number) {
    const rows = listRows(db, input.sessionID)
    if (rows.length !== input.pendingMessageIDs.length) {
      throw new Error("Reorder input must include every pending message in the session queue")
    }
    if (new Set(input.pendingMessageIDs).size !== input.pendingMessageIDs.length) {
      throw new Error("Reorder input cannot contain duplicate pending message IDs")
    }

    const byID = new Map(rows.map((row) => [row.id, row]))
    for (const id of input.pendingMessageIDs) {
      if (byID.has(id)) continue
      throw new NotFoundError({ message: `Pending message not found: ${id}` })
    }
    for (const row of rows) {
      if (input.pendingMessageIDs.includes(row.id)) continue
      throw new Error("Reorder input must include every pending message in the session queue")
    }

    input.pendingMessageIDs.forEach((id, position) => {
      db.update(PendingMessageTable)
        .set({
          position,
          time_updated: timeUpdated,
        })
        .where(
          and(eq(PendingMessageTable.session_id, input.sessionID), eq(PendingMessageTable.id, id)),
        )
        .run()
    })
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service

      const publishUpdated = Effect.fn("SessionQueue.publishUpdated")(function* (sessionID: SessionID) {
        const pending = yield* list(sessionID)
        yield* bus.publish(Event.Updated, {
          sessionID,
          pending,
        })
      })

      const list = Effect.fn("SessionQueue.list")(function* (sessionID: SessionID) {
        const rows = yield* Effect.sync(() => Database.use((db) => listRows(db, sessionID)))
        return rows.map(fromRow)
      })

      const get = Effect.fn("SessionQueue.get")(function* (input: RemoveInput) {
        const row = yield* Effect.sync(() => Database.use((db) => getRow(db, input)))
        return fromRow(row)
      })

      const enqueue = Effect.fn("SessionQueue.enqueue")(function* (input: EnqueueInput) {
        const now = Date.now()
        const item = yield* Effect.sync(() =>
          Database.transaction((db) => {
            const last = db
              .select({ position: PendingMessageTable.position })
              .from(PendingMessageTable)
              .where(eq(PendingMessageTable.session_id, input.sessionID))
              .orderBy(desc(PendingMessageTable.position), desc(PendingMessageTable.id))
              .limit(1)
              .get()
            const row: Row = {
              id: PendingMessageID.ascending(),
              session_id: input.sessionID,
              position: last ? last.position + 1 : 0,
              mode: input.mode,
              status: "queued",
              payload: input.payload,
              source: input.source ?? null,
              created_against_execution_id: input.createdAgainstExecutionID ?? null,
              supersedes_execution_id: input.supersedesExecutionID ?? null,
              error: input.error ?? null,
              time_created: now,
              time_updated: now,
            }
            db.insert(PendingMessageTable).values(row).run()
            return row
          }),
        )
        const pending = fromRow(item)
        yield* publishUpdated(input.sessionID)
        return pending
      })

      const update = Effect.fn("SessionQueue.update")(function* (input: UpdateInput) {
        const pending = yield* Effect.sync(() =>
          Database.transaction((db) => {
            getRow(db, input)

            const patch: Partial<typeof PendingMessageTable.$inferInsert> = {
              time_updated: Date.now(),
            }
            if (input.mode !== undefined) patch.mode = input.mode
            if (input.status !== undefined) patch.status = input.status
            if (input.payload !== undefined) patch.payload = input.payload
            if (input.source !== undefined) patch.source = input.source
            if (input.createdAgainstExecutionID !== undefined)
              patch.created_against_execution_id = input.createdAgainstExecutionID
            if (input.supersedesExecutionID !== undefined)
              patch.supersedes_execution_id = input.supersedesExecutionID
            if (input.error !== undefined) patch.error = input.error

            db.update(PendingMessageTable)
              .set(patch)
              .where(
                and(
                  eq(PendingMessageTable.session_id, input.sessionID),
                  eq(PendingMessageTable.id, input.pendingMessageID),
                ),
              )
              .run()

            return getRow(db, input)
          }),
        ).pipe(Effect.map(fromRow))
        yield* publishUpdated(input.sessionID)
        return pending
      })

      const remove = Effect.fn("SessionQueue.remove")(function* (input: RemoveInput) {
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            getRow(db, input)
            db.delete(PendingMessageTable)
              .where(
                and(
                  eq(PendingMessageTable.session_id, input.sessionID),
                  eq(PendingMessageTable.id, input.pendingMessageID),
                ),
              )
              .run()
            normalizePositions(db, input.sessionID, Date.now())
          }),
        )
        yield* publishUpdated(input.sessionID)
      })

      const clear = Effect.fn("SessionQueue.clear")(function* (sessionID: SessionID) {
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            db.delete(PendingMessageTable).where(eq(PendingMessageTable.session_id, sessionID)).run()
          }),
        )
        yield* publishUpdated(sessionID)
      })

      const reorder = Effect.fn("SessionQueue.reorder")(function* (input: ReorderInput) {
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            reorderRows(db, input, Date.now())
          }),
        )
        yield* publishUpdated(input.sessionID)
        return yield* list(input.sessionID)
      })

      const promote = Effect.fn("SessionQueue.promote")(function* (input: PromoteInput) {
        const pending = yield* Effect.sync(() =>
          Database.transaction((db) => {
            const rows = listRows(db, input.sessionID)
            const target = rows.find((row) => row.id === input.pendingMessageID)
            if (!target) throw new NotFoundError({ message: `Pending message not found: ${input.pendingMessageID}` })

            const reordered = [target.id, ...rows.filter((row) => row.id !== target.id).map((row) => row.id)]
            reorderRows(
              db,
              {
                sessionID: input.sessionID,
                pendingMessageIDs: reordered,
              },
              Date.now(),
            )
            return getRow(db, input)
          }),
        ).pipe(Effect.map(fromRow))
        yield* publishUpdated(input.sessionID)
        return pending
      })

      const markBlockedAfterInterrupt = Effect.fn("SessionQueue.markBlockedAfterInterrupt")(function* (
        input: MarkBlockedAfterInterruptInput,
      ) {
        const pending = yield* Effect.sync(() =>
          Database.transaction((db) => {
            const blockedIDs = new Set<string>()
            const excluded = new Set(input.excludePendingMessageIDs)
            const now = Date.now()

            for (const row of listRows(db, input.sessionID)) {
              if (excluded.has(row.id)) continue
              if (input.createdAgainstExecutionID && row.created_against_execution_id !== input.createdAgainstExecutionID)
                continue
              if (!["queued", "running"].includes(row.status)) continue

              db.update(PendingMessageTable)
                .set({
                  status: "blocked_after_interrupt",
                  time_updated: now,
                })
                .where(
                  and(
                    eq(PendingMessageTable.session_id, input.sessionID),
                    eq(PendingMessageTable.id, row.id),
                  ),
                )
                .run()
              blockedIDs.add(row.id)
            }

            if (blockedIDs.size === 0) return [] as PendingMessage[]
            return listRows(db, input.sessionID)
              .filter((row) => blockedIDs.has(row.id))
              .map(fromRow)
          }),
        )
        if (pending.length > 0) yield* publishUpdated(input.sessionID)
        return pending
      })

      const claimHead = Effect.fn("SessionQueue.claimHead")(function* (sessionID: SessionID) {
        const pending = yield* Effect.sync(() =>
          Database.transaction((db) => {
            const head = listRows(db, sessionID)[0]
            if (!head) return undefined
            if (head.status !== "queued") return undefined

            db.update(PendingMessageTable)
              .set({
                status: "running",
                time_updated: Date.now(),
              })
              .where(eq(PendingMessageTable.id, head.id))
              .run()

            return fromRow(getRow(db, { sessionID, pendingMessageID: head.id }))
          }),
        )
        if (pending) yield* publishUpdated(sessionID)
        return pending
      })

      const complete = Effect.fn("SessionQueue.complete")(function* (input: CompleteInput) {
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            getRow(db, input)
            db.delete(PendingMessageTable)
              .where(
                and(
                  eq(PendingMessageTable.session_id, input.sessionID),
                  eq(PendingMessageTable.id, input.pendingMessageID),
                ),
              )
              .run()
            normalizePositions(db, input.sessionID, Date.now())
          }),
        )
        yield* publishUpdated(input.sessionID)
      })

      const fail = Effect.fn("SessionQueue.fail")(function* (input: FailInput) {
        const pending = yield* Effect.sync(() =>
          Database.transaction((db) => {
            getRow(db, input)
            db.update(PendingMessageTable)
              .set({
                status: "failed",
                error: input.error,
                time_updated: Date.now(),
              })
              .where(
                and(
                  eq(PendingMessageTable.session_id, input.sessionID),
                  eq(PendingMessageTable.id, input.pendingMessageID),
                ),
              )
              .run()
            return fromRow(getRow(db, input))
          }),
        )
        yield* publishUpdated(input.sessionID)
        return pending
      })

      const consumeHead = Effect.fn("SessionQueue.consumeHead")(function* (sessionID: SessionID) {
        const pending = yield* Effect.sync(() =>
          Database.transaction((db) => {
            const head = listRows(db, sessionID)[0]
            if (!head) return undefined
            if (head.status !== "queued") return undefined

            db.delete(PendingMessageTable).where(eq(PendingMessageTable.id, head.id)).run()
            normalizePositions(db, sessionID, Date.now())
            return fromRow(head)
          }),
        )
        if (pending) yield* publishUpdated(sessionID)
        return pending
      })

      return Service.of({
        list,
        get,
        enqueue,
        update,
        remove,
        clear,
        reorder,
        promote,
        markBlockedAfterInterrupt,
        claimHead,
        complete,
        fail,
        consumeHead,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export const list = fn(SessionID.zod, (sessionID) => runPromise((svc) => svc.list(sessionID)))
  export const get = fn(RemoveInput, (input) => runPromise((svc) => svc.get(input)))
  export const enqueue = fn(EnqueueInput, (input) => runPromise((svc) => svc.enqueue(input)))
  export const update = fn(UpdateInput, (input) => runPromise((svc) => svc.update(input)))
  export const remove = fn(RemoveInput, (input) => runPromise((svc) => svc.remove(input)))
  export const clear = fn(SessionID.zod, (sessionID) => runPromise((svc) => svc.clear(sessionID)))
  export const reorder = fn(ReorderInput, (input) => runPromise((svc) => svc.reorder(input)))
  export const promote = fn(PromoteInput, (input) => runPromise((svc) => svc.promote(input)))
  export const markBlockedAfterInterrupt = fn(MarkBlockedAfterInterruptInput, (input) =>
    runPromise((svc) => svc.markBlockedAfterInterrupt(input)),
  )
  export const claimHead = fn(SessionID.zod, (sessionID) => runPromise((svc) => svc.claimHead(sessionID)))
  export const complete = fn(CompleteInput, (input) => runPromise((svc) => svc.complete(input)))
  export const fail = fn(FailInput, (input) => runPromise((svc) => svc.fail(input)))
  export const consumeHead = fn(SessionID.zod, (sessionID) => runPromise((svc) => svc.consumeHead(sessionID)))
}

export type PendingMessageMode = SessionQueue.PendingMessageMode
export type PendingMessageStatus = SessionQueue.PendingMessageStatus
export type PendingMessagePayload = SessionQueue.PendingMessagePayload
export type PendingMessageError = SessionQueue.PendingMessageError
export type PendingMessage = SessionQueue.PendingMessage
