# System architecture

An actor is an object whose properties are saved between calls. Its host is the
machine running it. This diagram describes repository defaults, not deployment
status.

```text
Application server (outside this repository)
    | start workflow sandbox without placement constraints
    | read MODAL_REGION; pass it unchanged when requesting its token
    | project setup + issue workflow access tokens
    | web requests + DURABLE_OBJECT_API_KEY
    v
+---------------------- Central service (Rust) ------------------------+
| Register project code and issue access tokens                        |
| Find each object's host; start one when needed                       |
| Keep live client connections, connection details, and tags           |
| Check host permissions and approve saved-state updates               |
+----------------------------------------------------------------------+
    | read / update records             | start helper for one request
    v                                   v
+-------------------------------+   +--------------------------------+
| Postgres                      |   | Modal helper (Go)              |
| Projects and code versions    |   | Start / reuse / stop hosts     |
| Hosts and check-in deadlines  |   | Find public host addresses     |
| Object owners and regions     |   | Prepare an image for later use |
| Latest saved-state references |   +--------------------------------+
+-------------------------------+       | Modal service requests
                                        v
+--------------------- Object host on Modal ---------------------------+
| One project, code version, and region                                |
| US East: any Modal cloud; other supported regions: Google Cloud       |
|                                                                      |
| Rust dispatcher: owns actor directory, admission, and activity       |
|    +-- Actor A task: owns state; runs and commits calls in order     |
|    +-- Actor B task: owns state; runs and commits calls in order     |
|                                                                      |
| Executor driver: owns request IDs, pending replies, residency hints  |
|    | independent reader and writer over one local connection         |
|    v                                                                 |
| Node: load project code and manage object workers                    |
|    +-- One worker loads code before the first object is called       |
|    +-- Up to 32 object workers, each running one object's code       |
+----------------------------------------------------------------------+
    | read saved state / upload a new copy
    | temporary links issued by the central service
    v
+-------------------- Google Cloud Storage ----------------------------+
| A configured storage bucket for each region                          |
| Separate state files; existing files are never overwritten           |
+----------------------------------------------------------------------+
```

The central service handles web requests, live connections, and host check-ins
in one process, on the same listening address. It holds the credentials for
Postgres, Modal, and approving storage access. Object hosts get access tokens limited
to their project and temporary links for saved state.

Each helper process reads one command, writes one reply, and exits. The helper
can reuse a running Modal host. In `north-america-east`, hosts and image warmups
use Modal's `us-east` region without a cloud restriction. Other supported regions
remain on Google Cloud. The central service uses public addresses when calling
hosts.

The runtime container includes a compiled Go helper using Modal's official SDK.
The npm package provides the actor and workflow runtime. Select the helper executable
with `DURABLE_OBJECT_SANDBOX_COMMAND`; each request starts an independent process.

The host starts Node and waits for project code to load before reporting ready.
By default, Node removes object workers after 60 idle seconds, and a host stops
after five idle minutes. Live connections remain in the central service while their
object worker or host is stopped.

One Rust host handles many actors. Each actor has an asynchronous task that owns
its cached state and unfinished commits. Calls to that actor execute and commit
in order; different actors can run concurrently. The dispatcher owns the actor
directory and activity counts, and admits at most 33 calls per actor, including
the executing call. The dispatcher and actor mailboxes use bounded queues.

The executor driver owns the shared connection's bookkeeping and allows up to
64 pending commands. Separate reader and writer futures let replies arrive while
commands are being written. Actor tasks pass immutable, reference-counted state
snapshots to the driver; the local wire protocol is unchanged.

Once submitted, an operation continues if its caller disconnects, including any
state commit. Draining rejects new and queued ordinary calls, lets running calls
finish, and still permits disconnect events. If an actor task panics, the host
releases its admission count and refuses further calls to that actor rather
than restarting it with an uncertain state.

## Calls and live messages

The host below is the same object host shown above.

```text
Workflow starts with its token, namespace, and service URLs in environment variables.
Start/resume   <-- fresh workflow token, up to 24h --- Application server
Application server -- POST session-scoped-token + API key --> Central service

Workflow       -- find host + project access token --> Central service
Workflow       <-- host address + limited call token - Central service
Workflow       -- call an object method -------------> Object host
Workflow       <-- result + outgoing client messages - Object host
Workflow       -- deliver outgoing client messages --> Central service

Client/workflow <======== live connection ==========> Central service
Central service -- connect / message / disconnect ---> Object host
Central service <-- outgoing messages + changes ------ Object host

Object host    -- check in / request state approval -> Central service
Central service -- access check / message notice ----> Application server
                  (optional, separately configured)
```

The workflow SDK reads `DURABLE_OBJECT_TOKEN`, `DURABLE_OBJECT_NAMESPACE_ID`, and
`DURABLE_OBJECT_CONTROL_PLANE_URL` on first use. Set
`DURABLE_OBJECT_SOCKET_GATEWAY_URL` when the socket gateway has a separate origin;
otherwise it uses the control-plane URL. The application server supplies these
variables before starting the workflow.

`DURABLE_OBJECT_API_KEY` is shared by the application server and central service
for deployment registration, session token issuance, and socket event/auth callbacks.
Callback URLs remain optional. The API key never belongs in workflows or browsers.

