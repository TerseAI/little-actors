#!/usr/bin/env node
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(scriptPath), "..")

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
    await main(process.argv.slice(2))
}

export function summarizeTimeline(timeline) {
    const socketConnecting = firstMark(timeline, "websocket_connecting")
    const actorSocketReady = firstMark(timeline, "actor_socket_ready")
    const promptSent = firstMark(timeline, "prompt_sent")
    const promptAccepted = firstMark(timeline, "prompt_accepted")
    const generationStarted = firstMark(timeline, "generation_started")
    const completed = firstMark(timeline, "generation_completed")
    const deltas = timeline.filter(mark => mark.name === "text_delta")
    const firstDelta = deltas.at(0)
    const lastDelta = deltas.at(-1)
    const gaps = deltas.slice(1).map((delta, index) => delta.atMs - deltas[index].atMs)

    return {
        socketToActorReadyMs: difference(actorSocketReady, socketConnecting),
        promptAcceptedMs: difference(promptAccepted, promptSent),
        promptToGenerationMs: difference(generationStarted, promptSent),
        timeToFirstTextMs: difference(firstDelta, promptSent),
        generationToFirstTextMs: difference(firstDelta, generationStarted),
        streamDurationMs: difference(completed, firstDelta),
        completionTailMs: difference(completed, lastDelta),
        textDeltaCount: deltas.length,
        textCharacters: sum(deltas.map(delta => delta.characters ?? 0)),
        invalidTextDeltaCount: deltas.filter(delta => delta.validDelta === false).length,
        interDeltaGapMs: descriptiveStats(gaps)
    }
}

export function summarizeGcpEntries(entries, expectedSocketEffects = 0) {
    const requests = entries.flatMap(entry => (entry.httpRequest ? [entry.httpRequest] : []))
    const socketEffects = requests.filter(request => request.requestUrl?.includes("/socket-effects"))
    const actorExecute = requests.filter(request => request.requestUrl?.includes("/durable_object.v1.ActorControlPlaneService/Execute"))

    return {
        socketEffects: {
            ...requestSummary(socketEffects),
            expectedMinimum: expectedSocketEffects,
            captureComplete: expectedSocketEffects > 0 ? socketEffects.length >= expectedSocketEffects : null
        },
        actorExecute: requestSummary(actorExecute),
        socketMessagesCommitted: entries.filter(entry => entry.jsonPayload?.event === "actor_socket_message_committed").length,
        targetResolutions: entries.filter(entry => entry.jsonPayload?.event === "actor_target_resolution").length,
        hostProvisions: entries.filter(entry => entry.jsonPayload?.event === "actor_host_provisioning").length
    }
}

export function summarizeModalLogs(logs) {
    const events = logs.split("\n").map(parseModalLine).filter(Boolean)
    const invocations = Object.groupBy(
        events.filter(event => event.event === "actor_host_invocation"),
        event => event.method ?? "unknown"
    )
    return {
        invocations: Object.fromEntries(Object.entries(invocations).map(([method, values]) => [method, timedEventSummary(values)])),
        stateWrites: timedEventSummary(events.filter(event => event.event === "actor_state_write")),
        hostStartups: timedEventSummary(events.filter(event => event.event === "actor_host_startup"))
    }
}

