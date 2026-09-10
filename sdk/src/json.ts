import { z } from "zod"

import { ActorSerializationError } from "./errors.js"

type JsonPrimitive = string | number | boolean | null
type JsonObject = { readonly [key: string]: JsonValue }
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]

function cloneJsonObject(value: unknown, label: string): JsonObject {
    const cloned = cloneJson(value, label)
    if (!isJsonObject(cloned)) throw new ActorSerializationError(`${label} must be a JSON object`)
    return cloned
}

function cloneJson(value: unknown, label: string): JsonValue {
    try {
        const encoded = JSON.stringify(value)
        if (encoded === undefined) throw new ActorSerializationError(`${label} must be JSON serializable`)
        return JSON.parse(encoded) as JsonValue
    } catch (error) {
        if (error instanceof ActorSerializationError) throw error
        throw new ActorSerializationError(`${label} must be JSON serializable`, { cause: error })
    }
}

function isJsonObject(value: JsonValue): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(jsonValueSchema),
        z.record(z.string(), jsonValueSchema)
    ])
)

export { cloneJson, cloneJsonObject, isJsonObject, jsonValueSchema }
export type { JsonPrimitive, JsonObject, JsonValue }
