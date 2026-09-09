use super::tests::{FakeLeaseStore, FakeStorageUrls, FakeWarmProvisioner, test_issuer};
use super::*;
use crate::{
    actor::{ActorExecutorListener, ActorSocketPublisher},
    control_plane::{ActorTokenPurpose, ControlPlaneClient, admin::LocalAdminRegistry},
    grpc::ActorHostGrpcService,
    host::{ActorHost, HostEndpoint},
    host_leases::{HostLeaseRegistry, HostLeaseRequest},
    placement::testing::LocalObjectPlacementStore,
    state_transport::{StateTransport, StateWrite},
};
use futures_util::{SinkExt, StreamExt};
use std::{collections::HashMap, process::Stdio, sync::Mutex};
use tokio::{net::TcpListener, task::JoinSet};
use tokio_stream::wrappers::TcpListenerStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[tokio::test]
#[ignore = "requires pnpm --dir npm build; exercises a handler longer than 30 seconds"]
async fn streams_through_real_worker_host_and_gateway_then_catches_up_reconnect() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .try_init();
    let mut stack = Stack::start().await?;
    let mut first = stack.connect().await?;
    assert_eq!(receive(&mut first).await?["state"]["history"], "");
    first
        .send(Message::Text(
            serde_json::json!({"type": "start"}).to_string().into(),
        ))
        .await?;
    assert_eq!(receive(&mut first).await?["delta"], "first");

    let mut late = stack.connect().await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), late.next())
            .await
            .is_err()
    );
    tokio::time::sleep(Duration::from_secs(31)).await;
    std::fs::write(stack.directory.path().join("release"), "")?;
    assert_eq!(receive(&mut first).await?["delta"], "last");
    assert_eq!(receive(&mut late).await?["state"]["history"], "firstlast");

    let mut outside = stack.actor.clone();
    outside.namespace_id = "another-project".into();
    assert!(stack.publisher.publish(&outside, vec![]).await.is_err());
    stack
        .leases
        .unregister(&stack.host_id, "00000000-0000-4000-8000-000000000001")
        .await?;
    assert!(stack.publisher.publish(&stack.actor, vec![]).await.is_err());
    first.close(None).await?;
    late.close(None).await?;
    stack.child.kill().await?;
    Ok(())
}

struct Stack {
    directory: tempfile::TempDir,
    tasks: JoinSet<()>,
    child: tokio::process::Child,
    gateway: String,
    workflow_token: String,
    actor: ActorKey,
    host_id: HostId,
    leases: Arc<FakeLeaseStore>,
    publisher: Arc<ControlPlaneClient>,
}

impl Stack {
    async fn start() -> Result<Self> {
        let directory = tempfile::TempDir::new_in("/tmp")?;
        let mut tasks = JoinSet::new();
        let issuer = test_issuer()?;
        let actor = ActorKey {
            namespace_id: "project-1".into(),
            actor_type: "Counter".into(),
            actor_id: "counter-1".into(),
        };
        let host_id = HostId::new("host.v1.project-1.revision.session");
        let host_listener = TcpListener::bind("127.0.0.1:0").await?;
        let host_route = format!("http://{}", host_listener.local_addr()?);
        let leases = Arc::new(FakeLeaseStore {
            leases: Mutex::new(HashMap::new()),
        });
        leases
            .register(&HostLeaseRequest {
                id: host_id.clone(),
                session_id: "00000000-0000-4000-8000-000000000001".into(),
                route: host_route.clone(),
                duration_ms: 60_000,
            })
            .await?;
        let placements = Arc::new(LocalObjectPlacementStore::default());
        placements
            .claim(&actor.storage_key(), None, &host_id, "us-east")
            .await?;
        let registry = Arc::new(LocalAdminRegistry::default());
        registry
            .ensure_namespace_and_register_deployment(&HostLaunchSpec {
                namespace_id: actor.namespace_id.clone(),
                code_revision: "revision".into(),
                image_ref: "test-image".into(),
                working_directory: "/app".into(),
                actor_entrypoint: None,
                secret_refs: vec![],
                socket_gateway_url: None,
            })
            .await?;
        let auth = ActorJwtVerifier::for_scope(
            issuer.verifier_keys_json()?,
            "issuer",
            "authority",
            ActorTokenPurpose::ControlPlane,
            Duration::from_secs(60),
        )?;
        let service = ControlPlaneService::new(
            leases.clone(),
            placements,
            Arc::new(FakeStorageUrls(&["us-east"])),
            auth,
            registry.clone(),
            issuer.clone(),
            Arc::new(FakeWarmProvisioner {
                warmed: tokio::sync::mpsc::unbounded_channel().0,
            }),
        );
        let control_plane = serve_control_plane(&mut tasks, service.clone()).await?;
        let gateway = serve_gateway(
            &mut tasks,
            service,
            AdminService::new("test-api-key".into(), registry, issuer.clone())?,
        )
        .await?;
        let token = issuer
            .issue_host(
                "project-1",
                &host_id,
                "00000000-0000-4000-8000-000000000001",
                "revision",
                "us-east",
            )?
            .token;
        let publisher = Arc::new(
            ControlPlaneClient::connect(control_plane, token)
                .await?
                .with_socket_gateway(&gateway),
        );

        let (child, connection) = start_worker(directory.path()).await?;
        connection.mark_ready(Some(publisher.clone())).await?;
        let host = Arc::new(ActorHost::new(
            HostEndpoint {
                id: host_id.clone(),
                route: host_route,
            },
            "project-1".into(),
            connection.executor(),
            publisher.clone(),
            Arc::new(MemoryState::default()),
        ));
        tasks.spawn(async move {
            let _ = connection
                .run(tokio_util::sync::CancellationToken::new())
                .await;
        });
        let auth = ActorJwtVerifier::for_scope(
            issuer.verifier_keys_json()?,
            "issuer",
            "invocation",
            ActorTokenPurpose::Invocation,
            Duration::from_secs(60),
        )?;
        tasks.spawn(async move {
            let _ = tonic::transport::Server::builder()
                .add_service(ActorHostGrpcService::new(host, auth).into_service())
                .serve_with_incoming(TcpListenerStream::new(host_listener))
                .await;
        });
        let workflow_token = issuer
            .issue_workflow(
                "project-1",
                "test-workflow",
                "us-east",
                (unix_seconds()? + 60) * 1000,
            )?
            .token;
        Ok(Self {
            directory,
            tasks,
            child,
            gateway,
            workflow_token,
            actor,
            host_id,
            leases,
            publisher,
        })
    }