export function diagnoseBottleneck(timeline, gcp) {
    const socketP95 = gcp.socketEffects?.latencyMs?.p95 ?? 0
    const largestGap = timeline.interDeltaGapMs?.max ?? 0
    const startup = timeline.generationToFirstTextMs ?? 0
    const ingress = timeline.promptToGenerationMs ?? 0
    const tail = timeline.completionTailMs ?? 0

    if ((timeline.invalidTextDeltaCount ?? 0) > 0) {
        return diagnosis(
            "invalid_delta_protocol",
            `${timeline.invalidTextDeltaCount} text_delta events carried a non-string delta. The Multiplayer SDK rejects those events, so clients receive the final response without the intermediate stream.`
        )
    }
    if (socketP95 >= 100 && socketP95 >= largestGap / 2) {
        return diagnosis("socket_gateway_effects", `GCP socket-effect requests reached ${formatMs(socketP95)} p95, making the gateway path the strongest measured constraint.`)
    }
    if (startup >= 1_000 && startup >= Math.max(ingress, largestGap, tail) * 2) {
        return diagnosis("workflow_or_model_start", `${formatMs(startup)} elapsed between generation_started and the first text delta; actor ingress and steady-state delivery were materially faster.`)
    }
    if (largestGap >= 250 && socketP95 < largestGap / 4) {
        return diagnosis(
            "workflow_or_model_chunking",
            `The largest client-visible delta gap was ${formatMs(largestGap)}, while GCP socket effects were only ${formatMs(socketP95)} p95. The stall is upstream of the socket gateway.`
        )
    }
    if (ingress >= 500 && ingress >= Math.max(startup, largestGap, tail)) {
        return diagnosis("actor_ingress", `${formatMs(ingress)} elapsed before generation_started, pointing to socket dispatch, actor activation, or state commit.`)
    }
    if (tail >= 500 && tail >= Math.max(startup, largestGap)) {
        return diagnosis("completion_tail", `${formatMs(tail)} elapsed after the last text delta before generation_completed.`)
    }
    return diagnosis("healthy_stream", `No dominant transport stall was measured; GCP socket effects were ${formatMs(socketP95)} p95 and the largest delta gap was ${formatMs(largestGap)}.`)
}

async function main(argv) {
    const options = parseArguments(argv)
    if (options.help) {
        printHelp()
        return
    }

    const config = loadConfiguration(options)
    mkdirSync(config.outputDirectory, { recursive: true })
    const gateway = await ensureGateway(config)
    let result

    try {
        result = await runProbe(config)
        await delay(config.logIngestionDelayMs)
        const evidence = await collectEvidence(config, result)
        const timelineSummary = summarizeTimeline(result.timeline)
        const gcpSummary = summarizeGcpEntries(evidence.gcp.entries, timelineSummary.textDeltaCount)
        const modalSummary = summarizeModalLogs(evidence.modal.hostLogs)
        const bottleneck = diagnoseBottleneck(timelineSummary, gcpSummary)
        const summary = {
            runId: config.runId,
            actor: {
                namespaceId: config.namespaceId,
                actorType: config.actorType,
                actorId: config.actorId
            },
            startedAt: result.startedAt,
            completedAt: result.completedAt,
            timeline: timelineSummary,
            gcp: gcpSummary,
            modal: modalSummary,
            diagnosis: bottleneck,
            evidence: {
                gcp: evidence.gcp.error ?? "collected",
                modalHost: evidence.modal.hostError ?? "collected",
                modalWorkflow: evidence.modal.workflowError ?? "collected"
            }
        }
        writeEvidence(config, result, evidence, summary, gateway.output)
        printSummary(config, summary)
    } catch (error) {
        writeFileSync(join(config.outputDirectory, "failure.txt"), `${error.stack ?? error}\n`)
        throw error
    } finally {
        await gateway.stop()
    }
}

async function runProbe(config) {
    const timeline = []
    const startedAt = new Date().toISOString()
    const mark = (name, fields = {}) => {
        const entry = { name, at: new Date().toISOString(), atMs: Date.now(), ...fields }
        timeline.push(entry)
        return entry
    }
    const agentPath = `/v1/agents/${encodeURIComponent(config.actorId)}`
    const headers = { authorization: `Bearer ${config.apiKey}` }
    let connection
    let socket

    mark("lab_started")
    try {
        mark("connect_user_started")
        connection = await fetchJson(new URL(`${agentPath}/connections`, config.gatewayUrl), {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ name: `WebSocket Lab ${config.runId}` }),
            signal: AbortSignal.timeout(config.timeoutMs)
        })
        mark("connect_user_completed")

        mark("presence_ticket_started")
        const presenceUrl = new URL(`${agentPath}/presence`, config.gatewayUrl)
        presenceUrl.searchParams.set("connection_id", connection.connectionId)
        const descriptor = await fetchJson(presenceUrl, {
            headers,
            signal: AbortSignal.timeout(config.timeoutMs)
        })
        mark("presence_ticket_completed")

        const events = createEventCollector(timeline, config.timeoutMs)
        mark("websocket_connecting")
        socket = new WebSocket(descriptor.url)
        socket.addEventListener("message", events.accept)
        socket.addEventListener("close", events.close)
        socket.addEventListener("error", events.fail)
        await waitForSocketOpen(socket, config.timeoutMs)
        mark("websocket_opened")
        await events.waitFor(event => event.type === "history", "actor state snapshot")
        mark("actor_socket_ready")

        mark("prompt_sent")
        const completion = events.waitFor(event => event.type === "generation_completed" || event.type === "generation_failed", "generation completion")
        await fetchEmpty(new URL(`${agentPath}/prompts`, config.gatewayUrl), {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
                prompt: config.prompt,
                connectionId: connection.connectionId,
                attachmentIds: []
            }),
            signal: AbortSignal.timeout(config.timeoutMs)
        })
        mark("prompt_accepted")
        const terminalEvent = await completion
        if (terminalEvent.type === "generation_failed") {
            throw new Error(`Generation failed: ${terminalEvent.message}`)
        }
        mark("probe_completed")

        return {
            startedAt,
            completedAt: new Date().toISOString(),
            timeline
        }
    } finally {
        if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "Lab complete")
        if (connection) {
            await fetch(new URL(`${agentPath}/connections/${connection.connectionId}`, config.gatewayUrl), {
                method: "DELETE",
                headers
            }).catch(() => undefined)
        }
    }
}

