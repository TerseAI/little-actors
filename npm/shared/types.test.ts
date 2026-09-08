import assert from "node:assert/strict"
import { test } from "node:test"

import { ActorProtocolError } from "./errors.js"
import { parseActorSessionServerMessage, parseSocketEffects } from "./types.js"

test("rejects malformed actor session messages", () => {
    assert.throws(() => parseActorSessionServerMessage('{"type":"command","message_id":1,"command":{"type":"invoke","request_id":false}}'), ActorProtocolError)
})

test("accepts the broadcast exclusion protocol and rejects the older protocol", () => {
    const attached = { type: "attached", protocol: 15 }
    assert.deepEqual(parseActorSessionServerMessage(JSON.stringify(attached)), attached)
    assert.throws(() => parseActorSessionServerMessage(JSON.stringify({ type: "attached", protocol: 14 })), ActorProtocolError)
})

test("rejects malformed socket effects", () => {
    assert.throws(() => parseSocketEffects([{ type: "close", connection_id: "socket-1", code: 1001, reason: "" }]), ActorProtocolError)
    assert.throws(() => parseSocketEffects({ type: "set_metadata", connection_id: "socket-1", metadata: {} }), ActorProtocolError)
})

test("accepts broadcasts with exclusions and tags", () => {
    const effects = [{ type: "broadcast", message: { type: "text", data: "hello" }, exclude_connection_ids: ["socket-1"], tags: ["member"] }]
    assert.deepEqual(parseSocketEffects(effects), effects)
})

test("accepts tag effects and rejects invalid tags", () => {
    const effects = [{ type: "set_tags", connection_id: "socket-1", tags: ["member"] }]
    assert.deepEqual(parseSocketEffects(effects), effects)
    assert.throws(() => parseSocketEffects([{ type: "set_tags", connection_id: "socket-1", tags: [""] }]), ActorProtocolError)
})
