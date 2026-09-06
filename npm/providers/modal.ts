import { AlreadyExistsError, ModalClient, NotFoundError, Probe } from "modal"
import type { App, Image, Sandbox } from "modal"
import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"

import { modalPlacement } from "../regions.js"

import type { ActorHostHandle, ActorHostProvisioning, EnsureHostRequest, HostTermination, ImageWarmup, SandboxProvider, TerminateHostsRequest, WarmImageRequest } from "./types.js"

const appName = "durable-object-hosts"
const hostPort = 7101
const hostRouteFile = "/tmp/durable-object-route"
const hostMetadataFile = "/tmp/durable-object-host.json"
const readyFile = "/tmp/durable-object-ready"
const hostStderrFile = "/tmp/durable-object-host.stderr"
const maximumSandboxLifetimeMs = 24 * 60 * 60 * 1000

interface ModalSandboxProviderOptions {
    readonly client?: ModalClient
    readonly now?: () => number
}

type SandboxAcquisition = { readonly sandbox: Sandbox; readonly reused: boolean }
type ProvisioningPhases = {
    -readonly [Key in keyof Omit<ActorHostProvisioning, "provider" | "resourceId" | "reused" | "completedAtMs">]: ActorHostProvisioning[Key]
}

class ModalSandboxProvider implements SandboxProvider {
    private readonly modal: ModalClient
    private readonly now: () => number
    private readonly activations = new Map<string, Promise<ActorHostHandle>>()

    constructor(options: ModalSandboxProviderOptions = {}) {
        this.modal = options.client ?? new ModalClient()
        this.now = options.now ?? (() => performance.now())
    }

    async warmImage(request: WarmImageRequest): Promise<ImageWarmup> {
        const startedAt = this.now()
        validateWarmImageRequest(request)
        const placement = modalPlacement(request.canonicalRegion)
        const [app, image] = await Promise.all([this.modal.apps.fromName(appName, { createIfMissing: true }), this.modal.images.fromId(request.imageRef)])
        const sandbox = await this.modal.sandboxes.experimentalCreate(app, image, {
            command: ["true"],
            timeoutMs: 120_000,
            regions: [...placement.regions],
            cloud: placement.cloud
        })
        try {
            const exitCode = await sandbox.wait()
            if (exitCode !== 0) throw new Error(`Modal image warmup exited with status ${exitCode}`)
            return { provider: "modal", resourceId: sandbox.sandboxId, totalMs: elapsedMs(startedAt, this.now()) }
        } finally {
            await sandbox.terminate().catch(() => undefined)
        }
    }

    async terminateHosts(request: TerminateHostsRequest): Promise<HostTermination> {
        validateTerminateHostsRequest(request)
        let app: App
        try {
            app = await this.modal.apps.fromName(appName, { createIfMissing: false })
        } catch (error) {
            if (error instanceof NotFoundError) return { provider: "modal", resourceIds: [] }
            throw error
        }
        const resourceIds: string[] = []
        for (const region of request.canonicalRegions) {
            const name = resourceName("host", request.namespaceId, request.codeRevision, region)
            try {
                const sandbox = await this.modal.sandboxes.experimentalFromName(app.name ?? appName, name)
                await sandbox.terminate()
                resourceIds.push(sandbox.sandboxId)
            } catch (error) {
                if (!(error instanceof NotFoundError)) throw error
            }
        }
        return { provider: "modal", resourceIds }
    }

    async ensureHost(request: EnsureHostRequest): Promise<ActorHostHandle> {
        const key = resourceName("host", request.namespaceId, request.codeRevision, request.canonicalRegion)
        const current = this.activations.get(key)
        if (current) return current
        const activation = this.ensureHostOnce(request, key).finally(() => this.activations.delete(key))
        this.activations.set(key, activation)
        return activation
    }