function createEventCollector(timeline, timeoutMs) {
    const received = []
    const waiters = new Set()
    let failure

    return {
        accept: async message => {
            const event = await parseSocketEvent(message.data)
            if (!event) return
            received.push(event)
            timeline.push(eventMark(event))
            for (const waiter of waiters) {
                if (!waiter.predicate(event)) continue
                clearTimeout(waiter.timeout)
                waiters.delete(waiter)
                waiter.resolve(event)
            }
        },
        close: () => {
            if (!received.some(event => event.type === "generation_completed")) {
                failure = new Error("WebSocket closed before generation completed")
                rejectWaiters(waiters, failure)
            }
        },
        fail: () => {
            failure = new Error("WebSocket connection failed")
            rejectWaiters(waiters, failure)
        },
        waitFor(predicate, label) {
            const existing = received.find(predicate)
            if (existing) return Promise.resolve(existing)
            if (failure) return Promise.reject(failure)
            return new Promise((resolvePromise, rejectPromise) => {
                const waiter = {
                    predicate,
                    resolve: resolvePromise,
                    reject: rejectPromise,
                    timeout: setTimeout(() => {
                        waiters.delete(waiter)
                        rejectPromise(new Error(`Timed out waiting for ${label}`))
                    }, timeoutMs)
                }
                waiters.add(waiter)
            })
        }
    }
}

export function eventMark(event) {
    const common = {
        name: event.type,
        at: new Date().toISOString(),
        atMs: Date.now()
    }
    switch (event.type) {
        case "history":
            return { ...common, messageCount: event.messages?.length ?? 0 }
        case "connected_users":
            return { ...common, userCount: event.users?.length ?? 0 }
        case "generation_started":
            return { ...common, generationId: event.generationId }
        case "text_delta":
        case "reasoning_delta":
            const delta = deltaMetrics(event.delta)
            return {
                ...common,
                generationId: event.generationId,
                ...delta
            }
        case "generation_completed":
            return {
                ...common,
                generationId: event.generationId,
                characters: event.text?.length ?? 0
            }
        default:
            return common
    }
}

function deltaMetrics(delta) {
    if (typeof delta === "string") {
        return {
            validDelta: true,
            receivedType: "string",
            characters: delta.length,
            bytes: Buffer.byteLength(delta)
        }
    }
    if (delta?.type === "Buffer" && Array.isArray(delta.data)) {
        const value = Buffer.from(delta.data)
        return {
            validDelta: false,
            receivedType: "buffer_json",
            characters: value.toString("utf8").length,
            bytes: value.byteLength
        }
    }
    return {
        validDelta: false,
        receivedType: Array.isArray(delta) ? "array" : typeof delta,
        characters: 0,
        bytes: Buffer.byteLength(JSON.stringify(delta ?? null))
    }
}

