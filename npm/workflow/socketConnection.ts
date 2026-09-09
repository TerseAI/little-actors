import type WebSocket from "ws"

import { decodeSocketMessage } from "../shared/socket.js"
import type { ActorConnection, ActorConnectionEventMap, ActorSocketMessage } from "../shared/socket.js"
import { incomingMessage, receivedMessage } from "../shared/socketValidation.js"
import type { ActorSchemas } from "../shared/socketValidation.js"

class SocketConnection implements ActorConnection {
    private readonly events = new EventTarget()

    constructor(
        private readonly socket: Pick<WebSocket, "readyState" | "send" | "close" | "addEventListener">,
        private readonly schemas: ActorSchemas = {}
    ) {
        socket.addEventListener("open", () => this.events.dispatchEvent(new Event("open")))
        socket.addEventListener("error", () => this.events.dispatchEvent(new Event("error")))
        socket.addEventListener("close", ({ code, reason, wasClean }) => this.events.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean })))
        socket.addEventListener("message", event => this.receive(event.data))
    }

    get readyState(): number {
        return this.socket.readyState
    }

    send(data: ActorSocketMessage): void {
        this.socket.send(JSON.stringify(incomingMessage(data, this.schemas)))
    }

    close(code?: number, reason?: string): void {
        this.socket.close(code, reason)
    }

    addEventListener<Type extends keyof ActorConnectionEventMap>(type: Type, listener: (event: ActorConnectionEventMap[Type]) => void): void {
        this.events.addEventListener(type, listener as unknown as EventListener)
    }

    removeEventListener<Type extends keyof ActorConnectionEventMap>(type: Type, listener: (event: ActorConnectionEventMap[Type]) => void): void {
        this.events.removeEventListener(type, listener as unknown as EventListener)
    }

    private receive(data: WebSocket.MessageEvent["data"]): void {
        if (typeof data !== "string") return this.rejectMessage(1003, "socket messages must be JSON text frames")
        let value: ActorSocketMessage
        try {
            value = receivedMessage(decodeSocketMessage({ type: "text", data }), this.schemas)
        } catch {
            return this.rejectMessage(1007, "socket message is not valid JSON")
        }
        this.events.dispatchEvent(new MessageEvent("message", { data: value }))
    }

    private rejectMessage(code: number, reason: string): void {
        this.socket.close(code, reason)
        this.events.dispatchEvent(new Event("error"))
    }
}

export { SocketConnection }
