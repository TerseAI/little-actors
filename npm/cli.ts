#!/usr/bin/env node
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import { DevOptions, LocalCli } from "./local/commands.js"
import { RuntimeInstaller } from "./local/runtime.js"

try {
    await new LocalCli({
        dev: async options => {
            process.exitCode = await runRuntime(devArguments(options))
        },
        run: async (script, args, options) => {
            process.exitCode = await runClient(script, args, options.dataDir)
        },
        token: async options => {
            const { token } = await localSession(options.dataDir)
            console.log(token)
        },
        start: async () => {
            process.exitCode = await runRuntime([])
        }
    })
        .program(await version())
        .parseAsync(process.argv)
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
}

function devArguments(options: DevOptions): string[] {
    const args = ["dev", "--project", options.project, "--port", String(options.port), "--entrypoint", options.entrypoint, "--storage", options.storage]
    if (options.dataDir) args.push("--data-dir", options.dataDir)
    return args
}

async function runRuntime(args: string[]): Promise<number> {
    const executable = process.env.LAC_BINARY
        ? path.resolve(process.env.LAC_BINARY)
        : await new RuntimeInstaller({
              version: await version(),
              platform: process.platform,
              arch: process.arch,
              cacheDirectory: process.env.LAC_CACHE_DIR ?? path.join(homedir(), ".cache/little-actors")
          }).install()
    return runProcess(
        executable,
        args,
        {
            ...process.env,
            PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`,
            LAC_PROCESS_ROLE: process.env.LAC_PROCESS_ROLE ?? "control_plane",
            LAC_PARENT_LIFETIME_STDIN: "1"
        },
        true
    )
}

async function runClient(script: string, args: string[], directory: string): Promise<number> {
    const { connection, token } = await localSession(directory)
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        LAC_TOKEN: token,
        LAC_NAMESPACE_ID: connection.namespaceId,
        LAC_CONTROL_PLANE_URL: connection.controlPlaneUrl
    }
    delete environment.LAC_API_KEY
    delete environment.LAC_SOCKET_GATEWAY_URL
    return runProcess(process.execPath, ["--import", import.meta.resolve("tsx"), script, ...args], environment)
}

async function localSession(directory: string) {
    const connection = await readFile(path.resolve(directory, "runtime.json"), "utf8")
        .then(JSON.parse)
        .catch(() => {
            throw new Error("No local runtime found. Start `npx lac dev` in this project first; use the same --data-dir for both commands.")
        })
    const response = await fetch(`${connection.controlPlaneUrl}/v1/namespaces/${connection.namespaceId}/session-scoped-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ executionId: `local-${randomUUID()}`, deadlineUnixMs: Date.now() + 3_600_000, storageRegion: connection.storageRegion }),
        signal: AbortSignal.timeout(10_000)
    }).catch(() => {
        throw new Error("Cannot reach the local runtime. Start `npx lac dev` again.")
    })
    if (!response.ok) throw new Error(`Local runtime could not issue a client token (HTTP ${response.status}). Restart it and try again.`)
    const { token } = (await response.json()) as { token: string }
    return { connection, token }
}

async function version(): Promise<string> {
    return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, parentLifetime = false): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env, stdio: [parentLifetime ? "pipe" : "inherit", "inherit", "inherit"] })
        const interrupt = () => child.kill("SIGINT")
        const terminate = () => child.kill("SIGTERM")
        const parentClosed = () => child.stdin?.end()
        process.on("SIGINT", interrupt)
        process.on("SIGTERM", terminate)
        if (parentLifetime && process.env.LAC_PARENT_LIFETIME_STDIN) {
            process.stdin.resume()
            process.stdin.on("end", parentClosed)
        }
        const cleanup = () => {
            process.off("SIGINT", interrupt)
            process.off("SIGTERM", terminate)
            process.stdin.off("end", parentClosed)
            if (parentLifetime) process.stdin.pause()
        }
        child.once("error", error => {
            cleanup()
            reject(error)
        })
        child.once("exit", (code, signal) => {
            cleanup()
            resolve(code ?? (signal === "SIGINT" ? 130 : 1))
        })
    })
}
