import assert from "node:assert/strict"
import { test } from "node:test"

import { ActorSerializationError } from "../errors.js"

import { hydrateActorState, snapshotActorState } from "./state.js"

test("snapshots save enumerable fields and detach nested state", () => {
    const hidden = Symbol("hidden")
    class State {
        private count = 1
        values = { enabled: false, label: null }
        #cache = new Map([["live", true]]);
        [hidden] = "symbol"

        cached() {
            return this.#cache.get("live")
        }
    }
    const instance = new State()
    Object.defineProperty(instance, "resource", { value: instance })
    const snapshot = snapshotActorState(instance)
    instance.values.enabled = true
    assert.deepEqual(snapshot, { count: 1, values: { enabled: false, label: null } })
    assert.equal(instance.cached(), true)
})

test("hydration replaces initialized fields without changing the prototype or private resources", () => {
    class Counter {
        added = true
        nested = { count: 0 }
        #cache = new Map([["live", 1]])

        cached() {
            return this.#cache.get("live")
        }
    }
    const instance = new Counter()
    const resource = {}
    Object.defineProperty(instance, "resource", { value: resource })
    const state = JSON.parse('{"nested":{"count":1},"__proto__":{"polluted":true},"retired":42}')
    hydrateActorState(instance, state)
    state.nested.count = 2
    assert.equal(Object.getPrototypeOf(instance), Counter.prototype)
    assert.equal(instance.cached(), 1)
    assert.equal(Object.hasOwn(instance, "added"), false)
    assert.equal(Reflect.get(instance, "resource"), resource)
    assert.deepEqual(
        snapshotActorState(instance),
        JSON.parse('{"nested":{"count":1},"__proto__":{"polluted":true},"retired":42}')
    )
})

test("restoring empty state does not merge newly initialized fields", () => {
    const instance = { added: 5 }
    hydrateActorState(instance, {})
    assert.deepEqual(snapshotActorState(instance), {})
    assert.equal(Object.hasOwn(instance, "added"), false)
})

test("hydration rejects fields that cannot be replaced", () => {
    const instance = Object.defineProperty({}, "count", { enumerable: true, value: 1 })
    assert.throws(() => hydrateActorState(instance, { count: 2 }), ActorSerializationError)
})