async function collectEvidence(config, result) {
    const since = new Date(Date.parse(result.startedAt) - 5_000).toISOString()
    const until = new Date(Date.parse(result.completedAt) + 5_000).toISOString()
    const expectedSocketEffects = result.timeline.filter(mark => mark.name === "text_delta").length
    const [gcp, modalHost, modalWorkflow] = await Promise.all([
        config.collectGcp ? collectGcpEventually(config, since, until, expectedSocketEffects) : unavailable("disabled"),
        config.collectModal ? collectModal(config.modalHostApp, config.actorId, since, until, config.commandTimeoutMs) : unavailable("disabled"),
        config.collectModal ? collectModal(config.modalWorkflowApp, config.actorId, since, until, config.commandTimeoutMs) : unavailable("disabled")
    ])
    return {
        gcp: {
            entries: parseJsonArray(gcp.output),
            raw: gcp.output,
            error: gcp.error
        },
        modal: {
            hostLogs: modalHost.output,
            workflowLogs: modalWorkflow.output,
            hostError: modalHost.error,
            workflowError: modalWorkflow.error
        }
    }
}

async function collectGcpEventually(config, since, until, expectedSocketEffects) {
    let result
    for (let attempt = 0; attempt < 4; attempt += 1) {
        result = await collectGcp(config, since, until)
        if (result.error) return result
        const summary = summarizeGcpEntries(parseJsonArray(result.output), expectedSocketEffects)
        if (summary.socketEffects.captureComplete) return result
        await delay(2_500)
    }
    return result
}

async function collectGcp(config, since, until) {
    const filter = [
        'resource.type="cloud_run_revision"',
        `(resource.labels.service_name="${config.gcpControlPlaneService}" OR resource.labels.service_name="${config.gcpSocketService}")`,
        `timestamp>="${since}"`,
        `timestamp<="${until}"`,
        `(jsonPayload.actor_id="${config.actorId}" OR httpRequest.requestUrl:"/${config.actorId}")`
    ].join(" AND ")
    return runCommand("gcloud", ["logging", "read", filter, `--project=${config.gcpProject}`, "--limit=2000", "--order=asc", "--format=json"], config.commandTimeoutMs)
}

async function collectModal(app, actorId, since, until, timeoutMs) {
    return runCommand("modal", ["app", "logs", app, "--since", since, "--until", until, "--search", actorId, "--tail", "2000", "--timestamps"], timeoutMs)
}

async function ensureGateway(config) {
    if (await gatewayIsHealthy(config.gatewayUrl)) return idleGateway()
    if (!config.startGateway) {
        throw new Error(`Gateway is unavailable at ${config.gatewayUrl} and automatic startup is disabled`)
    }
    if (!existsSync(config.multiplayerDirectory)) {
        throw new Error(`Multiplayer Playground was not found at ${config.multiplayerDirectory}`)
    }

    const child = spawn("pnpm", ["run", "dev:gateway"], {
        cwd: config.multiplayerDirectory,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
    })
    const output = []
    child.stdout.on("data", chunk => output.push(chunk.toString()))
    child.stderr.on("data", chunk => output.push(chunk.toString()))

    const readyAt = Date.now() + 20_000
    while (Date.now() < readyAt) {
        if (child.exitCode !== null) {
            throw new Error(`Gateway exited before becoming ready\n${output.join("")}`)
        }
        if (await gatewayIsHealthy(config.gatewayUrl)) {
            return {
                output,
                async stop() {
                    if (child.exitCode !== null) return
                    child.kill("SIGTERM")
                    await Promise.race([new Promise(resolvePromise => child.once("exit", resolvePromise)), delay(2_000)])
                }
            }
        }
        await delay(250)
    }
    child.kill("SIGTERM")
    throw new Error(`Gateway did not become ready at ${config.gatewayUrl}\n${output.join("")}`)
}

