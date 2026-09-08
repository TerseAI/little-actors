import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const root = fileURLToPath(new URL("../", import.meta.url))
const execute = promisify(execFile)
const binary = process.env.DURABLE_OBJECT_TEST_BINARY

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
        await symlink(path.join(root, "npm"), path.join(project, "node_modules/little-actors"), "dir")
    }
    await mkdir(path.join(project, "src"))
    await writeFile(
        path.join(project, "src/durable-objects.ts"),
        `import { Actor } from "little-actors"
export class Counter extends Actor {
    count = 0
    async increment() { return ++this.count }
}
`
    )
    await writeFile(
        path.join(project, "src/client.ts"),
        `import { Counter } from "./durable-objects.js"
console.log(await Counter.get("tutorial").increment())
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
