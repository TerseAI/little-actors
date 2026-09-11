import { Actor, Emittable, Persisted } from "little-actors"
import type { ActorSocket } from "little-actors"

export class ChatRoom extends Actor<Member, ClientEvent, never> {
    @Persisted @Emittable history: ChatMessage[] = []

    async onMessage(socket: ActorSocket<Member, never>, message: ClientEvent): Promise<void> {
        this.history.push({ name: socket.metadata.name, text: message.text })
    }
}

type Member = { name: string }
type ClientEvent = { type: "post"; text: string }
type ChatMessage = { name: string; text: string }
