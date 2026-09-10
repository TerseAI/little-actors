import { parentPort, workerData } from "node:worker_threads"

import { findActorDefinition } from "../actor/actor.js"
import type { SocketEffect } from "../actor/socketProtocol.js"
import { errorMessage } from "../errors.js"

import { loadActorEntrypoint } from "./actorModule.js"
import { failedReply } from "./protocol.js"
import type { ActorWorkerData, ActorWorkerMessage, ActorWorkerRequest } from "./protocol.js"
import { ActorRuntime } from "./runtime.js"

const port = parentPort
if (port === null) throw new Error("actor Worker requires a parent message port")

const data = workerData as ActorWorkerData
let publishing: { resolve: () => void; reject: (error: Error) => void } | undefined
try {
    const actorTypes = await loadActorEntrypoint(data.moduleUrl)
    let runtime: ActorRuntime | undefined

    port.on("message", (message: ActorWorkerRequest) => {
        if (message.type === "socket_effects_published") {
            const pending = publishing
            publishing = undefined
            if (message.error === undefined) pending?.resolve()
            else pending?.reject(new Error(message.error))
            return
        }
        const definition = findActorDefinition(message.command.actor.actor_type)
        if (definition === undefined) {
            post(
                failedReply(
                    "actor_type_not_found",
                    `actor entrypoint ${data.moduleUrl} does not export ${message.command.actor.actor_type}`
                )
            )
            return
        }
        runtime ??= new ActorRuntime(definition, publish)
        void runtime.handle(message.command).then(
            reply => post(reply),
            error => post(failedReply("actor_worker_failed", errorMessage(error)))
        )
    })
    post({ type: "ready", actorTypes })
} catch (error) {
    post(failedReply("actor_worker_failed", errorMessage(error)))
}

function post(message: ActorWorkerMessage): void {
    port!.postMessage(message)
}

function publish(effects: readonly SocketEffect[]): Promise<void> {
    return new Promise((resolve, reject) => {
        if (publishing !== undefined) throw new Error("actor socket output is already being published")
        publishing = { resolve, reject }
        post({ type: "socket_effects", effects })
    })
}