    private async ensureHostOnce(request: EnsureHostRequest, name: string): Promise<ActorHostHandle> {
        const startedAt = this.now()
        const phases: ProvisioningPhases = { startedAtMs: 0 }
        validateEnsureRequest(request)
        const placement = modalPlacement(request.canonicalRegion)
        const [app, image] = await Promise.all([this.modal.apps.fromName(appName, { createIfMissing: true }), this.modal.images.fromId(request.imageRef)])
        this.mark(phases, "resourcesResolvedAtMs", startedAt)
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const acquired = await this.createSandbox(request, name, app, image, placement)
            this.mark(phases, "sandboxScheduledAtMs", startedAt)
            if (!acquired.reused) return this.activate(acquired.sandbox, request, startedAt, phases)
            const handle = await this.reuse(acquired.sandbox, request.canonicalRegion, startedAt, phases)
            if (handle) return handle
        }
        throw new Error("concurrent Modal V2 host could not be reused")
    }

    private async reuse(sandbox: Sandbox, canonicalRegion: string, startedAt: number, phases: ProvisioningPhases): Promise<ActorHostHandle | undefined> {
        if ((await sandbox.poll()) !== null) return undefined
        try {
            const handle = await this.readHandle(sandbox, canonicalRegion)
            this.mark(phases, "hostReadyObservedAtMs", startedAt)
            this.mark(phases, "routeReadAtMs", startedAt)
            return this.withProvisioning(handle, sandbox, true, startedAt, phases)
        } catch {
            await sandbox.terminate()
            return undefined
        }
    }

    private async createSandbox(request: EnsureHostRequest, name: string, app: App, image: Image, placement: ReturnType<typeof modalPlacement>): Promise<SandboxAcquisition> {
        try {
            const sandbox = await this.modal.sandboxes.experimentalCreate(app, image, {
                name,
                timeoutMs: maximumSandboxLifetimeMs,
                idleTimeoutMs: request.hostIdleTimeoutMs,
                command: hostCommand(),
                workdir: request.workingDirectory,
                env: hostEnvironment(request),
                h2Ports: [hostPort],
                readinessProbe: Probe.withExec(["sh", "-c", `test -f ${readyFile}`], { intervalMs: 50 }),
                regions: [...placement.regions],
                cloud: placement.cloud
            })
            return { sandbox, reused: false }
        } catch (error) {
            if (!(error instanceof AlreadyExistsError)) throw error
            const raced = await this.modal.sandboxes.experimentalFromName(app.name ?? appName, name)
            return { sandbox: raced, reused: true }
        }
    }

    private async activate(sandbox: Sandbox, request: EnsureHostRequest, startedAt: number, phases: ProvisioningPhases): Promise<ActorHostHandle> {
        const handle = await this.startPublic(sandbox, request, startedAt, phases)
        return this.withProvisioning(handle, sandbox, false, startedAt, phases)
    }

    private async readHandle(sandbox: Sandbox, canonicalRegion: string): Promise<ActorHostHandle> {
        const process = await sandbox.exec(["sh", "-c", `for i in $(seq 1 1200); do test -f ${readyFile} && test -s ${hostMetadataFile} && exec cat ${hostMetadataFile}; sleep 0.05; done; exit 1`], {
            stdout: "pipe",
            stderr: "pipe"
        })
        const [document, exitCode] = await Promise.all([process.stdout.readText(), process.wait()])
        if (exitCode !== 0) throw new Error("existing Modal host has no ready metadata")
        const handle = JSON.parse(document) as ActorHostHandle
        if (handle.canonicalRegion !== canonicalRegion) throw new Error("existing Modal host has the wrong canonical region")
        return handle
    }

    private async startPublic(sandbox: Sandbox, request: EnsureHostRequest, startedAt: number, phases: ProvisioningPhases): Promise<ActorHostHandle> {
        const route = (await sandbox.tunnels())[hostPort]?.url
        if (!route) throw new Error("Modal did not create the durable-object HTTP/2 tunnel")
        await writeFile(sandbox, hostRouteFile, route)
        this.mark(phases, "routeReadAtMs", startedAt)
        await this.waitForReady(sandbox)
        this.mark(phases, "hostReadyObservedAtMs", startedAt)
        return { hostId: request.hostId, route, canonicalRegion: request.canonicalRegion }
    }

    private async waitForReady(sandbox: Sandbox): Promise<void> {
        try {
            await sandbox.waitUntilReady(60_000)
        } catch (error) {
            const detail = await sandbox.filesystem.readText(hostStderrFile).catch(() => "")
            await sandbox.terminate().catch(() => undefined)
            const message = detail.trim() || (error instanceof Error ? error.message : String(error))
            throw new Error(`durable-object host did not become ready${message ? `: ${message}` : ""}`)
        }
    }

    private withProvisioning(handle: ActorHostHandle, sandbox: Sandbox, reused: boolean, startedAt: number, phases: ProvisioningPhases): ActorHostHandle {
        return {
            ...handle,
            provisioning: {
                provider: "modal",
                resourceId: sandbox.sandboxId,
                reused,
                ...phases,
                completedAtMs: elapsedMs(startedAt, this.now())
            }
        }
    }

    private mark(phases: ProvisioningPhases, name: keyof ProvisioningPhases, startedAt: number): void {
        phases[name] = elapsedMs(startedAt, this.now())
    }
}

