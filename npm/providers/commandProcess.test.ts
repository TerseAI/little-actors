import assert from "node:assert/strict"
import { PassThrough, Readable } from "node:stream"
import { test } from "node:test"

import { runProviderCommand } from "./commandProcess.js"
import type { SandboxProvider } from "./types.js"

test("a provider invocation accepts one request and returns one result", async () => {
    let loads = 0
    const response = await invoke(JSON.stringify({ operation: "warm_image", request: {} }), async () => {
        loads += 1
        return {
            async warmImage() {
                return { provider: "modal", resourceId: "sb-1", totalMs: 0 }
            }
        } as unknown as SandboxProvider
    })
    assert.equal(loads, 1)
    assert.deepEqual(response, { status: "success", result: { provider: "modal", resourceId: "sb-1", totalMs: 0 } })
})

test("multiple commands are rejected before loading the SDK", async () => {
    let loads = 0
    const response = await invoke((JSON.stringify({ operation: "warm_image", request: {} }) + "\n").repeat(2), async () => {
        loads += 1
        return {
            async warmImage() {
                return {}
            }
        } as unknown as SandboxProvider
    })
    assert.equal(loads, 0)
    assert.equal(response.status, "failure")
})

test("provider failures produce a failure envelope", async () => {
    const response = await invoke(JSON.stringify({ operation: "warm_image", request: {} }), async () => {
        return {
            async warmImage() {
                throw new Error("test failure")
            }
        } as unknown as SandboxProvider
    })
    assert.deepEqual(response, { status: "failure", error: "test failure" })
})

test("provider command input is bounded before loading the SDK", async () => {
    await assert.rejects(
        invoke("x".repeat(1024 * 1024 + 1), async () => {
            throw new Error("must not load")
        }),
        /command exceeds/
    )
})

test("provider response output is bounded", async () => {
    await assert.rejects(
        invoke(JSON.stringify({ operation: "warm_image", request: {} }), async () => {
            return {
                async warmImage() {
                    return "x".repeat(1024 * 1024)
                }
            } as unknown as SandboxProvider
        }),
        /response is too large/
    )
})

async function invoke(document: string, createProvider: () => Promise<SandboxProvider>): Promise<{ status: string }> {
    const output = new PassThrough()
    let response = ""
    output.on("data", chunk => {
        response += String(chunk)
    })
    await runProviderCommand(Readable.from([document]), output, createProvider)
    return JSON.parse(response)
}
