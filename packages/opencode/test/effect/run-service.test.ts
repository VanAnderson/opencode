import { afterEach, expect, test } from "bun:test"
import { Deferred, Effect, Layer, ServiceMap } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { makeRuntime } from "../../src/effect/run-service"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

class Shared extends ServiceMap.Service<Shared, { readonly id: number }>()("@test/Shared") {}

test("makeRuntime shares dependent layers through the shared memo map", async () => {
  let n = 0

  const shared = Layer.effect(
    Shared,
    Effect.sync(() => {
      n += 1
      return Shared.of({ id: n })
    }),
  )

  class One extends ServiceMap.Service<One, { readonly get: () => Effect.Effect<number> }>()("@test/One") {}
  const one = Layer.effect(
    One,
    Effect.gen(function* () {
      const svc = yield* Shared
      return One.of({
        get: Effect.fn("One.get")(() => Effect.succeed(svc.id)),
      })
    }),
  ).pipe(Layer.provide(shared))

  class Two extends ServiceMap.Service<Two, { readonly get: () => Effect.Effect<number> }>()("@test/Two") {}
  const two = Layer.effect(
    Two,
    Effect.gen(function* () {
      const svc = yield* Shared
      return Two.of({
        get: Effect.fn("Two.get")(() => Effect.succeed(svc.id)),
      })
    }),
  ).pipe(Layer.provide(shared))

  const { runPromise: runOne } = makeRuntime(One, one)
  const { runPromise: runTwo } = makeRuntime(Two, two)

  expect(await runOne((svc) => svc.get())).toBe(1)
  expect(await runTwo((svc) => svc.get())).toBe(1)
  expect(n).toBe(1)
})

test("makeRuntime reuses InstanceRef when nested runPromise resumes outside ALS", async () => {
  await using tmp = await tmpdir({ git: true })

  interface Api {
    readonly getDirectory: () => Effect.Effect<string>
  }

  class Test extends ServiceMap.Service<Test, Api>()("@test/RunServiceInstanceRef") {
    static readonly layer = Layer.succeed(
      Test,
      Test.of({
        getDirectory: () =>
          Effect.gen(function* () {
            return yield* InstanceState.directory
          }),
      }),
    )
  }

  const runtime = makeRuntime(Test, Test.layer)
  const gate = await Effect.runPromise(Deferred.make<void>())

  const task = Instance.provide({
    directory: tmp.path,
    fn: async () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Deferred.await(gate)
          return yield* Effect.promise(() => runtime.runPromise((svc) => svc.getDirectory()))
        }).pipe(Effect.provideService(InstanceRef, Instance.current)),
      ),
  })

  await Effect.runPromise(Deferred.succeed(gate, void 0))
  expect(await task).toBe(tmp.path)
})
