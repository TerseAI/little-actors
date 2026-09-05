import { AsyncLocalStorage } from "node:async_hooks"

import type { ActorConnection, ActorSocketMessage } from "../shared/socket.js"

import { configuredSettings } from "./clientSettings.js"
import type { DurableObjectsClientOptions } from "./remoteClient.js"

interface ActorClientTransport {
    invoke(actorType: string, actorId: string, method: string, args: readonly unknown[]): Promise<unknown>
    connect(actorType: string, actorId: string, metadata: unknown): Promise<ActorConnection>
    broadcast(actorType: string, actorId: string, message: ActorSocketMessage): Promise<void>
}

const scopedClients = new AsyncLocalStorage<ActorClientTransport>()

function actorClient(): ActorClientTransport {
    return scopedClients.getStore() ?? defaultClient
}

function configureDurableObjects(options: DurableObjectsClientOptions): void {
    defaultClient = new LazyActorClient(configuredSettings(options))
}

function runWithActorClient<T>(client: ActorClientTransport, operation: () => T): T {
    return scopedClients.run(client, operation)
}

class LazyActorClient implements ActorClientTransport {
    private client: Promise<ActorClientTransport> | undefined

    constructor(private readonly options?: DurableObjectsClientOptions) {}

    async invoke(actorType: string, actorId: string, method: string, args: readonly unknown[]): Promise<unknown> {
        return (await this.load()).invoke(actorType, actorId, method, args)
    }

    async connect(actorType: string, actorId: string, metadata: unknown): Promise<ActorConnection> {
        return (await this.load()).connect(actorType, actorId, metadata)
    }

    async broadcast(actorType: string, actorId: string, message: ActorSocketMessage): Promise<void> {
        return (await this.load()).broadcast(actorType, actorId, message)
    }

    private load(): Promise<ActorClientTransport> {
        this.client ??= import("./remoteClient.js")
            .then(({ RemoteActorClient }) => new RemoteActorClient(this.options))
            .catch(error => {
                this.client = undefined
                throw error
            })
        return this.client
    }
}

let defaultClient: ActorClientTransport = new LazyActorClient()

export { actorClient, configureDurableObjects, runWithActorClient }
export type { ActorClientTransport, DurableObjectsClientOptions }
