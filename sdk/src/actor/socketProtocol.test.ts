import assert from "node:assert/strict"
import { test } from "node:test"

import { ActorProtocolError } from "../errors.js"

import { parseSocketEffects } from "./socketProtocol.js"

test("rejects malformed socket effects", () => {
    assert.throws(
        () => parseSocketEffects([{ type: "close", connection_id: "socket-1", code: 1001, reason: "" }]),
        ActorProtocolError
    )
    assert.throws(
        () => parseSocketEffects({ type: "set_tags", connection_id: "socket-1", tags: [] }),
        ActorProtocolError
    )
})
