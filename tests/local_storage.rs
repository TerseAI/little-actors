use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use anyhow::Result;
use little_actors::{
    actor::ActorKey,
    clock::Clock,
    storage_urls::{LocalStorage, StorageUrlSigner},
};

struct TestClock(AtomicU64);
impl Clock for TestClock {
    fn now_ms(&self) -> Result<u64> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}

#[tokio::test]
async fn local_snapshots_require_valid_capabilities_and_are_immutable() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let clock = Arc::new(TestClock(AtomicU64::new(1000)));
    let storage = Arc::new(LocalStorage::new(
        directory.path().into(),
        origin,
        clock.clone(),
    )?);
    let router = storage.clone().router();
    let server = tokio::spawn(async { axum::serve(listener, router).await });
    let actor = ActorKey {
        namespace_id: "local".into(),
        actor_type: "Counter".into(),
        actor_id: "one".into(),
    };
    let ticket = storage
        .write_ticket("north-america-east", &actor, 1)
        .await?;
    let client = reqwest::Client::new();
    assert_eq!(client.get(&ticket.url).send().await?.status(), 403);
    assert_eq!(
        client
            .put(&ticket.url)
            .body("{\"count\":1}")
            .send()
            .await?
            .status(),
        201
    );
    assert_eq!(
        client
            .put(&ticket.url)
            .body("replacement")
            .send()
            .await?
            .status(),
        412
    );
    let read = storage
        .read_url("north-america-east", &ticket.object_name)
        .await?;
    assert_eq!(
        client.get(&read).send().await?.text().await?,
        "{\"count\":1}"
    );
    assert!(
        storage
            .read_url("north-america-east", "snapshots/../private")
            .await
            .is_err()
    );
    let tampered = read.replace("/one/", "/other/");
    assert_eq!(client.get(tampered).send().await?.status(), 403);
    clock.0.store(61_001, Ordering::SeqCst);
    assert_eq!(client.get(read).send().await?.status(), 403);
    server.abort();
    Ok(())
}