Workflow tokens last up to 24 hours, bounded by the configured JWT maximum and
the execution deadline plus 30 seconds of grace. They are not renewed. Each
start or resume gets a fresh token. Host credentials retain their 30-minute
lifetime. Direct call tickets last at most 60 seconds; the SDK checks expiry
using real time, independent of the workflow's replay clock. If a host rejects
a ticket during authentication, the SDK resolves a new target and retries once.
It does not retry ambiguous transport failures or failures from actor code.

Workflows keep host addresses until their call tokens near expiry or the host
asks them to find a new address. A new object prefers the region in the caller's
token; an existing object keeps its recorded region when its host is replaced.
For Modal workflows, the application server reads `MODAL_REGION` after sandbox
creation and before starting the workflow, on every execution including resumes.
It passes that value unchanged as `storageRegion` when requesting the workflow
token. The signed token retains the reported value. On initial object creation,
the central service maps known cloud region IDs to its storage-region names.
New objects fall back to `north-america-central` for unknown mappings, missing
buckets, or a failed first host launch. The fallback must have a configured
Standard bucket. It is tried once, before recording the object's home region;
existing objects and failed state reads or writes never switch regions.
Registering changed project code also attempts to stop hosts for the previous
version. Optional image preparation starts a temporary Modal machine that exits
without running an actor.

Live connections use WebSocket, which keeps a connection open for messages in
both directions. Workflows supply their project token. External clients supply
a key or ticket that the application server checks. Once connected, a client
receives the object's saved properties. The central service can notify the
application server after the object handles an incoming message successfully.

Workflow broadcasts go straight to the central service and do not run object
code or save state. Messages produced by an object method return through the
workflow, which forwards them to the central service.

The code uses HTTP for web requests, gRPC over HTTP/2 for calls between programs,
and a Unix socket for the local Rust-to-Node connection. That local connection
and the helper commands carry JSON, a text format for structured data. Both
languages use the call definitions in [durable_object.proto](../proto/durable_object.proto).

## Saving state

```text
Object host -- 1. Get permission to upload ------------> Central service
Object host -- 2. Upload a new state file -------------> Google Cloud Storage
Object host -- 3. Request approval of the new version -> Central service
Central service -- 4. Check owner + version; update --> Postgres
Object host <-- 5. Saved version confirmed ------------ Central service
Caller      <-- 6. Result + outgoing messages --------- Object host
```

The host loads the latest saved file when it has no usable copy in memory. After
running object code, it saves only if the properties changed. It can reuse
upload permission returned with the previous save. Postgres accepts an update
only when the host, its current run, its check-in deadline, and the object's
ownership and saved version still match. The host waits for confirmation of
changed state before returning success and outgoing messages.

When using metadata-service credentials, the central service reuses its IAM
signing client and connections. Each signing request still gets a fresh signature;
signatures are not cached. File-based credentials retain the SDK's signing behavior.

Connection details and waiting outgoing messages live in the central service's
memory. Restarting that process loses them, and separate copies of the service
do not share them. Notices to the application server are sent in the background;
this repository has no saved queue or retry loop for failed notice delivery.

## Timing logs

Use the identifiers below to match related records. Each record measures time
from its own operation's start.

```text
One workflow call (request_id)
    +-- actor_client_invocation   : complete the client call
    +-- actor_target_resolution   : find a host, when needed
    +-- actor_host_invocation     : run the object method
    +-- actor_state_write         : save changed state, when needed

One host (host_id)
    +-- actor_host_provisioning   : start or reuse a Modal host
    +-- actor_host_startup        : start Rust and attach Node, for a new host
    +-- actor_host_invocation     : calls handled by that host
    +-- actor_state_write         : state saved by that host
```

Host creation records have no `request_id`; they cannot be matched directly to
a request by that field. The host startup record begins when Rust starts, so
it excludes the earlier time Modal spends preparing the machine.

## Code behind the diagram

| Responsibility | Main files |
| --- | --- |
| Start the central service and expose its request handlers | [process.rs](../src/control_plane/process.rs), [public_api.rs](../src/control_plane/public_api.rs) |
| Choose hosts, replace old code, check host access, approve state | [service.rs](../src/control_plane/service.rs), [regions.rs](../src/control_plane/regions.rs) |
| Keep live connections and contact the application server | [websocket.rs](../src/control_plane/websocket.rs), [socket_auth.rs](../src/control_plane/socket_auth.rs), [event_sink.rs](../src/control_plane/event_sink.rs) |
| Make workflow calls and forward outgoing messages | [remoteClient.ts](../npm/workflow/remoteClient.ts) |
| Run helper commands and manage Modal hosts | [command_process.rs](../src/sandbox/command_process.rs), [provider.go](../providers/modal-go/provider.go), [modal.go](../providers/modal-go/modal.go) |
| Start hosts, manage workers, run object code | [process.rs](../src/host/process.rs), [supervisor.ts](../npm/host/worker/supervisor.ts), [runtime.ts](../npm/host/worker/runtime.ts) |
| Dispatch calls and own actor tasks | [actor_host.rs](../src/host/actor_host.rs) |
| Connect actor tasks to the Node executor | [executor_connection.rs](../src/actor/executor_connection.rs) |
| Save state and record which copy is current | [actor_runtime.rs](../src/host/actor_runtime.rs), [storage_urls.rs](../src/storage_urls.rs), [iam.rs](../src/storage_urls/iam.rs), [placement.rs](../src/placement.rs), [database tables](../migrations/V1__initial.sql) |
