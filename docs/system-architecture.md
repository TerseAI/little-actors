# System architecture

```text
trusted backend
    | REST + admin token                                                   ^ authenticated socket-message event
    | ensure namespace + deployment / retire hosts / warm image / JWT      | + socket authorization
    v                                                                      |
+----------------------------- runtime services ---------------------------+
| HTTP/2 control plane           HTTP/1.1 WebSocket gateway                 |
| public HTTP + internal gRPC    connection registry + socket effects       |
|     | admin request                 |        ^                             |
|     v                               |        | socket effects              |
| AdminService                  target router  |                             |
|     |                               | placement + lease                    |
|     +-------------------------------+----------> Postgres                  |
|                              placement + CAS state head                    |
|                                     |                                     |
|                              HostProvisioner                              |
|                                     |                                     |
| command sandbox provider ---------->+----> Modal Sandbox V2 (GCP pools)   |
|   JSON host handle / lazy public gRPC route | current filesystem API      |
|                                               |                           |
| internal gRPC API <-------- host JWT ---------+----> Rust actor host       |
+---------------------------------------------------------------------------+
          ^                 ^                |                  |
          | workflow JWT    | WebSocket      | public lifecycle | Unix socket
          |                 | + key/ticket   | / method gRPC   | methods + lifecycle
          |                 |                v                  v
       workflow          clients        Rust actor host --> Node supervisor
          ^                                  |                  |-- speculative Worker
          |                                  |                  +-- resident actor Workers
          | queued durable-object event      | signed GET / create-only PUT
          +---- trusted backend              v
                                regional GCS immutable snapshots
```

The Rust and Node gRPC contracts both come from `proto/durable_object.proto`.
The npm build generates TypeScript client types and bundles that schema for
`@grpc/proto-loader` to construct the client and codecs.

Sandbox providers use one persistent protocol: newline-delimited JSON commands
on stdin and success/failure envelopes on stdout. The control plane pools up to
two processes per provider, independent of the executable name. Each process
loads its SDK once. Cancelled exchanges and malformed, oversized, or truncated
responses discard the process; command failures leave it available for reuse.
Provider logs go to stderr.

## Invocation telemetry

```text
actor_client_invocation
    |
    +---- request_id ----> actor_target_resolution
    |                          |
    |                          +---- cold path ----> actor_host_provisioning
    |                                                   |
    |                                                   +----> actor_host_startup
    |
    +---- request_id ----> actor_host_invocation ----> actor_state_write
```
