import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const root = fileURLToPath(new URL("../", import.meta.url))
const execute = promisify(execFile)
const binary = process.env.DURABLE_OBJECT_TEST_BINARY

test("run supplies the local API key without issuing a session or inheriting an explicit scope", async t => {
    const project = await mkdtemp(path.join(tmpdir(), "ldo-run-auth-"))
    t.after(() => rm(project, { recursive: true, force: true }))
    let requests = 0
    const server = createServer((_request, response) => {
        requests++
        response.writeHead(401).end()
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const controlPlaneUrl = `http://127.0.0.1:${server.address().port}`
    await mkdir(path.join(project, ".little-actors"))
    await writeFile(path.join(project, ".little-actors/runtime.json"), JSON.stringify({ apiKey: "local-test-key", namespaceId: "local", controlPlaneUrl }))
    await writeFile(
        path.join(project, "client.mjs"),
        `import assert from "node:assert/strict"
assert.equal(process.env.DURABLE_OBJECT_API_KEY, "local-test-key")
assert.equal(process.env.DURABLE_OBJECT_CONTROL_PLANE_URL, ${JSON.stringify(controlPlaneUrl)})
assert.equal(process.env.DURABLE_OBJECT_TOKEN, undefined)
assert.equal(process.env.DURABLE_OBJECT_NAMESPACE_ID, undefined)
assert.equal(process.env.DURABLE_OBJECT_SOCKET_GATEWAY_URL, undefined)
`
    )
    await execute(process.execPath, [path.join(root, "sdk/dist/cli.js"), "run", "client.mjs"], {
        cwd: project,
        env: {
            ...process.env,
            DURABLE_OBJECT_API_KEY: "inherited-key",
            DURABLE_OBJECT_TOKEN: "inherited-token",
            DURABLE_OBJECT_NAMESPACE_ID: "other-project",
            DURABLE_OBJECT_SOCKET_GATEWAY_URL: "https://other.example.com"
        },
        timeout: 10_000
    })
    assert.equal(requests, 0)
})

test("the local CLI runs actors and restores acknowledged state after shutdown", { skip: !binary, timeout: 120_000 }, async t => {
    const project = await mkdtemp(path.join(tmpdir(), "ldo-local-"))
    t.after(() => rm(project, { recursive: true, force: true }))
    await prepareProject(project)
    const cli = path.join(project, "node_modules/little-actors/dist/cli.js")
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DURABLE_OBJECT_|MODAL_|GOOGLE_)/u.test(key)))
    env.DURABLE_OBJECT_BINARY = path.resolve(binary)
    env.DURABLE_OBJECT_PARENT_LIFETIME_STDIN = "1"
    const client = () => execute(process.execPath, [cli, "run", "src/client.ts"], { cwd: project, env, timeout: 30_000 })
    for (const count of [1, 2]) {
        const server = spawn(process.execPath, [cli, "dev", "--port", "0"], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] })
        t.after(() => {
            if (server.exitCode === null) server.stdin.end()
        })
        const exited = once(server, "exit")
        let output = ""
        server.stdout.on("data", data => {
            output += data
        })
        server.stderr.on("data", data => {
            output += data
        })
        try {
            await waitUntilReady(server, () => output)
            const token = await execute(process.execPath, [cli, "token"], { cwd: project, env, timeout: 10_000 })
            assert.equal(token.stdout.trim().split(".").length, 3)
            assert.equal((await client()).stdout.trim(), String(count))
        } catch (error) {
            throw new Error([error.message, error.stdout, error.stderr, output].filter(Boolean).join("\n"), { cause: error })
        } finally {
            server.stdin.end()
            const timer = setTimeout(() => server.kill("SIGKILL"), 15_000)
            try {
                const [code] = await exited
                assert.equal(code, 0, output)
            } finally {
                clearTimeout(timer)
            }
        }
    }
})

async function prepareProject(project) {
    await writeFile(path.join(project, "package.json"), JSON.stringify({ private: true, type: "module" }))
    if (process.env.DURABLE_OBJECT_TEST_PACKAGE) {
        await execute("npm", ["install", "--no-audit", "--no-fund", path.resolve(process.env.DURABLE_OBJECT_TEST_PACKAGE)], { cwd: project, timeout: 60_000 })
    } else {
        await mkdir(path.join(project, "node_modules"))
        await symlink(path.join(root, "sdk"), path.join(project, "node_modules/little-actors"), "dir")
    }
    await mkdir(path.join(project, "src"))
    await writeFile(
        path.join(project, "src/durable-objects.ts"),
        `import { Actor, Persisted } from "little-actors"
export class Counter extends Actor {
    @Persisted count = 0
    async increment() { return ++this.count }
    async clients() { return this.connections.map(socket => ({ id: socket.id, metadata: socket.metadata })) }
    async notifyClient(id: string) { this.connections.find(socket => socket.id === id)!.send({ text: "from method" }) }
}
`
    )
    await writeFile(
        path.join(project, "src/client.ts"),
        `import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"
import { Counter } from "./durable-objects.js"
const room = Counter.get("tutorial")
assert.deepEqual(await room.clients(), [])
const socket = await room.connect({ user: "test" })
try {
    let clients = await room.clients()
    const deadline = Date.now() + 5000
    while (clients.length === 0 && Date.now() < deadline) {
        await setTimeout(10)
        clients = await room.clients()
    }
    assert.equal(clients.length, 1)
    assert.deepEqual(clients[0].metadata, { user: "test" })
    const message = new Promise(resolve => socket.addEventListener("message", event => {
        if (event.data.text === "from method") resolve(event.data)
    }))
    await room.notifyClient(clients[0].id)
    assert.deepEqual(await message, { text: "from method" })
    console.log(await room.increment())
} finally {
    socket.close()
}
`
    )
}

async function waitUntilReady(server, output) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (output().includes("Local actors ready at")) return
        assert.equal(server.exitCode, null, output())
        await delay(50)
    }
    assert.fail(`Runtime did not become ready: ${output()}`)
}