function hostEnvironment(request: EnsureHostRequest): Record<string, string> {
    return {
        DURABLE_OBJECT_PROCESS_ROLE: "host",
        DURABLE_OBJECT_HOST_TOKEN: request.hostToken,
        DURABLE_OBJECT_JWT_PUBLIC_KEYS: request.jwtPublicKeys,
        DURABLE_OBJECT_NAMESPACE_ID: request.namespaceId,
        DURABLE_OBJECT_CONTROL_PLANE_URL: request.controlPlaneUrl,
        DURABLE_OBJECT_JWT_ISSUER: request.jwtIssuer,
        DURABLE_OBJECT_INVOKE_JWT_AUDIENCE: request.invocationJwtAudience,
        DURABLE_OBJECT_HOST_ID: request.hostId,
        DURABLE_OBJECT_SESSION_ID: request.sessionId,
        DURABLE_OBJECT_REGION: request.canonicalRegion,
        DURABLE_OBJECT_CODE_REVISION: request.codeRevision,
        DURABLE_OBJECT_EXECUTOR_SOCKET: "/tmp/durable-object-executor.sock",
        DURABLE_OBJECT_HOST_READY_FILE: readyFile,
        DURABLE_OBJECT_HOST_METADATA_FILE: hostMetadataFile,
        DURABLE_OBJECT_HOST_BIND: `0.0.0.0:${hostPort}`,
        DURABLE_OBJECT_ACTOR_IDLE_TIMEOUT_MS: String(request.actorIdleTimeoutMs),
        DURABLE_OBJECT_HOST_IDLE_TIMEOUT_MS: String(request.hostIdleTimeoutMs),
        DURABLE_OBJECT_HOST_PUBLIC_ROUTE_FILE: hostRouteFile,
        ...(request.actorEntrypoint ? { DURABLE_OBJECT_ENTRYPOINT: request.actorEntrypoint } : {})
    }
}

function hostCommand(): string[] {
    const bootstrap = '"$1" 2>"$2"; status=$?; if ! test -f "$3"; then sleep 60; fi; exit "$status"'
    return ["sh", "-c", bootstrap, "durable-object-host-bootstrap", "/usr/local/bin/little-durable-objects", hostStderrFile, readyFile]
}

function validateEnsureRequest(request: EnsureHostRequest): void {
    if (!request.hostId.startsWith(`host.v1.${request.namespaceId}.`)) throw new Error("host ID does not belong to its namespace")
    if (!Number.isInteger(request.actorIdleTimeoutMs) || request.actorIdleTimeoutMs <= 0 || request.actorIdleTimeoutMs > maximumSandboxLifetimeMs) {
        throw new Error("actor idle timeout is invalid")
    }
    if (!Number.isInteger(request.hostIdleTimeoutMs) || request.hostIdleTimeoutMs <= 0 || request.hostIdleTimeoutMs > maximumSandboxLifetimeMs) {
        throw new Error("host idle timeout is invalid")
    }
}

function validateWarmImageRequest(request: WarmImageRequest): void {
    if (!request.namespaceId || !request.codeRevision || !request.imageRef) throw new Error("image warmup request is invalid")
}

function validateTerminateHostsRequest(request: TerminateHostsRequest): void {
    if (!request.namespaceId || !request.codeRevision || request.canonicalRegions.length === 0) throw new Error("host termination request is invalid")
    for (const region of request.canonicalRegions) modalPlacement(region)
}

function resourceName(kind: string, namespaceId: string, codeRevision: string, canonicalRegion: string): string {
    const digest = createHash("sha256").update(namespaceId).update("\0").update(codeRevision).update("\0").update(canonicalRegion).digest("hex").slice(0, 32)
    return `do-${kind}-${digest}`
}

async function writeFile(sandbox: Sandbox, path: string, contents: string): Promise<void> {
    await sandbox.filesystem.writeText(contents, path)
}

function elapsedMs(startedAt: number, finishedAt: number): number {
    return Math.max(0, Math.round(finishedAt - startedAt))
}

export { ModalSandboxProvider }
export type { ModalSandboxProviderOptions }
