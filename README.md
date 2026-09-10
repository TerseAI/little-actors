# little-actors

Coordinating state across machines adds latency. Traditional protocols such as as [two-phase commit (2PC)](https://arxiv.org/abs/cs/0408036) and [Paxos](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf) introduce a lot of overhead. Actors simplify application updates by giving each piece of state one owner.

Previously published as `little-durable-objects`. Existing versions remain available; future releases use `little-actors`. Update npm imports and use matching `little-actors` runtime images when upgrading. The `DURABLE_OBJECT_*` environment variables remain unchanged. To reuse local state, pass `--data-dir .little-durable-objects` to `dev`, `run`, and `token`.

## Build a chat room in your terminal

Run two chat clients in separate terminals. Both receive every message, and the room remembers the conversation when you reconnect or restart the server.

Requires **Node.js 20+ and npm**. The CLI downloads the runtime, with SQLite included.

Use version `0.1.27` or later for this guide. To run a source checkout, follow [Local development](docs/guides/local-development.md).

### 1. Create a project

```sh
mkdir chat-example
cd chat-example
npm init -y
npm pkg set type=module
npm install little-actors
mkdir src
```

This installs the SDK, CLI, and TypeScript support.

### 2. Create the room

Create `src/durable-objects.ts`:

```ts
import { Actor, Persisted } from "little-actors"
import type { ActorMessageOf, ActorSocketOf } from "little-actors"

type Message = { type: "chat"; text: string }

export class ChatRoom extends Actor<{ name: string }, Message> {
    @Persisted history: string[] = []

    async onMessage(socket: ActorSocketOf<ChatRoom>, message: ActorMessageOf<ChatRoom>): Promise<void> {
        const text = `${socket.metadata.name}: ${message.text}`
        this.history.push(text)
        this.broadcast({ type: "chat", text })
    }
}
```

`@Persisted` makes `history` saved actor state. Every instance field requires `@Persisted` or `@Ephemeral`; use `@Ephemeral` for temporary caches. Each incoming message appends to it and broadcasts to everyone in the room, including the sender. When a client connects, the runtime automatically sends the saved state, including the full history.

The SDK encodes and decodes JSON automatically. The actor's generic parameters type connection metadata and messages; optional [Zod schemas](docs/reference/api.md#generics-and-wire-validation) validate their application-specific shapes at runtime.

### 3. Create the terminal client

Create `src/chat.ts`:

```ts
import { createInterface as readLines } from "node:readline"

import { ChatRoom } from "./durable-objects.js"

const name = process.argv[2] ?? "Anonymous"
const socket = await ChatRoom.get("lobby").connect({ name })
const terminal = readLines({ input: process.stdin, output: process.stdout })

socket.addEventListener("message", ({ data }) => {
    console.log(data.type === "state" ? JSON.stringify(data) : data.text)
})
socket.addEventListener("close", () => terminal.close())

for await (const line of terminal) {
    socket.send({ type: "chat", text: line })
}
socket.close()
```

Both clients use `ChatRoom.get("lobby")`, so they share one actor. A different room name creates a separate conversation with its own history.

### 4. Start the server

In terminal 1, from the project directory:

```sh
npx little-actors dev
```

Leave this running. It starts the local server and registers your actor file. SQLite metadata and snapshots go in `.little-actors/`.

Wait for this line before connecting:

```text
Local actors ready at http://127.0.0.1:7100
```

### 5. Open two listeners and chat

In terminal 2, from the same project directory, join as Alice:

```sh
npx little-actors run src/chat.ts Alice
```

In terminal 3, join as Bob:

```sh
npx little-actors run src/chat.ts Bob
```

`run` supplies local credentials automatically. Wait for both clients to print the initial state:

```json
{ "type": "state", "state": { "history": [] } }
```

Leave both running: each listens for messages and lets you send your own. The client formats saved history as JSON and prints the text from live messages.

Once both have joined, type `Hello, Bob!` in Alice's terminal and press Enter. Then type `Hey, Alice!` in Bob's terminal and press Enter. Both clients receive:

```text
Alice: Hello, Bob!
Bob: Hey, Alice!
```

### 6. See history after you close your terminal

Press Ctrl-C in Bob's terminal, then run his command again:

```sh
npx little-actors run src/chat.ts Bob
```

Before Bob types anything, his client shows the saved conversation:

```json
{ "type": "state", "state": { "history": ["Alice: Hello, Bob!", "Bob: Hey, Alice!"] } }
```

To try a full restart, stop both clients and the server with Ctrl-C. Start the server again in terminal 1:

```sh
npx little-actors dev
```

Wait for the ready line, then rerun Alice's and Bob's commands. Both receive the same history and can keep chatting. The messages live in `.little-actors/`, so keep that directory between runs.

## Host it yourself

Follow the [self-hosting guide](docs/guides/self-hosting.md) to connect your backend with an API key and deploy your actors.

## Reference

- [CLI reference](docs/reference/cli.md): running actors and clients, command options, and environment variables.
- [TypeScript API reference](docs/reference/api.md): actor classes, methods, connections, types, and errors.
- [HTTP and WebSocket reference](docs/reference/http.md): deployments, backend access, WebSockets, and callbacks.
- [Advanced access configuration](docs/guides/advanced-access.md).

![Control plane, actor hosts, and persistent storage](docs/architecture.svg)

## License

MIT © 2026 Terse
