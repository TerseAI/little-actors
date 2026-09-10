import assert from "node:assert/strict"
import { test } from "node:test"

import { ActorDefinitionError, ActorSerializationError } from "./errors.js"
import { Ephemeral, Persisted } from "./persistence.js"
import { cloneJson, hydrateActorState, snapshotActorState } from "./types.js"

test("actor state requires an explicit persistence annotation", () => {
    assert.throws(
        () => snapshotActorState({ count: 1 }),
        error => error instanceof ActorDefinitionError && error.message.includes("count") && error.message.includes("@Persisted or @Ephemeral")
    )
})

test("JSON clones preserve serialized values without sharing nested state", () => {
    const value = { nested: { count: 1 }, omitted: undefined, values: [undefined, NaN], date: new Date("2026-01-01T00:00:00Z") }
    const cloned = cloneJson(value, "test value")
    value.nested.count = 2
    assert.deepEqual(cloned, { nested: { count: 1 }, values: [null, null], date: "2026-01-01T00:00:00.000Z" })
})

test("JSON clones reject unsupported roots and cycles with a labeled error", () => {
    const circular = { self: {} }
    circular.self = circular
    for (const value of [undefined, () => {}, Symbol("value"), 1n, circular]) {
        assert.throws(
            () => cloneJson(value, "actor result"),
            error => error instanceof ActorSerializationError && error.message.includes("actor result")
        )
    }
})

test("hydration restores persisted fields without replacing ephemeral values or the actor prototype", () => {
    class Counter {
        @Persisted obsolete = true
        @Persisted nested = { count: 0 };
        @Persisted ["__proto__"]: unknown = null
        @Ephemeral cache = new Map([["live", 1]])
        increment() {
            return 1
        }
    }
    const instance = new Counter()
    const cache = instance.cache
    const state = JSON.parse('{"nested":{"count":1},"__proto__":{"polluted":true},"cache":"stale","retired":42}')
    hydrateActorState(instance, state)
    state.nested.count = 2
    assert.equal(Object.getPrototypeOf(instance), Counter.prototype)
    assert.equal(instance.increment(), 1)
    assert.equal(Object.hasOwn(instance, "obsolete"), false)
    assert.equal(Object.hasOwn(instance, "retired"), false)
    assert.equal(instance.cache, cache)
    assert.deepEqual(snapshotActorState(instance), JSON.parse('{"nested":{"count":1},"__proto__":{"polluted":true}}'))
})

test("snapshots omit ephemeral resources and detach nested persisted values", () => {
    class State {
        @Persisted values = { count: 0, enabled: false, label: null }
        @Ephemeral resource = { close() {} }
        @Ephemeral circular: unknown = this
    }
    const instance = new State()
    const snapshot = snapshotActorState(instance)
    instance.values.count = 1
    assert.deepEqual(snapshot, { values: { count: 0, enabled: false, label: null } })
})

test("decorated private fields survive restoration without becoming public properties", () => {
    class State {
        @Persisted #count = 1
        @Ephemeral #cache = new Map([["live", true]])

        read() {
            return { count: this.#count, cached: this.#cache.get("live") }
        }
    }
    const instance = new State()
    hydrateActorState(instance, { "#count": 7, "#cache": "stale" })
    assert.deepEqual(instance.read(), { count: 7, cached: true })
    assert.deepEqual(snapshotActorState(instance), { "#count": 7 })
    assert.deepEqual(Object.keys(instance), [])
})

test("absent persisted fields remain absent when an actor is restored", () => {
    class State {
        @Persisted added?: number = 5
        @Persisted #hidden?: number = 6
        @Ephemeral cache = "ready"

        readHidden() {
            return this.#hidden
        }
    }
    const instance = new State()
    hydrateActorState(instance, {})
    assert.equal(instance.added, undefined)
    assert.equal(instance.readHidden(), undefined)
    assert.equal(instance.cache, "ready")
    assert.deepEqual(snapshotActorState(instance), {})
})

test("state fields cannot declare two persistence lifetimes", () => {
    class Conflicting {
        @Persisted @Ephemeral count = 1
    }
    class Repeated {
        @Persisted @Persisted count = 1
    }
    for (const State of [Conflicting, Repeated]) {
        assert.throws(() => new State(), /exactly one @Persisted or @Ephemeral/u)
    }
})

test("persistence annotations reject static fields", () => {
    assert.throws(() => {
        class State {
            @Persisted static count = 1
        }
        return State
    }, /instance state fields/u)
})
