import { ActorProtocolError } from "./errors.js"
import { cloneJson } from "./types.js"
import type { JsonValue, SocketConnection, SocketEffect, SocketMessage } from "./types.js"

type ActorSocketState = "connecting" | "open" | "closed"
type ActorSocketMessage = string | Uint8Array

interface ActorSocket<Metadata = JsonValue> {
    readonly id: string
    metadata: Metadata
    readonly tags: readonly string[]
    readonly state: ActorSocketState
    send(message: ActorSocketMessage): void
    close(code?: number, reason?: string): void
    reject(code?: number, reason?: string): void
    setTags(...tags: string[]): void
}

interface ActorBroadcastOptions {
    readonly exclude?: ActorSocket<unknown> | readonly ActorSocket<unknown>[]
    readonly tags?: readonly string[]
}

interface ActorConnection {
    readonly readyState: number
    send(data: string | ArrayBufferLike | ArrayBufferView): void
    close(code?: number, reason?: string): void
    addEventListener<Type extends keyof ActorConnectionEventMap>(type: Type, listener: (event: ActorConnectionEventMap[Type]) => void): void
    removeEventListener<Type extends keyof ActorConnectionEventMap>(type: Type, listener: (event: ActorConnectionEventMap[Type]) => void): void
}

interface ActorConnectionEventMap {
    readonly open: { readonly type: "open" }
    readonly message: { readonly type: "message"; readonly data: string | Uint8Array | ArrayBuffer }
    readonly close: { readonly type: "close"; readonly code: number; readonly reason: string; readonly wasClean: boolean }
    readonly error: { readonly type: "error" }
}

const scopes = new WeakMap<object, ActorSocketScope>()

class ActorSocketScope {
    readonly sockets: readonly RuntimeActorSocket[]
    private readonly byId: ReadonlyMap<string, RuntimeActorSocket>

    constructor(
        connections: readonly SocketConnection[],
        readonly effects: Pick<SocketEffect[], "push">
    ) {
        const sockets = connections.map(connection => new RuntimeActorSocket(connection, effects))
        this.sockets = sockets
        this.byId = new Map(sockets.map(socket => [socket.id, socket]))
    }

    eventSocket(connection: SocketConnection, state: ActorSocketState): RuntimeActorSocket {
        const socket = this.byId.get(connection.id)
        if (socket !== undefined) {
            socket.setState(state)
            return socket
        }
        return new RuntimeActorSocket(connection, this.effects, state)
    }

    connection(connectionId: string): RuntimeActorSocket {
        const socket = this.byId.get(connectionId)
        if (socket === undefined) throw new ActorProtocolError(`socket connection ${connectionId} is not attached to the actor`)
        return socket
    }

    broadcast(message: ActorSocketMessage, options: ActorBroadcastOptions = {}): void {
        this.effects.push({
            type: "broadcast",
            message: socketMessage(message),
            exclude_connection_ids: excludedSocketIds(options.exclude),
            tags: options.tags?.map(validateTag) ?? []
        })
    }
}

class RuntimeActorSocket<Metadata = JsonValue> implements ActorSocket<Metadata> {
    private metadataValue: Metadata
    private tagsValue: readonly string[]

    constructor(
        connection: SocketConnection,
        private readonly effects: Pick<SocketEffect[], "push">,
        private stateValue: ActorSocketState = "open"
    ) {
        this.id = connection.id
        this.metadataValue = connection.metadata as Metadata
        this.tagsValue = connection.tags
    }

    readonly id: string

    get state(): ActorSocketState {
        return this.stateValue
    }

    get metadata(): Metadata {
        return this.metadataValue
    }

    set metadata(value: Metadata) {
        const metadata = cloneJson(value, "socket metadata")
        this.metadataValue = metadata as Metadata
        this.effects.push({ type: "set_metadata", connection_id: this.id, metadata })
    }

    get tags(): readonly string[] {
        return this.tagsValue
    }

    send(message: ActorSocketMessage): void {
        if (this.stateValue === "closed") throw new ActorProtocolError("cannot send on a closed actor socket")
        this.effects.push({ type: "send", connection_id: this.id, message: socketMessage(message) })
    }

    close(code = 1000, reason = ""): void {
        validateClose(code, reason)
        if (this.stateValue === "closed") return
        this.stateValue = "closed"
        this.effects.push({ type: "close", connection_id: this.id, code, reason })
    }

