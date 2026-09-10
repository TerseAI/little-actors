import { ActorSerializationError } from "../errors.js"
import { cloneJsonObject } from "../json.js"
import type { JsonObject } from "../json.js"

function snapshotActorState(instance: object): JsonObject {
    const state = Object.fromEntries(Object.keys(instance).map(key => [key, Reflect.get(instance, key)]))
    return cloneJsonObject(state, "actor state")
}

function hydrateActorState(instance: object, state: JsonObject): void {
    const restored = cloneJsonObject(state, "actor state")
    Object.keys(instance).forEach(key => {
        if (!Reflect.deleteProperty(instance, key))
            throw new ActorSerializationError(`actor field ${key} cannot be restored`)
    })
    Object.entries(restored).forEach(([key, value]) => {
        Object.defineProperty(instance, key, { configurable: true, enumerable: true, writable: true, value })
    })
}

export { hydrateActorState, snapshotActorState }