    async fn connect(&self) -> Result<Socket> {
        let mut request = format!(
            "{}/v1/namespaces/project-1/actors/Counter/counter-1/websocket",
            self.gateway.replace("http://", "ws://")
        )
        .into_client_request()?;
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", self.workflow_token).parse()?,
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await?;
        socket
            .send(Message::Text(
                r#"{"type":"initialize","metadata":{}}"#.into(),
            ))
            .await?;
        Ok(socket)
    }
}

impl Drop for Stack {
    fn drop(&mut self) {
        self.tasks.abort_all();
    }
}

async fn serve_control_plane(
    tasks: &mut JoinSet<()>,
    service: ControlPlaneService,
) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    tasks.spawn(async move {
        let _ = tonic::transport::Server::builder()
            .add_service(service.into_internal_service())
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await;
    });
    Ok(url)
}

async fn serve_gateway(
    tasks: &mut JoinSet<()>,
    service: ControlPlaneService,
    admin: AdminService,
) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    tasks.spawn(async move {
        let _ = axum::serve(listener, super::super::public_api::router(service, admin)).await;
    });
    Ok(url)
}

async fn start_worker(
    directory: &std::path::Path,
) -> Result<(tokio::process::Child, crate::actor::ActorExecutorConnection)> {
    let npm = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("npm/dist");
    ensure!(
        npm.join("host.js").exists(),
        "run pnpm --dir npm build before this test"
    );
    let entrypoint = directory.join("actors.mjs");
    std::fs::write(
        &entrypoint,
        format!(
            r#"
import {{ Actor }} from {};
import {{ existsSync }} from 'node:fs';
import {{ setTimeout }} from 'node:timers/promises';
export class Counter extends Actor {{
    history = '';
    async onMessage() {{
        if (process.env.TEST_ACTOR_SECRET !== 'injected') throw new Error('actor secret missing');
        this.history += 'first';
        this.broadcast({{ delta: 'first' }});
        while (!existsSync({})) await setTimeout(10);
        this.history += 'last';
        this.broadcast({{ delta: 'last' }});
    }}
}}
"#,
            serde_json::to_string(&format!("file://{}", npm.join("index.js").display()))?,
            serde_json::to_string(&directory.join("release"))?
        ),
    )?;
    let socket = directory.join("executor.sock");
    let listener = ActorExecutorListener::bind(&socket).await?;
    let bootstrap = directory.join("host.mjs");
    std::fs::write(
        &bootstrap,
        format!(
            "import {{ runDurableObjectHost }} from {}; await runDurableObjectHost();",
            serde_json::to_string(&format!("file://{}", npm.join("host.js").display()))?
        ),
    )?;
    let child = tokio::process::Command::new("node")
        .arg(bootstrap)
        .env("DURABLE_OBJECT_ENTRYPOINT", entrypoint)
        .env("DURABLE_OBJECT_EXECUTOR_SOCKET", socket)
        .env("TEST_ACTOR_SECRET", "injected")
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()?;
    let connection = tokio::time::timeout(Duration::from_secs(10), listener.accept()).await??;
    Ok((child, connection))
}

async fn receive(socket: &mut Socket) -> Result<serde_json::Value> {
    let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await?
        .context("socket closed")??;
    ensure!(frame.is_text(), "unexpected socket frame: {frame:?}");
    serde_json::from_str(frame.to_text()?)
        .with_context(|| format!("invalid socket JSON: {frame:?}"))
}

#[derive(Default)]
struct MemoryState(Mutex<Vec<u8>>);

#[async_trait]
impl StateTransport for MemoryState {
    async fn read(&self, _: &str) -> Result<bytes::Bytes> {
        Ok(self.0.lock().unwrap().clone().into())
    }
    async fn write(&self, _: &str, bytes: Vec<u8>) -> Result<StateWrite> {
        *self.0.lock().unwrap() = bytes;
        Ok(StateWrite::Written)
    }
}
