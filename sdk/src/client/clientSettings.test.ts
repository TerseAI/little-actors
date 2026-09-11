import assert from "node:assert/strict"
import { test } from "node:test"

import type { ActorConnection } from "../actor/socket.js"

import { RemoteActorClient } from "./remoteClient.js"
import type { DurableObjectsClientOptions } from "./remoteClient.js"

const options = { token: " token ", namespaceId: "project-1", controlPlaneUrl: "https://CONTROL.example.com:443/" }

test("environment and explicit client settings normalize routes, tokens, and gateway defaults equally", async () => {
    for (const socketGatewayUrl of [undefined, "http://SOCKET.example.com:80/"]) {
        const settings = { ...options, socketGatewayUrl }
        const connections: unknown[] = []
        const dependencies = {
            environment: environmentFor(settings),
            async connectWebSocket(url: string, token: string, metadata: unknown) {
                connections.push({ url, token, metadata })
                return {} as ActorConnection
            }
        }
        await new RemoteActorClient(settings, dependencies).connect("Counter", "one", {})
        await new RemoteActorClient(undefined, dependencies).connect("Counter", "one", {})
        const expected = {
            url: `${socketGatewayUrl ? "ws://socket.example.com" : "wss://control.example.com"}/v1/namespaces/project-1/actors/Counter/one/websocket`,
            token: "token",
            metadata: {}
        }
        assert.deepEqual(connections, [expected, expected])
        if (socketGatewayUrl === undefined) {
            await new RemoteActorClient(undefined, {
                ...dependencies,
                environment: {},
                readLocalSettings: () => ({
                    apiKey: "token",
                    namespaceId: "project-1",
                    controlPlaneUrl: options.controlPlaneUrl
                })
            }).connect("Counter", "one", {})
            assert.deepEqual(connections, [expected, expected, expected])
        }
    }
})

test("environment and explicit client settings report the same validation errors", async () => {
    for (const invalid of [
        { token: " " },
        { namespaceId: "bad/namespace" },
        { controlPlaneUrl: "invalid" },
        { socketGatewayUrl: "https://socket.example.com/path" }
    ]) {
        const settings = { ...options, ...invalid }
        let expected: Error | undefined
        assert.throws(
            () => new RemoteActorClient(settings),
            error => {
                assert.ok(error instanceof Error)
                expected = error
                return true
            }
        )
        assert.ok(expected instanceof Error)
        const client = new RemoteActorClient(undefined, { environment: environmentFor(settings) })
        await assert.rejects(client.connect("Counter", "one", {}), { name: expected.name, message: expected.message })
    }
})

function environmentFor(settings: DurableObjectsClientOptions): NodeJS.ProcessEnv {
    return {
        DURABLE_OBJECT_TOKEN: settings.token,
        DURABLE_OBJECT_NAMESPACE_ID: settings.namespaceId,
        DURABLE_OBJECT_CONTROL_PLANE_URL: settings.controlPlaneUrl,
        DURABLE_OBJECT_SOCKET_GATEWAY_URL: settings.socketGatewayUrl
    }
}
