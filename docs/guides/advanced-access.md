# Advanced access configuration

The [browser demo](../../examples/chat/README.md) uses an authenticated application proxy. A [hosted backend](self-hosting.md) needs an API key and server URL. Use the options below when an integration needs separate actor groups or delegated access.

## Explicit namespaces

A namespace groups actor deployments and saved state. Default routes use the `default` namespace on a hosted server and `local` in development. Keeping those identities stable preserves state across restarts and deployments.

To manage another namespace, use the namespaced deployment route:

```text
PUT /v1/namespaces/{namespaceId}/deployment
```

It accepts the same API key and request body as [`PUT /v1/deployment`](../reference/http.md#put-v1deployment). Set `DURABLE_OBJECT_NAMESPACE_ID` on a backend client to select that namespace explicitly. An existing application can keep its namespace to retain access to its saved state.

The server API key can access every namespace on that server. Use separate server installations or delegated session credentials when callers need different access. Namespace names alone do not authenticate a caller.

## Delegated sessions

A trusted backend can issue a session token for a worker or customer-provided code. The worker receives application access for a limited time without receiving the backend API key.

```text
Trusted backend                  Customer worker               Actor service
  holds API key
       |                               |                            |
       | request token for execution   |                            |
       |----------------------------------------------------------->|
       | token + expiration            |                            |
       |<-----------------------------------------------------------|
       | pass token and server URL     |                            |
       |------------------------------>|                            |
       |                               | actor calls using token    |
       |                               |--------------------------->|
```

For the default deployment, issue a token with a one-hour execution deadline:

```sh
SESSION_DEADLINE_MS="$(node -p 'Date.now() + 60 * 60 * 1000')"

curl --fail --silent --show-error \
    -X POST "$DURABLE_OBJECT_CONTROL_PLANE_URL/v1/session-scoped-token" \
    -H "Authorization: Bearer $DURABLE_OBJECT_API_KEY" \
    -H 'Content-Type: application/json' \
    --data @- <<EOF
{
    "executionId": "worker-1",
    "deadlineUnixMs": $SESSION_DEADLINE_MS,
    "storageRegion": "north-america-east"
}
EOF
```

To delegate a specific namespace, use `/v1/namespaces/{namespaceId}/session-scoped-token` instead. That namespace must already have a registered deployment.

Pass the response's `token` and the server URL to the worker:

```sh
export DURABLE_OBJECT_TOKEN='<the-token-from-the-response>'
export DURABLE_OBJECT_CONTROL_PLANE_URL='https://objects.example.com'
unset DURABLE_OBJECT_API_KEY DURABLE_OBJECT_NAMESPACE_ID
node --import tsx src/worker.ts
```

The server derives the namespace from the token. The SDK rejects configuration containing both an API key and a session token. Terse supplies session credentials to its workflows.

A session token permits application access throughout its namespace; it cannot administer deployments or issue tokens. It is not restricted to one actor, method, or end user. Use a separate namespace for each customer whose actor access must be isolated, and run untrusted code in a sandbox that keeps other customers' credentials and resources out of reach.

The SDK does not renew session tokens. Use the response's `expiresAtMs` and start the next execution with fresh credentials. `storageRegion` selects placement for new actors; existing actors keep their region. See the [HTTP reference](../reference/http.md#session-tokens) for scope and lifetime limits.

## Try a session in the local demo

With `dev` running, request a session token:

```sh
npx little-actors token
```

For a trusted backend script, configure its credentials and launch it with your application tooling:

```sh
export DURABLE_OBJECT_TOKEN='<the-token-from-the-command>'
export DURABLE_OBJECT_CONTROL_PLANE_URL='http://127.0.0.1:7100'
unset DURABLE_OBJECT_API_KEY DURABLE_OBJECT_NAMESPACE_ID DURABLE_OBJECT_SOCKET_GATEWAY_URL
node --import tsx src/worker.ts
```

Use the server's actual port and pass `--data-dir` to `token` if you changed the defaults. Request a fresh token after expiration or a server restart. This token can access every actor in the local namespace, including rooms other than `lobby`.

For an untrusted worker, issue the token in a trusted process and pass only its client credentials into the sandbox. Browser applications use the generated SDK and their authenticated proxy route; they do not receive these backend session tokens.
