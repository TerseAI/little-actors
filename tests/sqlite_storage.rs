use anyhow::Result;
use little_durable_objects::{
    actor_state::ActorStorageKey,
    host::HostId,
    host_leases::{HostLeaseRegistry, HostLeaseRequest, HostLeaseStore},
    placement::{ObjectPlacementStore, PlacementClaim, StateCommit, StateCommitRequest},
    sqlite::SqliteStore,
};

#[tokio::test]
async fn sqlite_keeps_committed_state_across_restarts_and_fences_old_owners() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("runtime.sqlite");
    let store = SqliteStore::open(&path).await?;
    let object = ActorStorageKey::new("counter");
    let host = HostId::new("host-1");
    store.register(&lease(&host, "session-1")).await?;
    assert!(
        store
            .register(&lease(&host, "other-session"))
            .await
            .is_err()
    );
    let PlacementClaim::Acquired(placement) = store
        .claim(&object, None, &host, "north-america-east")
        .await?
    else {
        panic!("first caller must own the actor");
    };
    let mut commit = StateCommitRequest {
        object: object.clone(),
        owner: host.clone(),
        session_id: "session-1".into(),
        owner_epoch: placement.owner_epoch,
        expected_version: 0,
        state_object: "snapshots/counter/1.json".into(),
        request_id: "request-1".into(),
    };
    let StateCommit::Committed(saved) = store.commit_state(&commit).await? else {
        panic!("active owner must commit");
    };
    assert_eq!(
        store.commit_state(&commit).await?,
        StateCommit::Committed(saved.clone())
    );
    let reopened = SqliteStore::open(&path).await?;
    assert_eq!(reopened.get(&object).await?, Some(saved.clone()));
    store.unregister(&host, "wrong-session").await?;
    assert!(store.lease_status(&host).await?.is_active());
    store.unregister(&host, "session-1").await?;
    let next = HostId::new("host-2");
    reopened.register(&lease(&next, "session-2")).await?;
    let PlacementClaim::Acquired(replaced) = reopened
        .claim(&object, Some(&saved), &next, "north-america-east")
        .await?
    else {
        panic!("replacement must acquire ownership");
    };
    assert_eq!(replaced.state_object, saved.state_object);
    assert_eq!(replaced.owner_epoch, saved.owner_epoch + 1);
    commit.expected_version = 1;
    commit.request_id = "stale-request".into();
    assert_eq!(
        store.commit_state(&commit).await?,
        StateCommit::Current(replaced)
    );
    Ok(())
}

#[tokio::test]
async fn independent_sqlite_connections_cannot_both_win_a_claim() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("runtime.sqlite");
    let first = SqliteStore::open(&path).await?;
    let second = SqliteStore::open(&path).await?;
    let object = ActorStorageKey::new("contended");
    let first_host = HostId::new("first");
    let second_host = HostId::new("second");
    let (a, b) = tokio::try_join!(
        first.claim(&object, None, &first_host, "north-america-east"),
        second.claim(&object, None, &second_host, "north-america-east"),
    )?;
    assert_eq!(
        usize::from(matches!(a, PlacementClaim::Acquired(_)))
            + usize::from(matches!(b, PlacementClaim::Acquired(_))),
        1
    );
    Ok(())
}

fn lease(host: &HostId, session: &str) -> HostLeaseRequest {
    HostLeaseRequest {
        id: host.clone(),
        session_id: session.into(),
        route: "http://127.0.0.1:7101".into(),
        duration_ms: 60_000,
    }
}

#[tokio::test]
async fn sqlite_claims_preserve_the_owner_epoch_and_reject_mismatched_expectations() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let store = SqliteStore::open(&directory.path().join("runtime.sqlite")).await?;
    let object = ActorStorageKey::new("counter");
    let host = HostId::new("host");
    let PlacementClaim::Acquired(placement) = store
        .claim(&object, None, &host, "north-america-east")
        .await?
    else {
        panic!("initial claim must win")
    };
    assert_eq!(
        store
            .claim(&object, Some(&placement), &host, "north-america-east")
            .await?,
        PlacementClaim::Current(placement.clone())
    );
    assert!(
        store
            .claim(
                &object,
                Some(&placement),
                &HostId::new("next"),
                "europe-west"
            )
            .await
            .is_err()
    );
    let mut mismatched = placement;
    mismatched.object = ActorStorageKey::new("other");
    assert!(
        store
            .claim(
                &object,
                Some(&mismatched),
                &HostId::new("next"),
                "north-america-east"
            )
            .await
            .is_err()
    );
    Ok(())
}
