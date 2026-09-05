import assert from "node:assert/strict"
import { test } from "node:test"

import { ActorSerializationError } from "./errors.js"
import { cloneJson, hydrateActorState, snapshotActorState } from "./types.js"

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

test("hydration replaces fields without sharing state or changing the actor prototype", () => {
    class Counter {
        obsolete = true
        increment() {
            return 1
        }
    }
    const instance = new Counter()
    const state = JSON.parse('{"nested":{"count":1},"__proto__":{"polluted":true}}')
    hydrateActorState(instance, state)
    state.nested.count = 2
    assert.equal(Object.getPrototypeOf(instance), Counter.prototype)
    assert.equal(instance.increment(), 1)
    assert.equal(Object.hasOwn(instance, "obsolete"), false)
    assert.deepEqual(snapshotActorState(instance), JSON.parse('{"nested":{"count":1},"__proto__":{"polluted":true}}'))
})