function loadConfiguration(options) {
    const runId = options.runId ?? compactTimestamp(new Date())
    const multiplayerDirectory = resolve(options.multiplayerDirectory ?? process.env.MULTIPLAYER_PLAYGROUND_DIR ?? join(repositoryRoot, "..", "Multiplayer-Playground"))
    const actorDirectory = resolve(options.actorDirectory ?? process.env.TERSE_ACTOR_DIR ?? join(homedir(), "testingTerseActor"))
    const gatewayEnvironment = parseEnvironmentFile(join(multiplayerDirectory, "server", ".env"))
    const actorConfig = JSON.parse(readFileSync(join(actorDirectory, "terse.config.json"), "utf8"))
    const gatewayUrl = new URL(options.gatewayUrl ?? process.env.GATEWAY_URL ?? gatewayEnvironment.TERSE_GATEWAY_PUBLIC_URL ?? "http://127.0.0.1:8790")
    const apiKey = process.env.TERSE_API_KEY ?? gatewayEnvironment.TERSE_API_KEY
    if (!apiKey) throw new Error("TERSE_API_KEY is not configured in the environment or Multiplayer gateway .env")

    return {
        runId,
        actorDirectory,
        multiplayerDirectory,
        gatewayUrl,
        apiKey,
        namespaceId: options.namespaceId ?? actorConfig.projectId,
        actorType: options.actorType ?? "AgentSession",
        actorId: options.actorId ?? `stream-lab-${runId}`,
        prompt: options.prompt ?? `Streaming lab ${runId}. Write exactly 80 short numbered lines. Each line must use the format "N. websocket-lab". Do not add an introduction or conclusion.`,
        outputDirectory: resolve(options.outputDirectory ?? join(repositoryRoot, ".artifacts", "websocket-streaming", runId)),
        timeoutMs: numberOption(options.timeoutMs, 120_000),
        commandTimeoutMs: numberOption(options.commandTimeoutMs, 30_000),
        logIngestionDelayMs: numberOption(options.logIngestionDelayMs, 4_000),
        startGateway: options.startGateway !== false,
        collectGcp: options.collectGcp !== false,
        collectModal: options.collectModal !== false,
        gcpProject: options.gcpProject ?? "fluid-analogy-473415-c2",
        gcpControlPlaneService: options.gcpControlPlaneService ?? "little-actors",
        gcpSocketService: options.gcpSocketService ?? "little-actors-sockets",
        modalHostApp: options.modalHostApp ?? "durable-object-hosts",
        modalWorkflowApp: options.modalWorkflowApp ?? "terse-sdk-sandbox"
    }
}

function writeEvidence(config, result, evidence, summary, gatewayOutput) {
    const write = (name, value) => writeFileSync(join(config.outputDirectory, name), value.endsWith("\n") ? value : `${value}\n`)
    write("timeline.jsonl", result.timeline.map(entry => JSON.stringify(entry)).join("\n"))
    write("gcp.json", evidence.gcp.raw || "[]")
    write("modal-host.log", evidence.modal.hostLogs)
    write("modal-workflow.log", evidence.modal.workflowLogs)
    write("gateway.log", gatewayOutput.join(""))
    write("summary.json", JSON.stringify(summary, null, 2))
    write("report.md", renderReport(summary))
}

function renderReport(summary) {
    const timeline = summary.timeline
    const socketEffects = summary.gcp.socketEffects
    return `# WebSocket streaming lab ${summary.runId}

- Actor: \`${summary.actor.actorType}/${summary.actor.actorId}\`
- Socket to actor ready: ${formatMs(timeline.socketToActorReadyMs)}
- Prompt HTTP acceptance: ${formatMs(timeline.promptAcceptedMs)}
- Prompt to generation start: ${formatMs(timeline.promptToGenerationMs)}
- Generation start to first text: ${formatMs(timeline.generationToFirstTextMs)}
- Text deltas: ${timeline.textDeltaCount} (${timeline.textCharacters} characters)
- Invalid text deltas: ${timeline.invalidTextDeltaCount}
- Inter-delta gap p50/p95/max: ${formatMs(timeline.interDeltaGapMs?.p50)} / ${formatMs(timeline.interDeltaGapMs?.p95)} / ${formatMs(timeline.interDeltaGapMs?.max)}
- GCP socket effects: ${socketEffects.count}/${socketEffects.expectedMinimum} expected minimum, ${formatMs(socketEffects.latencyMs?.p95)} p95
- Diagnosis: \`${summary.diagnosis.bottleneck}\`

${summary.diagnosis.explanation}
`
}

