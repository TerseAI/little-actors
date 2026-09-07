# API reference

The application API provides named TypeScript actors with saved state and WebSocket connections. The HTTP management API registers deployments and issues application credentials. This reference covers the API in this checkout.

Start with the [chat tutorial](../../README.md#build-a-chat-room-in-your-terminal), use the [CLI reference](cli.md) to run it, or follow the [self-hosting guide](../guides/self-hosting.md) to deploy it.

## Contents

- [Package exports](#package-exports)
- [Client configuration](#client-configuration)
- [Define an actor](#define-an-actor)
- [Actor references](#actor-references)
- [Saved state and serialization](#saved-state-and-serialization)
- [WebSocket lifecycle](#websocket-lifecycle)
- [Actor socket methods](#actor-socket-methods)
- [Client connections](#client-connections)
- [Errors and retries](#errors-and-retries)
- [Limits](#limits)
- [HTTP authentication](#http-authentication)
- [Deployments](#deployments)
- [Session tokens](#session-tokens)
- [Storage regions](#storage-regions)
- [Public signing keys](#public-signing-keys)
- [Direct WebSocket connections](#direct-websocket-connections)
- [WebSocket callbacks](#websocket-callbacks)
- [HTTP errors](#http-errors)

## Package exports

Requires Node.js 20+ and an ES module project. Import the SDK from `little-durable-objects`:

```ts
import { Actor, ActorInvocationError } from "little-durable-objects"
import type { ActorBroadcastOptions, ActorClass, ActorConnection, ActorSocket, ActorSocketMessage, ActorSocketState } from "little-durable-objects"
```

| Export                                       | Kind        | Purpose                                                |
| -------------------------------------------- | ----------- | ------------------------------------------------------ |
| `Actor`                                      | Class       | Base class for actor definitions.                      |
| `ActorInvocationError`                       | Error class | A failed remote operation, with a code and request ID. |
| `ActorClass<Instance extends Actor = Actor>` | Type        | An actor class with a prototype of type `Instance`.    |
| `ActorSocket<Metadata>`                      | Type        | An actor-side connection, including metadata and tags. |
| `ActorSocketMessage`                         | Type        | `string \| Uint8Array`.                                |
| `ActorSocketState`                           | Type        | `"connecting" \| "open" \| "closed"`.                  |
| `ActorBroadcastOptions`                      | Type        | Recipient exclusions and tag filters.                  |
| `ActorConnection`                            | Type        | The client-side connection returned by `connect()`.    |

These are all application exports from the package root. Actor references and their metadata types are inferred from your class; there is no separately exported `ActorReference` type or client setup function. Use browser-native WebSockets with the [external connection API](#external-connections) for browser clients.

## Client configuration

Set these environment variables before the first remote operation:

```sh
export DURABLE_OBJECT_TOKEN='<session-token>'
export DURABLE_OBJECT_NAMESPACE_ID='chat-project'
export DURABLE_OBJECT_CONTROL_PLANE_URL='https://objects.example.com'
```

| Variable                            | Required | Meaning                                                                   |
| ----------------------------------- | -------- | ------------------------------------------------------------------------- |
| `DURABLE_OBJECT_TOKEN`              | Yes      | Session token issued by your trusted backend.                             |
| `DURABLE_OBJECT_NAMESPACE_ID`       | Yes      | Namespace containing the deployed actors.                                 |
| `DURABLE_OBJECT_CONTROL_PLANE_URL`  | Yes      | HTTP(S) origin of the server.                                             |
| `DURABLE_OBJECT_SOCKET_GATEWAY_URL` | No       | Separate HTTP(S) WebSocket gateway origin; defaults to the server origin. |

An origin may include a port and trailing slash. It must not include a path, query, fragment, username, or password. Use `https://sockets.example.com`, not `wss://sockets.example.com`, in the gateway variable; the SDK chooses the WebSocket scheme.

Configuration is loaded lazily and cached after the first operation. Set it once before making calls; changing environment variables afterward does not reconfigure the existing client. The SDK does not automatically renew session tokens. For local development, [`run`](cli.md#run) supplies these values.

Session tokens authorize access within a namespace. Keep the admin API key on your backend. Use separate processes for different SDK configurations; the package root does not expose a per-client configuration constructor.

## Define an actor

Export named classes from your actor entrypoint, normally `src/durable-objects.ts`:

```ts
import { Actor } from "little-durable-objects"

export class Counter extends Actor {
    count = 0

    async increment(by = 1): Promise<number> {
        this.count += by
        return this.count
    }

    async read(): Promise<number> {
        return this.count
    }
}
```

An actor definition must:

- Extend `Actor` directly, without an intermediate base class.
- Use a named export matching the class name. Default exports and aliases are rejected.
- Have no required constructor arguments. Normally omit the constructor and use field initializers.
- Define callable methods as `async` prototype methods. Getters, setters, symbol methods, and synchronous prototype methods are rejected.
- Avoid the reserved method names `then`, `connect`, and `broadcast`.

Keep all runtime exports in the entrypoint as actor classes. Type-only exports are erased and do not create runtime exports. Put shared constants and utilities in other modules. Class-field arrow functions are not discovered as actor methods and should not be used as remote methods.

The base constructor is protected. Use `Counter.get(id)` rather than constructing actors in application code. A custom constructor must remain protected for the typed `get()` API.

TypeScript `private` and `protected` keywords do not provide authorization for remotely discovered prototype methods. Validate access in your application. Keep pure helpers outside the actor class or use JavaScript private methods where appropriate.

### Identity

An actor is identified by its namespace, class name, and actor ID. Reusing the same identity addresses the same saved state. A different class name or ID addresses a different actor.

| Component        | Maximum length |
| ---------------- | -------------- |
| Namespace ID     | 96 bytes       |
| Actor class name | 48 bytes       |
| Actor ID         | 128 bytes      |
| Method name      | 128 bytes      |

Each component must be nonempty and contain only ASCII letters, digits, `.`, `_`, and `-`. The combined lengths of namespace, class name, and actor ID must also be at most 243 bytes. Validation may happen when creating a reference or when a request reaches the server.

### `this.id`

```ts
protected get id(): string
```

Returns the current actor ID inside an actor method or lifecycle hook. It is unavailable before the runtime binds the actor, including during its constructor. It is not an application state field.

## Actor references

### `Actor.get(id)`

```ts
const counter = Counter.get("account-1")
const count = await counter.increment(2)
```

`get(id: string)` is synchronous and returns a typed reference. Creating a reference does not make a remote call. The first operation starts the actor if needed.

The reference exposes the class's asynchronous application methods, plus `connect(metadata)` and `broadcast(message)`. It does not expose saved fields or lifecycle hooks. To read saved state through a method, define a method such as `read()`.

Calls to the same actor execute one at a time, including across `await` within a method. Successful calls save state. Separate actors have independent state and may execute concurrently. Concurrent requests are serialized, but callers should not rely on their launch order being the execution order.

Actor-to-actor remote calls, connections, and broadcasts are not supported from inside actor invocations. Coordinate multiple actors from application code. Await work that affects an invocation; background work is not a durable job mechanism.

### `reference.connect(metadata)`

```ts
const socket = await ChatRoom.get("lobby").connect({ userId: "alice" })
socket.addEventListener("message", ({ data }) => console.log(String(data)))
socket.send("hello")
```

Returns `Promise<ActorConnection>`. The metadata argument is required and must be JSON-serializable; use `{}` when no metadata is needed. When the actor declares `onConnect(socket: ActorSocket<Session>)`, the reference infers `Session` as the metadata type. Other lifecycle hooks alone do not establish that inferred type.

The promise resolves when the WebSocket opens and initialization is sent. The actor's `onConnect` hook and initial state delivery may still be pending. Install message and close listeners immediately after awaiting `connect()`. A hook can still reject an already opened connection.

### `reference.broadcast(message)`

```ts
await ChatRoom.get("lobby").broadcast("Deployment completed")
```

Accepts `ActorSocketMessage` and returns `Promise<void>`. Sends transient output to the actor's currently connected clients. It does not execute an actor method, append to actor state, or retain the message for future connections. It takes no recipient-filter options. With no connected clients, there is nothing to deliver.

To save and broadcast a message together, call an actor method that updates a field and uses `this.broadcast()`.

## Saved state and serialization

The runtime saves the actor's own enumerable string-keyed properties after successful invocations and lifecycle events. Constructors and field initializers create the initial state for a new actor. Ordinary TypeScript `private` fields are still enumerable JavaScript fields; JavaScript `#private` fields, symbols, and non-enumerable properties are not saved.

On restoration, saved fields replace initialized enumerable fields. New field initializers are **not merged into existing saved state**. If you add a field in a later deployment, initialize missing values in your methods, for example `this.history ??= []`.

Arguments, results, metadata, and state use JSON serialization:

| Value                                                            | Serialization behavior                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Strings, booleans, finite numbers, `null`, arrays, plain objects | Preserved as JSON values.                                                                                    |
| `Date`                                                           | Becomes its JSON string representation.                                                                      |
| `undefined`, functions, symbols in object properties             | Omitted.                                                                                                     |
| `undefined`, functions, symbols in arrays                        | Become `null`.                                                                                               |
| `NaN`, positive or negative infinity                             | Become `null`.                                                                                               |
| `BigInt` or circular references                                  | Fail serialization.                                                                                          |
| `Map`, `Set`, custom classes                                     | Do not retain their prototypes or methods; serialize according to their enumerable properties or `toJSON()`. |

A method returning `undefined` produces `null` at runtime. TypeScript return annotations do not change JSON behavior. Prefer explicit JSON-shaped values for durable data; use the binary WebSocket API for binary messages.

When an actor method throws, its state changes are not saved. External effects such as HTTP requests and already sent WebSocket messages cannot be rolled back. Socket output may arrive before state is committed, so receiving a broadcast alone does not confirm persistence.

Successful connections automatically receive the actor's saved properties. Do not store secrets in an actor whose state is exposed to clients that should not receive them.

## WebSocket lifecycle

All hooks are optional and must be asynchronous. Connections can remain open while an actor hibernates; incoming activity wakes it as needed.

```ts
import { Actor } from "little-durable-objects"
import type { ActorSocket, ActorSocketMessage } from "little-durable-objects"

interface Session {
    userId: string
}

export class ChatRoom extends Actor {
    history: string[] = []

    async onConnect(socket: ActorSocket<Session>): Promise<void> {
        socket.setTags(socket.metadata.userId)
    }

    async onMessage(socket: ActorSocket<Session>, message: ActorSocketMessage): Promise<void> {
        if (typeof message !== "string") return
        this.history.push(message)
        this.broadcast(message)
    }

    async onDisconnect(socket: ActorSocket<Session>, code: number, reason: string, wasClean: boolean): Promise<void> {
        console.log(socket.metadata.userId, code, reason, wasClean)
    }
}
```

### `onConnect(socket)`

Runs when a new connection is initialized. The socket's state is `"connecting"`. No explicit accept call is needed. To reject it, call `socket.reject(4003, "Access denied")` and return.

After a successful, non-rejected connection, the runtime sends:

```json
{ "type": "state", "state": { "history": [] } }
```

The state reflects any changes made by `onConnect`. Messages sent with `socket.send()` during that hook precede the automatic state message. Existing connections can receive broadcasts during the hook; the joining connection is not yet a broadcast recipient. Use `socket.send()` to address it directly.

### `onMessage(socket, message)`

Runs for incoming text and binary messages. Text is a `string`; binary is a `Uint8Array`. The runtime does not JSON-parse application messages. The socket's state is `"open"`.

### `onDisconnect(socket, code, reason, wasClean)`

Runs when the server observes a connection closing. The socket has state `"closed"` and is absent from `this.connections`. `code` is the observed WebSocket close code, `reason` is the close text, and `wasClean` indicates whether a clean close was observed. Do not send through the closed socket.

An abrupt server failure may prevent a disconnect hook from running. Clients must reconnect after a gateway restart. Connection metadata and tags last for that connection; they are not restored as a new connection after a server restart.

## Actor socket methods

### `this.connections`

```ts
protected get connections(): readonly ActorSocket[]
```

Lists the connections available during the invocation. During `onConnect`, it includes the connecting socket. During `onDisconnect`, it excludes the disconnected socket. Use it only inside an actor method or hook; retain application data in state rather than storing socket objects.

### `this.broadcast(message, options?)`

```ts
protected broadcast(message: ActorSocketMessage, options?: ActorBroadcastOptions): void
```

Sends to all currently open connections by default, including the sender when called from `onMessage`.

| Option   | Type                                    | Behavior                                                                                      |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `except` | `ActorSocket \| readonly ActorSocket[]` | Omit these connections.                                                                       |
| `tags`   | `readonly string[]`                     | Deliver only to connections having **all** listed tags. Omitted or empty means no tag filter. |

```ts
this.broadcast("hello", { except: socket })
this.broadcast("update", { tags: ["editors", "document-1"] })
```

Returns `void`; there is no delivery acknowledgment from recipients. A filter and exclusions can be combined.

### `ActorSocket<Metadata>`

The metadata type defaults to JSON-compatible values. Supply a type parameter to describe your connection metadata.

| Member                   | Type                           | Behavior                                                                                         |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `id`                     | Readonly `string`              | Unique connection ID.                                                                            |
| `metadata`               | `Metadata`                     | JSON metadata supplied at connection time; replaceable by the actor.                             |
| `tags`                   | Readonly array of strings      | Current connection tags. Change them with `setTags()`.                                           |
| `state`                  | `ActorSocketState`             | `"connecting"`, `"open"`, or `"closed"`.                                                         |
| `send(message)`          | `(ActorSocketMessage) => void` | Send to this connection; throws if the socket is closed.                                         |
| `setTags(...tags)`       | `(...string[]) => void`        | Replace tags, removing duplicates. No arguments clears them.                                     |
| `close(code?, reason?)`  | `(number?, string?) => void`   | Close the connection; defaults to `1000` and `""`. Repeated calls on a closed socket do nothing. |
| `reject(code?, reason?)` | `(number?, string?) => void`   | Reject only during `onConnect`; suppresses automatic state delivery.                             |

To update metadata, assign the entire value so the change is retained for later events:

```ts
socket.metadata = { ...socket.metadata, userId: "bob" }
socket.setTags("editors", "document-1")
socket.send("You joined document-1")
socket.close(1000, "Done")
```

Mutating a nested metadata property alone does not publish an update. Metadata is supplied by the caller on trusted SDK connections; validate it when it affects application permissions.

`close` and `reject` accept code `1000` or an integer from `3000` through `4999`, with a reason of at most 123 UTF-8 bytes. **Current `reject()` caveat:** its default code is `1008`, which fails the current SDK's close-code validation. Pass an explicit accepted application code, such as `socket.reject(4003, "Access denied")`. The default rejection reason is `"connection rejected"`.

## Client connections

`ActorConnection` exposes these members:

```ts
readonly readyState: number
send(data: string | ArrayBufferLike | ArrayBufferView): void
close(code?: number, reason?: string): void
addEventListener(type, listener): void
removeEventListener(type, listener): void
```

`readyState` uses WebSocket values: `0` connecting, `1` open, `2` closing, and `3` closed. Send strings as text and buffers or typed-array views as binary. Wait until the connection is open before sending. The returned connection is already open when `connect()` resolves.

| Event     | Event fields                                                           | Meaning                                                                        |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `open`    | `type: "open"`                                                         | Connection opened. This normally occurs before the SDK returns the connection. |
| `message` | `type: "message"`, `data: string \| Uint8Array \| ArrayBuffer`         | Initial state or actor-sent application data.                                  |
| `close`   | `type: "close"`, `code: number`, `reason: string`, `wasClean: boolean` | Connection closed.                                                             |
| `error`   | `type: "error"`                                                        | Connection error; this public event type contains no message field.            |

Register listeners with `addEventListener`; remove one by passing the same event name and function to `removeEventListener`. The public interface does not provide listener options, automatic reconnect, or automatic message replay. A reconnect is a new `connect()` call with fresh metadata; the automatic state message lets your application restore its view.

The SDK handles initialization and bearer authentication. Your application handles message encoding, validation, display, and any replay beyond the saved state. Use `ActorConnection.close()` to close a client; the actor-side `reject()` method is not part of this interface.

## Errors and retries

### `ActorInvocationError`

```ts
new ActorInvocationError(code: string, requestId: string, message: string)
```

Extends `Error`. Its `name` is `"ActorInvocationError"`; `code` and `requestId` are readonly strings. `message` describes the failure.

```ts
try {
    await counter.increment()
} catch (error) {
    if (error instanceof ActorInvocationError) {
        console.error(error.code, error.requestId, error.message)
    }
    throw error
}
```

| Code                                      | Meaning and response                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `unauthenticated`                         | The session token was rejected or does not permit the requested access. Obtain appropriate credentials.                |
| `actor_error`                             | Actor execution failed, including user exceptions or invalid output. Inspect the message and fix the actor or request. |
| `resource_exhausted`                      | An execution resource limit was reached. Reduce the workload or resource use.                                          |
| `unavailable`                             | The actor could not be reached or made available. Investigate service availability.                                    |
| `outcome_unknown`                         | The caller could not confirm the result. The operation may have run and saved state.                                   |
| `invalid_request`, `conflict`, `internal` | Server-reported request, deployment, or service failure. Inspect the message.                                          |

The code is an open string, not a closed enum. Handle unknown codes. Authentication failures from HTTP status `401` or `403` during method calls are reported by the SDK as `unauthenticated`.

The SDK can recover from a changed actor location, but application operations are not automatically made idempotent. A request ID identifies a caller attempt; it is not an application idempotency key. For operations that cannot safely run twice, store a caller-supplied operation ID and its result in actor state before retrying an uncertain outcome.

Validation, actor definition, configuration, serialization, and socket errors can be ordinary `Error` instances. Only `ActorInvocationError` is exported as an application error class. Do not assume every failure supports `code` or `requestId`. A failed WebSocket opening rejects `connect()`; failures after opening arrive through connection events.

## Limits

These are the implemented limits; they are not a promise that every near-limit combination of state, arguments, and messages will fit into one request.

| Item                                     | Limit                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Connections per actor                    | 128 per gateway process.                                                                               |
| WebSocket text message or frame          | 16 MiB.                                                                                                |
| WebSocket binary message or frame        | 16 MiB of decoded data.                                                                                |
| Connection metadata                      | 64 KiB of JSON-encoded UTF-8.                                                                          |
| Tags per connection                      | 128 unique tags.                                                                                       |
| Length of one tag                        | 1–256 JavaScript string code units in the SDK.                                                         |
| Total tag text per connection            | 8 KiB of UTF-8.                                                                                        |
| Broadcast exclusions                     | 128 connections.                                                                                       |
| Actor-side close reason                  | 123 UTF-8 bytes.                                                                                       |
| Pending actor socket output              | Up to 512 queued operations or 24 MiB of serialized queued output; exceeding this fails the operation. |
| Management JSON request body             | 16 MiB.                                                                                                |
| External authorization callback response | 128 KiB.                                                                                               |

Saved actor state has a 16 MiB JSON-encoded limit. Method requests and responses must fit within 32 MiB, including encoded state, arguments or results, and message overhead. Keep state bounded, especially if every connection receives it as an initial state message. Broadcasts and connection metadata are transient unless you explicitly copy application data into saved fields.

## HTTP authentication

Use your configured server origin as the base URL. JSON requests use `Content-Type: application/json`. Administrative operations require:

```http
Authorization: Bearer <admin-api-key>
```

The admin key is the server's `DURABLE_OBJECT_API_KEY`. It can register and remove deployments and issue namespace-wide session tokens. Use it only on your trusted backend. Application connections use session tokens or external socket credentials instead.

| Operation                           | Method and path                                                           | Credential                               |
| ----------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| Register or replace deployment      | `PUT /v1/namespaces/{namespaceId}/deployment`                             | Admin API key.                           |
| Read deployment                     | `GET /v1/namespaces/{namespaceId}/deployment`                             | Admin API key.                           |
| Remove deployment                   | `DELETE /v1/namespaces/{namespaceId}/deployment`                          | Admin API key.                           |
| Issue session token                 | `POST /v1/namespaces/{namespaceId}/session-scoped-token`                  | Admin API key.                           |
| Read public signing keys            | `GET /.well-known/jwks.json`                                              | None.                                    |
| Connect with a session token        | `GET /v1/namespaces/{namespaceId}/actors/{actorType}/{actorId}/websocket` | Session bearer token; WebSocket upgrade. |
| Connect with an external credential | `GET /v1/socket/{triggerId}/{actorId}`                                    | External credential; WebSocket upgrade.  |

Call actor methods and send application broadcasts through the SDK described above.

## Deployments

### Register or replace

```http
PUT /v1/namespaces/{namespaceId}/deployment
```

Registers actor code for a namespace, creating the namespace if needed. There is one active deployment per namespace. Supply a complete deployment specification; this is replacement, not a partial update.

```json
{
    "codeRevision": "chat-v1",
    "imageRef": "im-your-actor-image",
    "workingDirectory": "/workspace",
    "actorEntrypoint": "src/durable-objects.ts",
    "secretRefs": [],
    "socketGatewayUrl": null,
    "warmRegion": "north-america-east"
}
```

| Field              | Required / default | Meaning and validation                                                                                                                                                                                     |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codeRevision`     | Required           | Revision label, 1–128 ASCII letters, digits, `.`, `_`, or `-`. Use a new label for changed code.                                                                                                           |
| `imageRef`         | Required           | Provider image reference containing the actor project; 1–255 bytes. Registration does not upload or build the image.                                                                                       |
| `workingDirectory` | Required           | Absolute project path inside the image, at most 1024 bytes.                                                                                                                                                |
| `actorEntrypoint`  | Optional, `null`   | Source or compiled actor file, 1–1024 bytes when supplied. Relative paths resolve from the working directory. Without it, prefer `dist/durable-objects.js` if present, otherwise `src/durable-objects.ts`. |
| `secretRefs`       | Optional, `[]`     | Up to 16 provider secret names. Each contains 1–255 ASCII letters, digits, `.`, `_`, or `-`.                                                                                                               |
| `socketGatewayUrl` | Optional, `null`   | Separate HTTP(S) origin for socket delivery. No path beyond `/`, credentials, query, or fragment. Configure clients' gateway origin to match.                                                              |
| `warmRegion`       | Optional, `null`   | Configured storage region in which to request background image warmup. Not retained in the deployment record.                                                                                              |

Success is `200 OK`:

```json
{ "changed": true }
```

An identical deployment returns `{"changed":false}`. Changing the specification stops its previous cloud hosts before registering the replacement. Saved actor state remains, so new code must support existing state. This is not a zero-downtime rollout guarantee.

Warmup is asynchronous and does not guarantee an already running actor. Invalid or unconfigured warmup regions are skipped; warmup failures are logged without turning a successful registration into a failed response.

### Read

```http
GET /v1/namespaces/{namespaceId}/deployment
```

Returns `200 OK` with the stored specification, including `namespaceId`:

```json
{
    "namespaceId": "chat-project",
    "codeRevision": "chat-v1",
    "imageRef": "im-your-actor-image",
    "workingDirectory": "/workspace",
    "actorEntrypoint": "src/durable-objects.ts",
    "secretRefs": [],
    "socketGatewayUrl": null
}
```

If no deployment exists, the response is JSON `null`, not `404`.

### Remove

```http
DELETE /v1/namespaces/{namespaceId}/deployment
```

Stops the deployment's cloud hosts and removes the active deployment registration. Returns `200 OK` with `{"changed":true}`, or `{"changed":false}` if no deployment existed. It does not delete saved actor state or the namespace. New session tokens cannot be issued until actor code is registered again.

There is no public actor-state deletion, actor-listing, or individual actor reset API. Expose application-specific reset behavior as an actor method if needed.

## Session tokens

```http
POST /v1/namespaces/{namespaceId}/session-scoped-token
```

Requires a registered deployment and the admin API key.

| Request field    | Type    | Validation                                                                                    |
| ---------------- | ------- | --------------------------------------------------------------------------------------------- |
| `executionId`    | String  | Required, 1–255 bytes; identifies the application execution requesting access.                |
| `deadlineUnixMs` | Integer | Required future Unix timestamp in milliseconds.                                               |
| `storageRegion`  | String  | Required, 1–64 lowercase ASCII letters, digits, `.`, `_`, or `-`. See region selection below. |

For example, from a trusted Node.js backend:

```ts
const response = await fetch(`${process.env.DURABLE_OBJECT_CONTROL_PLANE_URL}/v1/namespaces/chat-project/session-scoped-token`, {
    method: "POST",
    headers: {
        authorization: `Bearer ${process.env.DURABLE_OBJECT_API_KEY}`,
        "content-type": "application/json"
    },
    body: JSON.stringify({
        executionId: "chat-session-1",
        deadlineUnixMs: Date.now() + 3_600_000,
        storageRegion: "north-america-east"
    })
})
if (!response.ok) throw new Error(await response.text())
const { token, expiresAtMs } = await response.json()
```

Success is `200 OK`:

```json
{ "token": "<signed-session-token>", "expiresAtMs": 1800000000000 }
```

Expiration is the earliest of the requested deadline plus 30 seconds, issuance time plus the configured maximum token lifetime, and issuance time plus 24 hours. It is rounded down to whole seconds and returned as milliseconds in `expiresAtMs`. Use the returned expiration instead of calculating it yourself.

The token permits application actor operations within the requested namespace; it does not restrict access to a single class, actor, or method. It is not an admin key. There is no refresh endpoint: have your trusted backend issue a new token when needed. Missing deployment returns `409 Conflict`; invalid fields or an expired deadline return `400 Bad Request`.

## Storage regions

Existing actors retain their selected region. For a new actor, the requested region is used if it exactly matches a configured bucket-map key. Otherwise the server maps known cloud region names to these region groups:

| Group                   | Recognized aliases                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `north-america-east`    | `us-east-1`, `us-east-2`, `us-east1`, `us-east4`, `us-east5`, `us-ashburn-1`, `eastus`, `eastus2`                                                         |
| `north-america-central` | `us-central1`, `us-chicago-1`, `centralus`, `northcentralus`                                                                                              |
| `north-america-south`   | `us-south1`, `southcentralus`                                                                                                                             |
| `north-america-west`    | `us-west-1`, `us-west-2`, `us-west1`, `us-west2`, `us-west3`, `us-west4`, `us-phoenix-1`, `us-sanjose-1`, `westus`, `westus2`, `westus3`, `westcentralus` |
| `europe-west`           | `eu-west-1`, `eu-west-3`, `eu-central-1`, `europe-west1`, `europe-west3`, `europe-west4`, `eu-frankfurt-1`, `eu-paris-1`, `westeurope`                    |
| `asia-southeast`        | `ap-southeast-1`, `asia-southeast1`, `asia-southeast2`, `ap-singapore-1`, `southeastasia`                                                                 |

The listed GCP-style regions also accept zone suffixes `-a`, `-b`, `-c`, `-d`, and `-f`, such as `us-central1-a`.

If the requested or mapped region has no configured bucket, the server uses `north-america-central` if configured; otherwise actor startup fails. A configured fallback can also be used when initial host provisioning fails in another region. Issuing a token validates the region string's syntax; it does not prove that an actor can start there.

## Public signing keys

```http
GET /.well-known/jwks.json
```

Returns `200 OK` with a JSON Web Key Set containing the server's public signing key. Authentication is not required. Private signing material is never included. Consumers validating tokens must also check the expected issuer, audience, scope, and expiration.

## Direct WebSocket connections

### Session-token connections

Connect to:

```text
wss://objects.example.com/v1/namespaces/{namespaceId}/actors/{actorType}/{actorId}/websocket
```

Send `Authorization: Bearer <session-token>` with the upgrade request. Use `ws://` for a local HTTP server. The token must permit the path's namespace.

Within 10 seconds of opening, send this as the first text frame:

```json
{ "type": "initialize", "metadata": { "userId": "alice" } }
```

The initialization document may be at most 64 KiB plus 128 bytes, and its metadata must fit the 64 KiB metadata limit. After initialization, application text and binary frames go to `onMessage`. The runtime sends the automatic state message after successful acceptance. Subsequent outgoing application messages have the format chosen by your actor.

The SDK performs this handshake for `reference.connect()`. The browser WebSocket API cannot set the required Authorization header; use the external route below for browser connections.

### External connections

Requires the server's `DURABLE_OBJECT_SOCKET_AUTH_URL` callback to be configured. Connect to:

```text
wss://objects.example.com/v1/socket/{triggerId}/{actorId}
```

Supply either `Authorization: Bearer <credential>` or the WebSocket subprotocols `terse-do` and `terse-ticket.<credential>`. A bearer header takes precedence. Browser example:

```js
const socket = new WebSocket("wss://objects.example.com/v1/socket/chat/lobby", ["terse-do", `terse-ticket.${credential}`])
socket.addEventListener("message", ({ data }) => console.log(data))
```

`credential` is an application-issued credential accepted by your authorization callback and must be valid inside a WebSocket subprotocol token. The runtime does not provide an external-ticket issuance endpoint. The accepted subprotocol is `terse-do`.

The callback selects the namespace, actor class, region, metadata, and credential expiration. It must preserve the requested actor ID. There is no client initialization frame on this route: the callback supplies metadata. Sending an initialization document here would be an application message.

### Close behavior

| Code          | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `1000`        | Normal closure.                                                        |
| `1002`        | Missing or invalid initialization on the session-token route.          |
| `1006`        | An observed abnormal disconnect; not a close frame sent by the server. |
| `1011`        | Connection handling or an actor socket handler failed.                 |
| `1013`        | Actor connection limit reached.                                        |
| `3000`–`4999` | Application close or rejection codes chosen by the actor.              |

These are common runtime outcomes; WebSocket protocol and size failures may produce other standard codes. Receiving output is not an acknowledgment that a message was saved. The runtime does not replay transient broadcasts on reconnect.

## WebSocket callbacks

Both optional callbacks are configured on the self-hosted server. The server makes JSON `POST` requests with `Authorization: Bearer <DURABLE_OBJECT_API_KEY>`. Authenticate this header at the callback endpoint. Plain local `dev` does not enable these callbacks.

### External authorization

Set `DURABLE_OBJECT_SOCKET_AUTH_URL` to your authorization endpoint. For an external upgrade, the request is:

```json
{ "triggerId": "chat", "actorId": "lobby", "credential": "<external-credential>" }
```

Return a successful HTTP status and JSON:

```json
{
    "namespaceId": "chat-project",
    "actorType": "ChatRoom",
    "actorId": "lobby",
    "storageRegion": "north-america-east",
    "metadata": { "userId": "alice" },
    "expiresAt": 1800000000
}
```

All fields are required. Actor identity must pass the normal identity limits, `actorId` must match the request, `storageRegion` must be nonempty, and metadata must fit 64 KiB. `expiresAt` is a future Unix timestamp in **seconds**, unlike `expiresAtMs` on the session-token API. The entire response must fit 128 KiB. The authorization request has a 30-second timeout.

Return `401`, `403`, or `404` to reject the credential; the upgrade returns `401`. Other callback failures, invalid responses, missing callback configuration, or timeouts cause a `503` upgrade response. The callback runs when the connection is authorized; it is not a per-message refresh mechanism.

### Incoming message events

Set `DURABLE_OBJECT_SOCKET_EVENT_URL` to receive messages after successful actor handling:

```json
{
    "eventId": "<event-id>",
    "namespaceId": "chat-project",
    "actorType": "ChatRoom",
    "actorId": "lobby",
    "triggerId": "chat",
    "connectionId": "<connection-id>",
    "message": { "type": "text", "data": "hello" }
}
```

`eventId` identifies this event. `triggerId` is the external route's trigger ID, or `null` for a session-token connection. Binary messages use `{"type":"binary","data":"<base64>"}`. Events cover successfully handled incoming messages, not connection changes or outgoing broadcasts.

Return a successful HTTP status; no response body is required. Delivery is asynchronous and best effort, with no automatic retry or durable delivery guarantee. A callback failure is logged and does not undo the actor's completed message handling.

## HTTP errors

Management API handler errors have this shape:

```json
{ "error": { "code": "invalid_request", "message": "workflow deadline must be in the future" } }
```

| HTTP status | Error code        | Meaning                                           |
| ----------- | ----------------- | ------------------------------------------------- |
| `400`       | `invalid_request` | Invalid deployment or token request.              |
| `401`       | `unauthenticated` | Missing or rejected admin credential.             |
| `403`       | `forbidden`       | Credential does not permit the operation.         |
| `409`       | `conflict`        | No registered actor code for token issuance.      |
| `500`       | `internal`        | Server failure.                                   |
| `503`       | `unavailable`     | Service could not satisfy an application request. |

Malformed JSON, missing required fields, unsupported content types, oversized bodies, unknown routes, and invalid upgrade requests may be rejected before the handler. Such responses need not use the JSON error envelope; inspect the status and content type before parsing. Oversized management bodies are rejected with `413`.

WebSocket upgrade errors use a plain-text body. Common statuses are `400` for an invalid request, `401` for missing or rejected credentials, `403` for incorrect namespace access, and `503` for unavailable external authorization. After a successful upgrade, handle WebSocket events and close frames instead of HTTP errors.
