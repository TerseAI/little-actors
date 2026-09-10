import { z } from "zod"

import { validateActorComponent } from "./actor/identity.js"
import { socketMetadata } from "./actor/socketValidation.js"
import { decodeGrant } from "./browser/protocol.js"

interface SocketProxyOptions {
    readonly controlPlaneUrl?: string
    readonly apiKey?: string
    readonly namespaceId?: string
}

interface SocketProxyDependencies {
    readonly fetch?: typeof globalThis.fetch
}

interface ProxyActor<Metadata = unknown> {
    readonly metadata: (value: unknown) => boolean
    readonly types?: Metadata
}

type SocketAuthorization<Actors extends Record<string, ProxyActor>> = {
    [Name in keyof Actors & string]: {
        readonly actorType: Name
        readonly actorId: string
        readonly metadata: Actors[Name] extends ProxyActor<infer Metadata> ? Metadata : never
        readonly authorizationLifetimeMs?: number
    }
}[keyof Actors & string]

const intentSchema = z
    .object({ actorType: z.string(), actorId: z.string(), connectionId: z.string().min(1).max(128).optional() })
    .strict()

class SocketProxy<Actors extends Record<string, ProxyActor>> {
    private readonly origin: string
    private readonly apiKey: string
    private readonly namespace: string | undefined
    private readonly fetchRequest: typeof globalThis.fetch

    constructor(
        private readonly actors: Actors,
        options: SocketProxyOptions = {},
        dependencies: SocketProxyDependencies = {}
    ) {
        const url = new URL(options.controlPlaneUrl ?? process.env.DURABLE_OBJECT_CONTROL_PLANE_URL ?? "")
        if (
            !["https:", "http:"].includes(url.protocol) ||
            url.pathname !== "/" ||
            url.search ||
            url.hash ||
            url.username ||
            url.password
        )
            throw new Error("Control-plane URL must be an HTTP(S) origin")
        this.origin = url.origin
        this.apiKey = options.apiKey ?? process.env.DURABLE_OBJECT_API_KEY ?? ""
        if (!this.apiKey || this.apiKey.trim() !== this.apiKey)
            throw new Error("A backend API key is required for socket authorization")
        this.namespace = options.namespaceId ?? process.env.DURABLE_OBJECT_NAMESPACE_ID
        if (this.namespace) validateActorComponent("namespace ID", this.namespace)
        this.fetchRequest = dependencies.fetch ?? globalThis.fetch
    }

    async handle(request: Request, authorization: SocketAuthorization<Actors>): Promise<Response> {
        if (request.method !== "POST") return responseError(405, "POST is required")
        let intent: z.infer<typeof intentSchema>
        try {
            const document = await readIntent(request)
            intent = intentSchema.parse(document)
        } catch {
            return responseError(400, "Invalid socket connection request")
        }
        if (intent.actorType !== authorization.actorType || intent.actorId !== authorization.actorId)
            return responseError(403, "Socket target was not authorized")
        const actorType = validateActorComponent("actor type", authorization.actorType)
        const actorId = validateActorComponent("actor ID", authorization.actorId)
        if (!Object.hasOwn(this.actors, actorType)) throw new Error(`Unknown actor type: ${actorType}`)
        const metadata = socketMetadata(authorization.metadata)
        if (!this.actors[actorType].metadata(metadata)) throw new Error(`Invalid socket metadata for ${actorType}`)
        const authorizationLifetimeMs = authorization.authorizationLifetimeMs ?? 900000
        if (
            !Number.isSafeInteger(authorizationLifetimeMs) ||
            authorizationLifetimeMs < 1000 ||
            authorizationLifetimeMs > 86400000
        )
            throw new Error("Socket authorization lifetime must be between one second and one day")
        const scope = this.namespace ? `/namespaces/${encodeURIComponent(this.namespace)}` : ""
        try {
            const response = await this.fetchRequest(
                `${this.origin}/v1${scope}/actors/${encodeURIComponent(actorType)}/${encodeURIComponent(actorId)}/socket-ticket`,
                {
                    method: "POST",
                    headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
                    body: JSON.stringify({
                        metadata,
                        ...(intent.connectionId ? { connectionId: intent.connectionId } : {}),
                        authorizationLifetimeMs
                    }),
                    signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)])
                }
            )
            if (!response.ok)
                return responseError(response.status >= 500 ? 503 : 502, "WebSocket authorization could not be issued")
            return Response.json(decodeGrant(await response.json()), { headers: { "cache-control": "no-store" } })
        } catch {
            return responseError(503, "WebSocket authorization is unavailable")
        }
    }
}

async function readIntent(request: Request): Promise<unknown> {
    if (!request.body) throw new Error("request body is missing")
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
        for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            length += value.byteLength
            if (length > 4096) {
                await reader.cancel()
                throw new Error("request is too large")
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function responseError(status: number, error: string): Response {
    return Response.json({ error }, { status, headers: { "cache-control": "no-store" } })
}

export { SocketProxy }
export type { ProxyActor, SocketAuthorization, SocketProxyDependencies, SocketProxyOptions }
