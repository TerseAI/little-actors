enum Persistence {
    Persisted = "persisted",
    Ephemeral = "ephemeral"
}

interface ActorFieldSchema {
    readonly name: string
    readonly persistence: Persistence
    readonly private?: boolean
}

interface ActorSchema {
    readonly actorType: string
    readonly fields: readonly ActorFieldSchema[]
}

export { Persistence }
export type { ActorFieldSchema, ActorSchema }
