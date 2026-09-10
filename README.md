# little-actors

little-actors is a lightweight framework for durable actors, powered by Rust.

Write TypeScript classes that keep their state.

## Browser chat demo

### 1. Install

Install the package in both your backend and web app:

```sh
npm install little-actors
```

The package installs the `lac` CLI. Run the commands below from the backend project unless stated otherwise.

### 2. Define the backend actor

Create `src/durable-objects.ts` in your backend:

```ts
import { Actor, Emittable, Persisted } from "little-actors"
import type { ActorMessageOf, ActorSocketOf } from "little-actors"

type Post = { type: "post"; text: string }
type ChatMessage = { name: string; text: string }

export class ChatRoom extends Actor<{ name: string }, Post, never> {
    @Persisted @Emittable history: ChatMessage[] = []

    async onMessage(socket: ActorSocketOf<ChatRoom>, message: ActorMessageOf<ChatRoom>): Promise<void> {
        this.history.push({ name: socket.metadata.name, text: message.text })
    }
}
```

### 3. Start the actor server

```sh
npx lac dev
```

Wait for `Local actors ready at http://127.0.0.1:7100`. The server saves state in `.little-actors/` and writes local connection settings to `.little-actors/runtime.json`.

### 4. Generate the client and proxy

Assuming your web app is in the sibling `web/` directory:

```sh
npx lac generate src/durable-objects.ts --out-dir src/generated/actors
npx lac generate src/durable-objects.ts --out-dir ../web/src/generated/actors
```

### 5. Authorize connections in your application

Mount this handler at `POST /api/rooms/lobby/socket` in your application backend:

```ts
import { canJoinRoom, getUser } from "./auth.js"
import { ActorProxy } from "./generated/actors/proxy.js"

export async function POST(request: Request): Promise<Response> {
    const user = await getUser(request)
    if (!user) return new Response("Sign in first", { status: 401 })
    if (!(await canJoinRoom(user, "lobby"))) return new Response("Access denied", { status: 403 })

    return ActorProxy.handle(request, {
        actorType: "ChatRoom",
        actorId: "lobby",
        metadata: { name: user.name }
    })
}
```

### 6. Connect the web page

Add this markup to a signed-in page in your web app:

```html
<p id="status" role="status">Connecting…</p>
<ul id="messages" aria-live="polite"></ul>
<form id="chat">
    <label for="text">Message</label>
    <input id="text" name="text" autocomplete="off" maxlength="500" required />
    <button id="send" disabled>Send</button>
</form>
```

Load this TypeScript module through your frontend bundler:

```ts
import { ActorClient } from "./generated/actors/index.js"

const client = ActorClient({ endpoint: "/api/rooms/lobby/socket" })
const room = client.ChatRoom.get("lobby")
const messages = document.querySelector<HTMLUListElement>("#messages")!
const status = document.querySelector<HTMLParagraphElement>("#status")!
const input = document.querySelector<HTMLInputElement>("#text")!
const send = document.querySelector<HTMLButtonElement>("#send")!

room.subscribe("history", history => {
    messages.replaceChildren(
        ...history.map(message => {
            const item = document.createElement("li")
            item.textContent = `${message.name}: ${message.text}`
            return item
        })
    )
})
room.on("status", value => {
    status.textContent = value
    send.disabled = value !== "open"
})
room.on("error", error => {
    status.textContent = error.message
})

document.querySelector<HTMLFormElement>("#chat")!.addEventListener("submit", event => {
    event.preventDefault()
    try {
        room.send({ type: "post", text: input.value })
        input.value = ""
    } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error)
    }
})
window.addEventListener("pagehide", () => room.close(), { once: true })
await room.connect().catch(error => {
    status.textContent = error.message
})
```

## Host it yourself

Follow the [self-hosting guide](docs/guides/self-hosting.md) to connect your backend with an API key and deploy your actors.

## Reference

- [CLI reference](docs/reference/cli.md): running actors, generating SDKs, command options, and environment variables.
- [TypeScript API reference](docs/reference/api.md): actor classes, methods, connections, types, and errors.
- [HTTP and WebSocket reference](docs/reference/http.md): deployments, backend access, WebSockets, and callbacks.
- [Advanced access configuration](docs/guides/advanced-access.md).

![Control plane, actor hosts, and persistent storage](docs/architecture.svg)

## License

MIT © 2026 Terse
