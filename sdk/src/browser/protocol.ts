import { z } from "zod"

import { SocketError } from "./types.js"

const MAX_FRAME_BYTES = 16 * 1024 * 1024
const json = z.json()
const object = z.record(z.string(), json)
const version = z.number().int().nonnegative().safe()
const lifetime = z.number().positive().finite().max(86_400_000)
const serverFrame = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("ready"),
        protocol: z.literal(1),
        connectionId: z.string().min(1),
        expiresInMs: lifetime
    }),
    z.object({ type: z.literal("renewed"), expiresInMs: lifetime }),
    z.object({ type: z.literal("message"), data: json }),
    z.object({ type: z.literal("state"), state: object, version }),
    z.object({ type: z.literal("state_update"), changes: object, removed: z.array(z.string()), version })
])
const grantSchema = z.object({
    websocketUrl: z.url().refine(url => ["ws:", "wss:"].includes(new URL(url).protocol)),
    key: z.string().min(1)
})

function decodeFrame(data: unknown): z.infer<typeof serverFrame> {
    if (typeof data !== "string" || new TextEncoder().encode(data).length > MAX_FRAME_BYTES)
        throw new SocketError("invalid_protocol", "Invalid WebSocket frame")
    try {
        return serverFrame.parse(JSON.parse(data))
    } catch {
        throw new SocketError("invalid_protocol", "Invalid WebSocket protocol data")
    }
}

function encodeFrame(value: unknown): string {
    try {
        json.parse(value)
        const encoded = JSON.stringify(value)
        if (new TextEncoder().encode(encoded).length > MAX_FRAME_BYTES) throw new Error("too large")
        return encoded
    } catch {
        throw new SocketError("invalid_message", "Invalid JSON message or message exceeds 16 MiB")
    }
}

function decodeGrant(value: unknown) {
    const result = grantSchema.safeParse(value)
    if (!result.success) throw new SocketError("invalid_authorization", "Invalid response from the socket proxy")
    return result.data
}

export { decodeFrame, decodeGrant, encodeFrame }