    reject(code = 1008, reason = "connection rejected"): void {
        if (this.stateValue !== "connecting") throw new ActorProtocolError("only a connecting actor socket can be rejected")
        validateClose(code, reason)
        this.stateValue = "closed"
        this.effects.push({ type: "reject", connection_id: this.id, code, reason })
    }

    setTags(...tags: string[]): void {
        const unique = [...new Set(tags.map(validateTag))]
        if (unique.length > 128 || unique.reduce((bytes, tag) => bytes + Buffer.byteLength(tag), 0) > 8 * 1024) {
            throw new ActorProtocolError("socket tags must not exceed 128 entries or 8 KiB")
        }
        this.tagsValue = unique
        this.effects.push({ type: "set_tags", connection_id: this.id, tags: unique })
    }

    setState(state: ActorSocketState): void {
        this.stateValue = state
    }
}

async function runWithActorSockets<T>(
    instance: object,
    connections: readonly SocketConnection[],
    operation: (scope: ActorSocketScope) => Promise<T>,
    publish?: (effects: readonly SocketEffect[]) => Promise<void>
): Promise<{ readonly value: T; readonly effects: readonly SocketEffect[] }> {
    const effects: SocketEffect[] = []
    const output = publish === undefined ? undefined : new SocketOutput(publish)
    const scope = new ActorSocketScope(connections, output ?? effects)
    scopes.set(instance, scope)
    try {
        return { value: await operation(scope), effects }
    } finally {
        scopes.delete(instance)
        await output?.flush()
    }
}

class SocketOutput {
    private pending: Promise<void> | undefined
    private queued: SocketEffect[] = []
    private queuedBytes = 0
    private failure: unknown

    constructor(private readonly publish: (effects: readonly SocketEffect[]) => Promise<void>) {}

    push(...effects: SocketEffect[]): number {
        if (this.failure !== undefined) throw this.failure
        const bytes = Buffer.byteLength(JSON.stringify(effects))
        if (this.queued.length + effects.length > 512 || this.queuedBytes + bytes > 24 * 1024 * 1024) throw new ActorProtocolError("actor socket output queue is full")
        this.queued.push(...effects)
        this.queuedBytes += bytes
        this.pending ??= this.drain()
        void this.pending.catch(() => undefined)
        return this.queued.length
    }

    async flush(): Promise<void> {
        await this.pending
        if (this.failure !== undefined) throw this.failure
    }

    private async drain(): Promise<void> {
        try {
            while (this.queued.length > 0) {
                const batch = this.queued
                this.queued = []
                this.queuedBytes = 0
                await this.publish(batch)
            }
        } catch (error) {
            this.failure = error
            throw error
        } finally {
            this.pending = undefined
        }
    }
}

function actorConnections(instance: object): readonly ActorSocket[] {
    return socketScope(instance).sockets
}

function broadcastActor(instance: object, message: ActorSocketMessage, options?: ActorBroadcastOptions): void {
    socketScope(instance).broadcast(message, options)
}

function socketScope(instance: object): ActorSocketScope {
    const scope = scopes.get(instance)
    if (scope === undefined) throw new ActorProtocolError("actor connections are available only during an actor invocation")
    return scope
}

function socketMessage(message: ActorSocketMessage): SocketMessage {
    if (typeof message === "string") return { type: "text", data: message }
    if (!(message instanceof Uint8Array)) throw new ActorProtocolError("socket messages must be strings or Uint8Arrays")
    return { type: "binary", data: Buffer.from(message).toString("base64") }
}

function decodeSocketMessage(message: SocketMessage): ActorSocketMessage {
    return message.type === "text" ? message.data : new Uint8Array(Buffer.from(message.data, "base64"))
}

function validateTag(tag: string): string {
    if (typeof tag !== "string" || tag.length === 0 || tag.length > 256) throw new ActorProtocolError("socket tags must contain between 1 and 256 characters")
    return tag
}

function validateClose(code: number, reason: string): void {
    if (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999))) throw new ActorProtocolError("socket close codes must be 1000 or between 3000 and 4999")
    if (Buffer.byteLength(reason) > 123) throw new ActorProtocolError("socket close reasons must not exceed 123 UTF-8 bytes")
}

function excludedSocketIds(exclude: ActorBroadcastOptions["exclude"]): readonly string[] {
    if (exclude === undefined) return []
    return Array.isArray(exclude) ? exclude.map(socket => socket.id) : [(exclude as ActorSocket<unknown>).id]
}

export { actorConnections, broadcastActor, decodeSocketMessage, runWithActorSockets, socketMessage }
export type { ActorBroadcastOptions, ActorConnection, ActorSocket, ActorSocketMessage, ActorSocketState }
