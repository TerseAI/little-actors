import type { SocketContract } from "../wire/contract.js"

enum Persistence {
    Persisted = "persisted",
    Ephemeral = "ephemeral"
}

interface ActorFieldSchema {
    readonly name: string
    readonly persistence: Persistence
    readonly private?: boolean
    readonly visibility?: "private" | "protected"
    readonly emittable?: boolean
}

interface ActorSchema {
    readonly actorType: string
    readonly fields: readonly ActorFieldSchema[]
    readonly contract?: SocketContract
}

export { Persistence }
export type { ActorFieldSchema, ActorSchema }
