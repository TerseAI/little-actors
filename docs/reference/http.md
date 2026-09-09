# HTTP and WebSocket reference

This page documents deployment management, session tokens, direct WebSocket connections, and application callbacks. Use the [TypeScript API](api.md) for actor methods and the [self-hosting guide](../guides/self-hosting.md) to configure a server.

- [Authentication](#authentication)
- [Deployments](#deployments)
- [Session tokens](#session-tokens)
- [Storage regions](#storage-regions)
- [Public signing keys](#public-signing-keys)
- [Direct WebSocket connections](#direct-websocket-connections)
- [WebSocket callbacks](#websocket-callbacks)
- [HTTP errors](#http-errors)

## Authentication

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

Call actor methods and send application broadcasts through the [TypeScript SDK](api.md). Management JSON request bodies are limited to 16 MiB; larger bodies receive `413`.

Path parameters `namespaceId`, `actorType`, and `actorId` follow the [actor identity limits](api.md#identity).

## Deployments

All three operations require the admin API key. `namespaceId` is the namespace whose active deployment is being managed.

### PUT /v1/namespaces/{namespaceId}/deployment

Registers actor code for a namespace, creating the namespace if needed. There is one active deployment per namespace. The JSON request replaces the complete deployment specification.

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

**JSON parameters**

- `codeRevision` (`string`, required) — Revision label, 1–128 ASCII letters, digits, `.`, `_`, or `-`. Use a new label for changed code.
- `imageRef` (`string`, required) — Provider image reference containing the actor project, 1–255 bytes. Registration does not upload or build the image.
- `workingDirectory` (`string`, required) — Absolute project path inside the image, at most 1024 bytes.
- `actorEntrypoint` (`string | null`, default `null`) — Source or compiled actor file, 1–1024 bytes when supplied. Relative paths resolve from the working directory. When omitted, the server uses `dist/durable-objects.js` if present, otherwise `src/durable-objects.ts`.
- `secretRefs` (`string[]`, default `[]`) — Up to 16 provider secret names. Each contains 1–255 ASCII letters, digits, `.`, `_`, or `-`.
- `socketGatewayUrl` (`string | null`, default `null`) — Separate HTTP(S) origin for socket delivery. No path beyond `/`, credentials, query, or fragment. Configure clients' gateway origin to match.
- `warmRegion` (`string | null`, default `null`) — Configured storage region in which to request background image warmup. It is not retained in the deployment record.

**Response:** `200 OK` with JSON:

```json
{ "changed": true }
```

An identical deployment returns `{"changed":false}`. Changing the specification stops its previous cloud hosts before registering the replacement. Saved actor state remains, so new code must support existing state. This is not a zero-downtime rollout guarantee.

**Errors:** `400` for an invalid specification and `401` for a rejected admin credential. See [HTTP errors](#http-errors) for shared failure responses.

Warmup is asynchronous and does not guarantee an already running actor. Invalid or unconfigured warmup regions are skipped; warmup failures are logged without turning a successful registration into a failed response.

### GET /v1/namespaces/{namespaceId}/deployment

Reads the active deployment.

**Response:** `200 OK` with the stored specification, including `namespaceId`:

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

If no deployment exists, the response is JSON `null`. The record omits `warmRegion`.

**Errors:** `401` for a rejected admin credential; `500` if the deployment cannot be read.

### DELETE /v1/namespaces/{namespaceId}/deployment

Stops the deployment's cloud hosts and removes the active deployment registration.

**Response:** `200 OK` with `{"changed":true}`, or `{"changed":false}` if no deployment existed. It does not delete saved actor state or the namespace. New session tokens cannot be issued until actor code is registered again.

**Errors:** `401` for a rejected admin credential; `500` if removal fails.

There is no public actor-state deletion, actor-listing, or individual actor reset API. Expose application-specific reset behavior as an actor method if needed.

## Session tokens

### POST /v1/namespaces/{namespaceId}/session-scoped-token

Requires a registered deployment and the admin API key.

**JSON parameters**

- `executionId` (`string`, required) — Application execution requesting access, 1–255 bytes.
- `deadlineUnixMs` (`integer`, required) — Future Unix timestamp in milliseconds.
- `storageRegion` (`string`, required) — 1–64 lowercase ASCII letters, digits, `.`, `_`, or `-`. See [storage regions](#storage-regions) for selection behavior.

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

**Response:** `200 OK` with JSON:

```json
{ "token": "<signed-session-token>", "expiresAtMs": 1800000000000 }
```

Expiration is the earliest of the requested deadline plus 30 seconds, issuance time plus the configured maximum token lifetime, and issuance time plus 24 hours. It is rounded down to whole seconds and returned as milliseconds in `expiresAtMs`. Use the returned expiration instead of calculating it yourself.

The token permits application actor operations within the requested namespace; it does not restrict access to a single class, actor, or method. It is not an admin key. There is no refresh endpoint: have your trusted backend issue a new token when needed.

**Errors:** `409` for a missing deployment, `400` for invalid fields or an expired deadline, and `401` for a rejected admin credential.

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

### GET /.well-known/jwks.json

**Response:** `200 OK` with a JSON Web Key Set containing the server's public signing key. Authentication is not required. Private signing material is never included. Consumers validating tokens must also check the expected issuer, audience, scope, and expiration.

## Direct WebSocket connections

### Session-token connections

```http
GET /v1/namespaces/{namespaceId}/actors/{actorType}/{actorId}/websocket
```

Upgrades to a WebSocket connection (`101 Switching Protocols`). Connect to:

```text
wss://objects.example.com/v1/namespaces/{namespaceId}/actors/{actorType}/{actorId}/websocket
```

Send `Authorization: Bearer <session-token>` with the upgrade request. Use `ws://` for a local HTTP server. The token must permit the path's namespace.

Within 10 seconds of opening, send this as the first text frame:

```json
{ "type": "initialize", "metadata": { "userId": "alice" } }
```

The initialization document may be at most 64 KiB plus 128 bytes, and its metadata must fit the 64 KiB metadata limit. After initialization, send application JSON in text frames. The TypeScript runtime parses and validates each message before calling [`onMessage`](api.md#actoronmessage). It sends the automatic state message after successful acceptance. Outgoing application messages are also JSON text frames.

The SDK performs this handshake for [`reference.connect()`](api.md#referenceconnect). The browser WebSocket API cannot set the required Authorization header; use the external route below for browser connections.

### External connections

```http
GET /v1/socket/{triggerId}/{actorId}
```

Upgrades to a WebSocket connection (`101 Switching Protocols`). `triggerId` identifies the application trigger passed to your authorization callback; `actorId` identifies the requested actor.

Requires the server's `DURABLE_OBJECT_SOCKET_AUTH_URL` callback to be configured. Connect to:

```text
wss://objects.example.com/v1/socket/{triggerId}/{actorId}
```

Supply either `Authorization: Bearer <credential>` or the WebSocket subprotocols `terse-do` and `terse-ticket.<credential>`. A bearer header takes precedence. Browser example:

```js
const socket = new WebSocket("wss://objects.example.com/v1/socket/chat/lobby", ["terse-do", `terse-ticket.${credential}`])
socket.addEventListener("message", ({ data }) => console.log(JSON.parse(data)))
socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "post", text: "Hello" })))
```

`credential` is an application-issued credential accepted by your authorization callback and must be valid inside a WebSocket subprotocol token. The runtime does not provide an external-ticket issuance endpoint. The accepted subprotocol is `terse-do`.

Native WebSocket clients encode and decode JSON themselves. The `little-actors` SDK handles this automatically for `reference.connect()` connections.

The callback selects the namespace, actor class, region, metadata, and credential expiration. It must preserve the requested actor ID. There is no client initialization frame on this route: the callback supplies metadata. Sending an initialization document here would be an application message.

### Message limits

Each actor supports up to 128 connections per gateway process. Application messages must be JSON text and fit 16 MiB of UTF-8, including JSON encoding overhead. The TypeScript SDK rejects binary application messages. Connection metadata is limited to 64 KiB of JSON-encoded UTF-8.

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

Both optional callbacks are configured on the [self-hosted server](../guides/self-hosting.md#server-configuration). The server makes JSON `POST` requests with `Authorization: Bearer <DURABLE_OBJECT_API_KEY>`. Authenticate this header at the callback endpoint. Plain local `dev` does not enable these callbacks.

### External authorization

Set `DURABLE_OBJECT_SOCKET_AUTH_URL` to your authorization endpoint. For an external upgrade, the JSON request contains these required strings:

- `triggerId` — Trigger from the connection URL.
- `actorId` — Actor ID from the connection URL.
- `credential` — Credential supplied by the client.

**Request:**

```json
{ "triggerId": "chat", "actorId": "lobby", "credential": "<external-credential>" }
```

**Response:** A successful HTTP status with JSON:

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

**Response fields** (all required)

- `namespaceId` (`string`) — Namespace containing the actor deployment.
- `actorType` (`string`) — Exported actor class name.
- `actorId` (`string`) — Must match the requested actor ID.
- `storageRegion` (`string`) — Nonempty region selection for new actors.
- `metadata` (JSON value) — Connection metadata, at most 64 KiB.
- `expiresAt` (`integer`) — Future Unix timestamp in **seconds**, unlike `expiresAtMs` on the session-token API.

Actor identity must pass the [identity limits](api.md#identity). The entire response must fit 128 KiB. The authorization request has a 30-second timeout.

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
    "message": { "type": "text", "data": "{\"type\":\"post\",\"text\":\"Hello\"}" }
}
```

**Request fields** (all present)

- `eventId` (`string`) — Unique event ID.
- `namespaceId` (`string`), `actorType` (`string`), `actorId` (`string`) — Actor that handled the message.
- `triggerId` (`string | null`) — External route's trigger ID, or `null` for a session-token connection.
- `connectionId` (`string`) — Connection that sent the message.
- `message` (`object`) — The transport envelope `{"type":"text","data":"<JSON text>"}`. Parse `message.data` to read the application value. The transport also defines a binary envelope, but the TypeScript actor runtime rejects binary application messages.

Events cover successfully handled incoming messages. Connection changes and outgoing broadcasts do not produce events.

**Response:** A successful HTTP status; no response body is required. Delivery is asynchronous and best effort, with no automatic retry or durable delivery guarantee. A callback failure is logged and does not undo the actor's completed message handling.

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