function printSummary(config, summary) {
    const timeline = summary.timeline
    console.log(`\nWebSocket streaming lab ${summary.runId}`)
    console.log(`Actor: ${summary.actor.actorType}/${summary.actor.actorId}`)
    console.log(`Socket → actor ready: ${formatMs(timeline.socketToActorReadyMs)}`)
    console.log(`Prompt HTTP acceptance: ${formatMs(timeline.promptAcceptedMs)}`)
    console.log(`Prompt → generation: ${formatMs(timeline.promptToGenerationMs)}`)
    console.log(`Generation → first text: ${formatMs(timeline.generationToFirstTextMs)}`)
    console.log(`Text deltas: ${timeline.textDeltaCount}; p95 gap: ${formatMs(timeline.interDeltaGapMs?.p95)}`)
    console.log(`Invalid text deltas: ${timeline.invalidTextDeltaCount}`)
    console.log(`GCP socket effects: ${summary.gcp.socketEffects.count}/${summary.gcp.socketEffects.expectedMinimum} expected minimum; p95: ${formatMs(summary.gcp.socketEffects.latencyMs?.p95)}`)
    console.log(`Diagnosis: ${summary.diagnosis.bottleneck}`)
    console.log(summary.diagnosis.explanation)
    console.log(`Evidence: ${config.outputDirectory}`)
}

function parseArguments(argv) {
    const options = {}
    const valueOptions = new Map([
        ["--actor-dir", "actorDirectory"],
        ["--actor-id", "actorId"],
        ["--actor-type", "actorType"],
        ["--command-timeout-ms", "commandTimeoutMs"],
        ["--gateway-url", "gatewayUrl"],
        ["--gcp-project", "gcpProject"],
        ["--ingestion-delay-ms", "logIngestionDelayMs"],
        ["--multiplayer-dir", "multiplayerDirectory"],
        ["--namespace-id", "namespaceId"],
        ["--output", "outputDirectory"],
        ["--prompt", "prompt"],
        ["--run-id", "runId"],
        ["--timeout-ms", "timeoutMs"]
    ])
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === "--help" || argument === "-h") options.help = true
        else if (argument === "--no-gcp") options.collectGcp = false
        else if (argument === "--no-modal") options.collectModal = false
        else if (argument === "--no-start-gateway") options.startGateway = false
        else if (valueOptions.has(argument)) {
            const value = argv[index + 1]
            if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
            options[valueOptions.get(argument)] = value
            index += 1
        } else throw new Error(`Unknown option: ${argument}`)
    }
    return options
}

function printHelp() {
    console.log(`Usage: pnpm lab:websocket [options]

Runs one isolated prompt through the local Multiplayer gateway, the deployed GCP
Durable Object socket gateway, Terse, Modal, and OpenAI. Evidence is written to
.artifacts/websocket-streaming/<run-id>.

Options:
  --actor-id <id>          Use a specific actor instead of an isolated lab actor
  --gateway-url <url>      Use an already-running gateway URL
  --prompt <text>          Override the fixed-length streaming prompt
  --no-start-gateway       Do not start the Multiplayer gateway when unavailable
  --no-gcp                 Skip Cloud Logging evidence
  --no-modal               Skip Modal log evidence
  --output <path>          Override the evidence directory
  --timeout-ms <ms>        Generation timeout (default: 120000)
`)
}

async function gatewayIsHealthy(gatewayUrl) {
    try {
        const response = await fetch(new URL("/health", gatewayUrl), {
            signal: AbortSignal.timeout(1_000)
        })
        return response.ok
    } catch {
        return false
    }
}

async function fetchJson(url, init) {
    const response = await fetch(url, init)
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url.pathname} returned ${response.status}: ${await response.text()}`)
    return response.json()
}

async function fetchEmpty(url, init) {
    const response = await fetch(url, init)
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url.pathname} returned ${response.status}: ${await response.text()}`)
}

function waitForSocketOpen(socket, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => rejectPromise(new Error("Timed out opening the WebSocket")), timeoutMs)
        socket.addEventListener(
            "open",
            () => {
                clearTimeout(timeout)
                resolvePromise()
            },
            { once: true }
        )
        socket.addEventListener(
            "error",
            () => {
                clearTimeout(timeout)
                rejectPromise(new Error("WebSocket connection failed during setup"))
            },
            { once: true }
        )
    })
}

