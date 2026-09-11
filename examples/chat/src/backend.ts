import express from "express"
import session from "express-session"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"

import { ActorProxy } from "../generated/proxy.js"

const app = express()
app.use(express.json({ limit: "4kb" }))
app.use(
    session({
        secret: process.env.SESSION_SECRET ?? randomUUID(),
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: "lax" }
    })
)

app.get("/api/session", (request, response) => {
    response.set("cache-control", "no-store").json({ name: request.session.name ?? null })
})

app.post("/api/session", (request, response) => {
    const name = request.body.name
    if (typeof name !== "string" || !name.trim()) return response.sendStatus(400)
    request.session.name = name.trim()
    response.json({ name: request.session.name })
})

app.post("/api/rooms/lobby/socket", async (request, response) => {
    if (!request.session.name) return response.sendStatus(401)
    const socketRequest = new Request("http://localhost/api/rooms/lobby/socket", {
        method: "POST",
        body: JSON.stringify(request.body)
    })
    const result = await ActorProxy.handle(socketRequest, { actorType: "ChatRoom", actorId: "lobby", metadata: { name: request.session.name } }, await actorSettings())
    response
        .status(result.status)
        .set(Object.fromEntries(result.headers))
        .send(await result.text())
})

if (process.argv.includes("--built")) {
    app.use(express.static("dist"))
} else {
    const { createServer } = await import("vite")
    const vite = await createServer({
        server: { middlewareMode: true, fs: { deny: [".env", ".env.*", "**/.little-actors/**", "**/.git/**"] } }
    })
    app.use(vite.middlewares)
}

const server = app.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => {
    const address = server.address()
    if (address && typeof address === "object") console.log(`Chat demo: http://127.0.0.1:${address.port}`)
})

async function actorSettings() {
    if (process.env.DURABLE_OBJECT_CONTROL_PLANE_URL || process.env.DURABLE_OBJECT_API_KEY) return {}
    const settings = JSON.parse(await readFile(process.env.ACTOR_RUNTIME_FILE ?? ".little-actors/runtime.json", "utf8"))
    return { controlPlaneUrl: settings.controlPlaneUrl, apiKey: settings.apiKey, namespaceId: settings.namespaceId }
}

declare module "express-session" {
    interface SessionData {
        name: string
    }
}
