import assert from "node:assert/strict"
import test from "node:test"

import { broadcastActor, runWithActorSockets } from "./socket.js"

test("broadcast excludes one socket, several sockets, or none", async () => {
    const actor = {}
    const connections = [
        { id: "alice", metadata: { userId: "alice" }, tags: [] },
        { id: "bob", metadata: { userId: "bob" }, tags: [] }
    ]
    const { effects } = await runWithActorSockets(actor, connections, async scope => {
        broadcastActor(actor, "one", { exclude: scope.sockets[0] })
        broadcastActor(actor, "several", { exclude: scope.sockets })
        broadcastActor(actor, "everyone")
    })

    assert.deepEqual(effects, [
        { type: "broadcast", message: { type: "text", data: "one" }, exclude_connection_ids: ["alice"], tags: [] },
        { type: "broadcast", message: { type: "text", data: "several" }, exclude_connection_ids: ["alice", "bob"], tags: [] },
        { type: "broadcast", message: { type: "text", data: "everyone" }, exclude_connection_ids: [], tags: [] }
    ])
})

test("connection metadata and tags can be updated independently", async () => {
    const actor = {}
    const connection = { id: "alice", metadata: { userId: "alice" }, tags: ["member"] }
    const { effects } = await runWithActorSockets(actor, [connection], async scope => {
        const socket = scope.sockets[0]!
        assert.deepEqual(socket.metadata, { userId: "alice" })
        assert.deepEqual(socket.tags, ["member"])
        socket.metadata = { userId: "alice", ready: true }
        socket.setTags("editor", "document-1", "editor")
        assert.deepEqual(socket.tags, ["editor", "document-1"])
        assert.deepEqual(socket.metadata, { userId: "alice", ready: true })
        socket.setTags()
        assert.deepEqual(socket.tags, [])
    })

    assert.deepEqual(effects, [
        { type: "set_metadata", connection_id: "alice", metadata: { userId: "alice", ready: true } },
        { type: "set_tags", connection_id: "alice", tags: ["editor", "document-1"] },
        { type: "set_tags", connection_id: "alice", tags: [] }
    ])
})

test("broadcast combines tags with excluded sockets", async () => {
    const actor = {}
    const connection = { id: "alice", metadata: {}, tags: ["editor", "document-1"] }
    const { effects } = await runWithActorSockets(actor, [connection], async scope => {
        broadcastActor(actor, "updated", { exclude: scope.sockets[0], tags: ["editor", "document-1"] })
    })

    assert.deepEqual(effects, [{ type: "broadcast", message: { type: "text", data: "updated" }, exclude_connection_ids: ["alice"], tags: ["editor", "document-1"] }])
})
