import assert from "node:assert/strict"
import test from "node:test"

import { LocalCli } from "./commands.js"

test("token accepts the local runtime's state directory", async () => {
    let received: unknown
    const program = new LocalCli({
        dev: async () => {},
        run: async () => {},
        start: async () => {},
        token: async options => {
            received = options
        }
    }).program("1.2.3")
    await program.parseAsync(["token", "--data-dir", "./demo-state"], { from: "user" })
    assert.deepEqual(received, { dataDir: "./demo-state" })
})

test("dev has local defaults and validates options before starting a runtime", async () => {
    const calls: unknown[] = []
    const program = new LocalCli({
        dev: async options => {
            calls.push(options)
        },
        run: async () => {},
        token: async () => {},
        start: async () => {}
    }).program("1.2.3")
    for (const command of [program, ...program.commands]) command.exitOverride().configureOutput({ writeErr: () => {} })
    assert.equal(program.name(), "lac")
    assert.match(program.helpInformation(), /Usage: lac/)
    await program.parseAsync(["dev"], { from: "user" })
    assert.deepEqual(calls, [{ port: 7100, project: ".", entrypoint: "src/actors.ts", storage: "local" }])
    await assert.rejects(program.parseAsync(["dev", "--storage", "s3"], { from: "user" }), /Allowed choices/)
    await assert.rejects(program.parseAsync(["dev", "--port", "abc"], { from: "user" }), /port/i)
    assert.equal(calls.length, 1)
})

test("run forwards client flags unchanged and reads its own options before the script", async () => {
    let received: unknown
    const program = new LocalCli({
        dev: async () => {},
        start: async () => {},
        token: async () => {},
        run: async (...args) => {
            received = args
        }
    }).program("1.2.3")
    await program.parseAsync(["run", "--data-dir", "./custom-state", "src/client.ts", "--data-dir", "client-value", "--help"], { from: "user" })
    assert.deepEqual(received, ["src/client.ts", ["--data-dir", "client-value", "--help"], { dataDir: "./custom-state" }])
})

test("run reports missing scripts with command-specific help", async () => {
    const program = new LocalCli({
        dev: async () => {},
        start: async () => {},
        token: async () => {},
        run: async () => {
            assert.fail("must not run")
        }
    }).program("1.2.3")
    for (const command of [program, ...program.commands]) command.exitOverride().configureOutput({ writeErr: () => {} })
    await assert.rejects(program.parseAsync(["run"], { from: "user" }), /missing required argument 'script'/)
    const help = program.commands.find(command => command.name() === "dev")!.helpInformation()
    assert.match(help, /--storage/)
    assert.match(help, /SQLite/)
})
