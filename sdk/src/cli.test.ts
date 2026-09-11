import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url))

test("init creates a complete chat app using the installed SDK version", async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "little-actors-init-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const { stdout } = await run(process.execPath, [cli, "init", "my chat"], { cwd: directory })
    const project = path.join(directory, "my chat")
    const metadata = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"))
    const sdk = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"))
    assert.equal(metadata.dependencies["little-actors"], sdk.version)
    assert.match(await readFile(path.join(project, "src/durable-objects.ts"), "utf8"), /extends Actor/)
    assert.match(await readFile(path.join(project, "src/backend.ts"), "utf8"), /ActorProxy.handle/)
    assert.match(await readFile(path.join(project, "src/Chat.tsx"), "utf8"), /ActorClient/)
    assert.match(await readFile(path.join(project, ".gitignore"), "utf8"), /\.little-actors\//)
    assert.match(stdout, /npm install/)
    assert.match(stdout, /little-actors generate/)
})

test("init refuses an existing directory and preserves its contents", async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "little-actors-init-existing-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const project = path.join(directory, "chat")
    await mkdir(project)
    const file = path.join(project, "package.json")
    await writeFile(file, "existing app")
    await assert.rejects(run(process.execPath, [cli, "init", project]), /already exists/)
    assert.equal(await readFile(file, "utf8"), "existing app")
})
