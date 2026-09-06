# little-durable-objects

A multi-tenant durable-object runtime that is provider neutral.

Initial implementation uses Modal as the dataplane sandbox provider. Actor-state snapshots use regional GCS buckets, which provide the durability guarantee. PostgreSQL manages leases and current state head.

## Install

Install the TypeScript API in actor and workflow projects:

```sh
pnpm add little-durable-objects
```

Install the Rust runtime from crates.io:

```sh
cargo install little-durable-objects --locked
```

## Quickstart

1. Create a Postgres database and one GCS `STANDARD` bucket. Give the service account in `GOOGLE_APPLICATION_CREDENTIALS` object access to the bucket.

2. Build the Rust runtime, TypeScript package, and Go provider:

    ```sh
    pnpm install
    pnpm build
    (cd providers/modal-go && go build -o ../../target/release/little-durable-objects-modal-go .)
    ```

3. Start the control plane. Its HTTP origin serves the public REST API and the internal host gRPC API, so it must be reachable from Modal with HTTP/2 enabled.

    ```sh
    export DURABLE_OBJECT_PROCESS_ROLE=control_plane
    export DURABLE_OBJECT_POSTGRES_URL='postgresql://localhost/durable_objects?sslmode=disable'
    export DURABLE_OBJECT_STANDARD_BUCKETS='{"north-america-east":"my-actor-state-bucket"}'
    export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
    export DURABLE_OBJECT_CONTROL_PLANE_BIND=0.0.0.0:7100
    export DURABLE_OBJECT_CONTROL_PLANE_URL=https://objects.example.com
    export DURABLE_OBJECT_JWT_SIGNING_KEY="$(openssl genpkey -algorithm Ed25519 -outform DER | base64 | tr -d '\n')"
    export DURABLE_OBJECT_API_KEY="$(openssl rand -hex 32)"
    export DURABLE_OBJECT_SANDBOX_PROVIDER=modal
    export DURABLE_OBJECT_SANDBOX_COMMAND="$PWD/target/release/little-durable-objects-modal-go"
    export MODAL_TOKEN_ID=...
    export MODAL_TOKEN_SECRET=...

    ./target/release/little-durable-objects
    ```

4. Export actors from `src/durable-objects.ts` in your project:

    ```ts
    import { Actor } from "little-durable-objects"

    export class Counter extends Actor {
        count = 0
        async increment(): Promise<number> {
            return ++this.count
        }
    }
    ```

5. From your trusted backend, call the JSON API using `Authorization: Bearer $DURABLE_OBJECT_API_KEY`:

    ```text
    PUT  /v1/namespaces/{namespaceId}/deployment
    POST /v1/namespaces/{namespaceId}/session-scoped-token
    ```

6. Set the workflow's environment before its first actor call. Use the issued session token, never the API key:

    ```sh
    export DURABLE_OBJECT_TOKEN='<issued-workflow-token>'
    export DURABLE_OBJECT_NAMESPACE_ID='my-project'
    export DURABLE_OBJECT_CONTROL_PLANE_URL='https://objects.example.com'
    ```

    For a separate WebSocket gateway, also set `DURABLE_OBJECT_SOCKET_GATEWAY_URL`; otherwise it uses the control-plane URL. Terse supplies these variables when it starts a workflow.

    The SDK reads the environment on first use, resolves a short-lived actor target, and invokes the regional host directly over gRPC:

    ```ts
    import { Counter } from "./durable-objects.js"

    await Counter.get("account-1").increment()
    ```

## WebSockets

Actors can own WebSockets without a context object or an explicit accept step. Define any lifecycle hooks you need and attach JSON-serializable, typed metadata to each connection:

```ts
import { Actor } from "little-durable-objects"
import type { ActorSocket } from "little-durable-objects"

interface Session {
    userId: string
    connectedAt: number
}

export class ChatRoom extends Actor {
    async onMessage(socket: ActorSocket<Session>, message: string | Uint8Array): Promise<void> {
        this.broadcast(message)
    }

    async onDisconnect(socket: ActorSocket<Session>, code: number, reason: string, wasClean: boolean): Promise<void> {
        console.log(socket.metadata.userId, code, reason, wasClean)
    }
}
```

Connect from a trusted Node.js workflow using the same environment variables:

```ts
const socket = await ChatRoom.get("lobby").connect({
    userId: "user-1",
    connectedAt: Date.now()
})

socket.addEventListener("message", event => console.log(event.data))
socket.send("hello")

await ChatRoom.get("lobby").broadcast("streamed output")
```

## License

MIT © 2026 Terse
