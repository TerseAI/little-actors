import assert from "node:assert/strict"
import { test } from "node:test"

import { SocketProxy } from "./proxy.js"

const actors = { Room: { metadata: (_value: unknown) => true } }

test("proxy issues socket authorization using only server-selected target and metadata", async () => {
    const requests: { url: string; headers: Headers; body: unknown }[] = []
    const proxy = new SocketProxy(
        actors,
        { controlPlaneUrl: "https://actors.example.com", apiKey: "backend-secret" },
        {
            fetch: async (url, init) => {
                requests.push({
                    url: String(url),
                    headers: new Headers(init?.headers),
                    body: JSON.parse(init!.body as string)
                })
                return Response.json({ websocketUrl: "wss://actors.example.com/v1/socket", key: "socket-ticket" })
            }
        }
    )
    const response = await proxy.handle(request({ actorType: "Room", actorId: "lobby", connectionId: "connection" }), {
        actorType: "Room",
        actorId: "lobby",
        metadata: { userId: "trusted" }
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.deepEqual(await response.json(), {
        websocketUrl: "wss://actors.example.com/v1/socket",
        key: "socket-ticket"
    })
    assert.equal(requests[0]!.headers.get("authorization"), "Bearer backend-secret")
    assert.equal(requests[0]!.url, "https://actors.example.com/v1/actors/Room/lobby/socket-ticket")
    assert.deepEqual(requests[0]!.body, {
        metadata: { userId: "trusted" },
        connectionId: "connection",
        authorizationLifetimeMs: 900000
    })
    const mismatch = await proxy.handle(request({ actorType: "Room", actorId: "other" }), {
        actorType: "Room",
        actorId: "lobby",
        metadata: {}
    })
    assert.equal(mismatch.status, 403)
    assert.equal(requests.length, 1)
})

test("proxy rejects client-supplied metadata and never falls back to a session credential", async () => {
    const proxy = new SocketProxy(
        actors,
        { controlPlaneUrl: "https://actors.example.com", apiKey: "secret" },
        {
            fetch: async () => assert.fail("invalid request reached issuance")
        }
    )
    const response = await proxy.handle(request({ actorType: "Room", actorId: "lobby", metadata: { role: "admin" } }), {
        actorType: "Room",
        actorId: "lobby",
        metadata: {}
    })
    assert.equal(response.status, 400)
    assert.throws(
        () => new SocketProxy(actors, { controlPlaneUrl: "https://actors.example.com", apiKey: "" }),
        /API key/
    )
})

function request(body: unknown): Request {
    return new Request("https://app.example.com/api/actors", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" }
    })
}
