import type { UIMessage } from "ai"
import { Actor, Persisted } from "little-actors"

export class ChatHistory extends Actor {
    @Persisted private messages: UIMessage[] = []

    async load() {
        return this.messages
    }

    async append(message: UIMessage) {
        this.messages.push(message)
        return this.messages
    }
}
