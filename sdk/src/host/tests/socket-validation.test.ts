import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"

import { Actor, registerActorClass } from "../../actor/actor.js"
import type { ActorMessageOf, ActorSocketOf } from "../../actor/actor.js"
import type { SocketConnection } from "../../actor/socketProtocol.js"
import { ActorRuntime } from "../actor-runtime.js"
import type { WebSocketEventCommand } from "../protocol.js"

const metadata = z.object({ userId: z.string().min(1) })
const incoming = z.object({ type: z.literal("post"), text: z.string().min(1) })
const outgoing = z.object({ type: z.literal("posted"), text: z.string(), userId: z.string() })
const tag = z.enum(["member", "moderator"])
const calls: string[] = []

class ValidatedRoom extends Actor<
    z.infer<typeof metadata>,
    z.infer<typeof incoming>,
    z.infer<typeof outgoing>,
    z.infer<typeof tag>
> {
    static schemas = { metadata, incoming, outgoing, tag }

    async onConnect(): Promise<void> {
        calls.push("connect")
    }

    async onMessage(socket: ActorSocketOf<ValidatedRoom>, message: ActorMessageOf<ValidatedRoom>): Promise<void> {
        calls.push("message")
        socket.send({ type: "posted", text: message.text, userId: socket.metadata.userId })
    }

    async invalidOutput(): Promise<void> {
        this.broadcast({ type: "posted", text: 123, userId: "one" } as never)
    }

    async invalidMetadata(): Promise<void> {
        this.connections[0]!.metadata = { userId: 123 } as never
    }

    async invalidTags(): Promise<void> {
        this.connections[0]!.setTags("admin" as never)
    }

    async invalidFilter(): Promise<void> {
        this.broadcast({ type: "posted", text: "hello", userId: "one" }, { tags: ["admin" as never] })
    }

    async joinMembers(): Promise<readonly string[]> {
        const socket = this.connections[0]!
        socket.setTags("member", "member")
        this.broadcast({ type: "posted", text: "joined", userId: socket.metadata.userId }, { tags: ["member"] })
        return socket.tags
    }
}

const definition = registerActorClass(ValidatedRoom)
const actor = { namespace_id: "project", actor_type: "ValidatedRoom", actor_id: "one" }
const connection: SocketConnection = { id: "socket-1", metadata: { userId: "one" }, tags: [] }

test("connection metadata is validated before actor hooks run", async () => {
    calls.length = 0
    const runtime = new ActorRuntime(definition)
    const invalid = { ...connection, metadata: { userId: 123 } }
    const reply = await runtime.handle(event({ type: "connect", connection: invalid }, [invalid]))
    assert.equal(reply.type, "failed")
    assert.deepEqual(calls, [])
    assert.equal((await runtime.handle(event({ type: "connect", connection }))).type, "websocket_handled")
    assert.deepEqual(calls, ["connect"])
})

test("incoming JSON is validated before onMessage and outgoing values are encoded automatically", async () => {
    calls.length = 0
    const runtime = new ActorRuntime(definition)
    const message = (value: unknown) =>
        event({ type: "message", connection_id: connection.id, message: { type: "text", data: JSON.stringify(value) } })
    assert.equal((await runtime.handle(message({ type: "post", text: 123 }))).type, "failed")
    assert.deepEqual(calls, [])
    const reply = await runtime.handle(message({ type: "post", text: "hello" }))
    assert.deepEqual(reply, {
        type: "websocket_handled",
        state: {},
        effects: [
            {
                type: "send",
                connection_id: "socket-1",
                message: { type: "text", data: '{"type":"posted","text":"hello","userId":"one"}' }
            }
        ]
    })
    assert.deepEqual(calls, ["message"])
})

test("invalid actor output, metadata, and tags cannot reach the gateway", async () => {
    const published: unknown[] = []
    const runtime = new ActorRuntime(definition, async effects => {
        published.push(...effects)
    })
    for (const method of ["invalidOutput", "invalidMetadata", "invalidTags", "invalidFilter"]) {
        const reply = await runtime.handle({
            type: "invoke",
            request_id: method,
            actor,
            method,
            args: [],
            state: null,
            connections: [connection]
        })
        assert.equal(reply.type, "failed")
    }
    assert.deepEqual(published, [])
})

test("schema-validated tags persist and select broadcast recipients", async () => {
    const runtime = new ActorRuntime(definition)
    const reply = await runtime.handle({
        type: "invoke",
        request_id: "join",
        actor,
        method: "joinMembers",
        args: [],
        state: null,
        connections: [connection]
    })
    assert.equal(reply.type, "invoked")
    if (reply.type !== "invoked") return
    assert.deepEqual(reply.result, ["member"])
    assert.deepEqual(reply.effects, [
        { type: "set_tags", connection_id: connection.id, tags: ["member"] },
        {
            type: "broadcast",
            message: { type: "text", data: '{"type":"posted","text":"joined","userId":"one"}' },
            except_connection_ids: [],
            tags: ["member"]
        }
    ])
})

test("restored connection tags are validated before a hibernated actor resumes", async () => {
    calls.length = 0
    const invalid = { ...connection, tags: ["admin"] }
    const runtime = new ActorRuntime(definition)
    const reply = await runtime.handle(
        event(
            {
                type: "message",
                connection_id: invalid.id,
                message: { type: "text", data: '{"type":"post","text":"hello"}' }
            },
            [invalid]
        )
    )
    assert.equal(reply.type, "failed")
    assert.deepEqual(calls, [])
})

function event(value: WebSocketEventCommand["event"], connections = [connection]): WebSocketEventCommand {
    return { type: "websocket_event", request_id: "event", actor, event: value, connections, state: null }
}
