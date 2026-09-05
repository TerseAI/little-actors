import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"

import { actorClient, runWithActorClient } from "./client.js"
import type { ActorClientTransport } from "./client.js"

test("injected clients stay isolated across concurrent scopes and restore the default", async () => {
    const original = actorClient()
    const clients: ActorClientTransport[] = ["first", "second"].map(result => ({
        async invoke() {
            return result
        },
        async connect() {
            throw new Error("unused connection")
        },
        async broadcast() {}
    }))
    const results = await Promise.all(
        clients.map(client =>
            runWithActorClient(client, async () => {
                await setImmediate()
                assert.equal(actorClient(), client)
                return actorClient().invoke("Counter", "one", "increment", [])
            })
        )
    )
    assert.deepEqual(results, ["first", "second"])
    assert.equal(actorClient(), original)
})