async function parseSocketEvent(data) {
    try {
        if (typeof data === "string") return JSON.parse(data)
        if (data instanceof Blob) return JSON.parse(await data.text())
        if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString("utf8"))
        return JSON.parse(Buffer.from(data).toString("utf8"))
    } catch {
        return null
    }
}

function rejectWaiters(waiters, error) {
    for (const waiter of waiters) {
        clearTimeout(waiter.timeout)
        waiter.reject(error)
    }
    waiters.clear()
}

function parseEnvironmentFile(path) {
    if (!existsSync(path)) throw new Error(`Gateway environment was not found at ${path}`)
    return Object.fromEntries(
        readFileSync(path, "utf8")
            .split("\n")
            .map(line => line.trim())
            .filter(line => line && !line.startsWith("#") && line.includes("="))
            .map(line => {
                const separator = line.indexOf("=")
                const name = line.slice(0, separator).trim()
                const value = line
                    .slice(separator + 1)
                    .trim()
                    .replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2")
                return [name, value]
            })
    )
}

function runCommand(command, arguments_, timeoutMs) {
    return new Promise(resolvePromise => {
        const child = spawn(command, arguments_, { env: process.env, stdio: ["ignore", "pipe", "pipe"] })
        const output = []
        const errors = []
        const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
        child.stdout.on("data", chunk => output.push(chunk.toString()))
        child.stderr.on("data", chunk => errors.push(chunk.toString()))
        child.on("error", error => {
            clearTimeout(timeout)
            resolvePromise({ output: "", error: error.message })
        })
        child.on("close", code => {
            clearTimeout(timeout)
            resolvePromise({
                output: output.join(""),
                error: code === 0 ? undefined : errors.join("").trim() || `${command} exited ${code}`
            })
        })
    })
}

function unavailable(reason) {
    return Promise.resolve({ output: "", error: reason })
}

function idleGateway() {
    return { output: [], stop: async () => undefined }
}

function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value || "[]")
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function parseModalLine(line) {
    const jsonStart = line.indexOf("{")
    if (jsonStart < 0) return null
    try {
        return JSON.parse(line.slice(jsonStart))
    } catch {
        return null
    }
}

function requestSummary(requests) {
    return {
        count: requests.length,
        latencyMs: descriptiveStats(requests.map(request => durationMilliseconds(request.latency)).filter(Number.isFinite))
    }
}

function timedEventSummary(events) {
    return {
        count: events.length,
        latencyMs: descriptiveStats(events.map(event => Number(event.completed_at_ms)).filter(Number.isFinite))
    }
}

function descriptiveStats(values) {
    if (values.length === 0) return null
    const sorted = [...values].sort((left, right) => left - right)
    return {
        min: rounded(sorted[0]),
        mean: rounded(sum(sorted) / sorted.length),
        p50: rounded(percentile(sorted, 0.5)),
        p95: rounded(percentile(sorted, 0.95)),
        p99: rounded(percentile(sorted, 0.99)),
        max: rounded(sorted.at(-1))
    }
}

function percentile(sorted, quantile) {
    return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]
}

function durationMilliseconds(value) {
    const match = /^(\d+(?:\.\d+)?)s$/u.exec(value ?? "")
    return match ? Number(match[1]) * 1_000 : Number.NaN
}

function firstMark(timeline, name) {
    return timeline.find(mark => mark.name === name)
}

function difference(later, earlier) {
    return later && earlier ? rounded(later.atMs - earlier.atMs) : null
}

function sum(values) {
    return values.reduce((total, value) => total + value, 0)
}

function rounded(value) {
    return Math.round(value * 1_000) / 1_000
}

function diagnosis(bottleneck, explanation) {
    return { bottleneck, explanation }
}

function formatMs(value) {
    return `${Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 })} ms`
}

function compactTimestamp(date) {
    return date
        .toISOString()
        .replace(/[-:]/gu, "")
        .replace(/\.\d{3}Z$/u, "Z")
        .toLowerCase()
}

function numberOption(value, fallback) {
    const number = Number(value ?? fallback)
    if (!Number.isFinite(number) || number <= 0) throw new Error(`Expected a positive number, received ${value}`)
    return number
}
