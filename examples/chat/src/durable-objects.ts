import { Actor, Emittable, Persisted } from "little-actors"
import type { ActorSocket } from "little-actors"

export class ChatRoom extends Actor<Member, string, never> {
    @Persisted @Emittable history: ChatMessage[] = []

    async onMessage(socket: ActorSocket<Member, never>, text: string) {
        this.history.push({ name: socket.metadata.name, text })
    }
}

type Member = { name: string }
type ChatMessage = { name: string; text: string }
