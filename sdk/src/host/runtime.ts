import type { ActorDefinition, AnyActor } from "../actor/actor.js"
import { Actor, bindActorIdentity } from "../actor/actor.js"
import { actorKey } from "../actor/identity.js"
import type { ActorIdentity } from "../actor/identity.js"
import { runInActorInvocation } from "../actor/invocationContext.js"
import type { ActorSocketScope } from "../actor/socket.js"
import { decodeSocketMessage, runWithActorSockets } from "../actor/socket.js"
import type { SocketEffect } from "../actor/socketProtocol.js"
import { ActorProtocolError, errorMessage } from "../errors.js"
import { cloneJson, isJsonObject } from "../json.js"
import type { JsonObject, JsonValue } from "../json.js"

import { failedReply } from "./protocol.js"
import type { ActorExecutorReply, InvokeCommand, WebSocketEventCommand } from "./protocol.js"
import { hydrateActorState, snapshotActorState } from "./state.js"

class ActorRuntime {
    private instance: AnyActor | undefined
    private identity: ActorIdentity | undefined

    constructor(
        private readonly definition: ActorDefinition,
        private readonly publish?: (effects: readonly SocketEffect[]) => Promise<void>
    ) {}

    async handle(command: InvokeCommand | WebSocketEventCommand): Promise<ActorExecutorReply> {
        return command.type === "invoke" ? this.invoke(command) : this.handleSocketEvent(command)
    }

    private async invoke(command: InvokeCommand): Promise<ActorExecutorReply> {
        const prepared = this.prepare(command)
        if (!(prepared instanceof Actor)) return prepared
        const instance = prepared
        if (!this.definition.methods.has(command.method)) {
            return failedReply(
                "method_not_found",
                `actor method ${this.definition.actorType}.${command.method} was not found`
            )
        }
        const method: unknown = Reflect.get(instance, command.method)
        if (typeof method !== "function") {
            return failedReply(
                "method_not_callable",
                `actor method ${this.definition.actorType}.${command.method} is not callable`
            )
        }

        try {
            const operation = await runWithActorSockets(
                instance,
                command.connections ?? [],
                async () =>
                    runInActorInvocation(async () => Reflect.apply(method, instance, command.args) as Promise<unknown>),
                this.publish,
                this.definition.schemas
            )
            const result: JsonValue = operation.value === undefined ? null : cloneJson(operation.value, "actor result")
            return {
                type: "invoked",
                result,
                state: snapshotActorState(instance),
                ...(operation.effects.length === 0 ? {} : { effects: operation.effects })
            }
        } catch (error) {
            this.reset()
            return failedReply("actor_method_failed", errorMessage(error))
        }
    }

    private async handleSocketEvent(command: WebSocketEventCommand): Promise<ActorExecutorReply> {
        const prepared = this.prepare(command)
        if (!(prepared instanceof Actor)) return prepared
        const instance = prepared
        const methodName = lifecycleMethod(command)
        const method: unknown = Reflect.get(instance, methodName)
        try {
            const operation = await runWithActorSockets(
                instance,
                command.connections,
                async scope => {
                    const args = lifecycleArguments(command, scope, this.definition.schemas)
                    if (method === undefined) return
                    if (typeof method !== "function")
                        throw new ActorProtocolError(
                            `actor lifecycle hook ${this.definition.actorType}.${methodName} is not callable`
                        )
                    await runInActorInvocation(async () => Reflect.apply(method, instance, args) as Promise<unknown>)
                },
                command.event.type === "connect" ? undefined : this.publish,
                this.definition.schemas
            )
            const state = snapshotActorState(instance)
            return { type: "websocket_handled", state, effects: socketEffects(command, state, operation.effects) }
        } catch (error) {
            this.reset()
            return failedReply("actor_socket_failed", errorMessage(error))
        }
    }

    private prepare(command: InvokeCommand | WebSocketEventCommand): AnyActor | ActorExecutorReply {
        const identity = command.actor
        if (identity.actor_type !== this.definition.actorType) {
            return failedReply(
                "actor_type_not_found",
                `actor type ${identity.actor_type} is not loaded in this customer process`
            )
        }
        if (this.identity !== undefined && actorKey(this.identity) !== actorKey(identity)) {
            return failedReply(
                "actor_identity_mismatch",
                "resident actor Worker received an invocation for a different actor"
            )
        }
        if (this.instance !== undefined) return this.instance
        if (command.resident_only) return { type: "state_required" }
        if (command.state === undefined)
            return failedReply("invalid_actor_state", "actor hydration requires an explicit state or null")
        return this.createInstance(identity, command.state)
    }

    private reset(): void {
        this.instance = undefined
        this.identity = undefined
    }

    private createInstance(identity: ActorIdentity, state: JsonValue | null): AnyActor {
        const instance = Reflect.construct(this.definition.actorClass, []) as AnyActor
        bindActorIdentity(instance, identity.actor_id)
        if (state !== null) hydrateActorState(instance, persistedState(state))
        this.identity = { ...identity }
        this.instance = instance
        return instance
    }
}

function socketEffects(
    command: WebSocketEventCommand,
    state: JsonObject,
    effects: readonly SocketEffect[]
): readonly SocketEffect[] {
    if (command.event.type !== "connect" || connectionWasRejected(command.event.connection.id, effects)) return effects
    return [
        ...effects,
        {
            type: "send",
            connection_id: command.event.connection.id,
            message: { type: "text", data: JSON.stringify({ type: "state", state }) }
        }
    ]
}

function connectionWasRejected(connectionId: string, effects: readonly SocketEffect[]): boolean {
    return effects.some(effect => effect.type === "reject" && effect.connection_id === connectionId)
}

function lifecycleMethod(command: WebSocketEventCommand): "onConnect" | "onMessage" | "onDisconnect" {
    switch (command.event.type) {
        case "connect":
            return "onConnect"
        case "message":
            return "onMessage"
        case "disconnect":
            return "onDisconnect"
    }
}

function lifecycleArguments(
    command: WebSocketEventCommand,
    scope: ActorSocketScope,
    schemas: ActorDefinition["schemas"]
): readonly unknown[] {
    switch (command.event.type) {
        case "connect":
            return [scope.eventSocket(command.event.connection, "connecting")]
        case "message":
            return [scope.connection(command.event.connection_id), decodeSocketMessage(command.event.message, schemas)]
        case "disconnect":
            return [
                scope.eventSocket(command.event.connection, "closed"),
                command.event.code,
                command.event.reason,
                command.event.was_clean
            ]
    }
}

function persistedState(value: JsonValue): JsonObject {
    if (!isJsonObject(value)) {
        throw new ActorProtocolError("persisted actor state must be a JSON object")
    }
    return value
}

export { ActorRuntime }
