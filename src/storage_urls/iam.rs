use std::{path::PathBuf, time::Duration};

use anyhow::Result;
use google_cloud_auth::{
    credentials,
    signer::{Signer, SigningError, SigningProvider},
};
use google_cloud_iam_credentials_v1::client::IAMCredentials;

pub(super) async fn from_adc() -> Result<Signer> {
    let identity = credentials::Builder::default().build_signer()?;
    if has_file_credentials(|name| std::env::var_os(name)) {
        return Ok(identity);
    }
    let credentials = credentials::Builder::default().build()?;
    let universe = credentials
        .universe_domain()
        .await
        .unwrap_or_else(|| "googleapis.com".into());
    let client = IAMCredentials::builder()
        .with_credentials(credentials)
        .with_endpoint(format!("https://iamcredentials.{universe}"))
        .build()
        .await?;
    Ok(ReusableIamSigner::new(identity, client).into())
}

#[derive(Debug)]
struct ReusableIamSigner {
    identity: Signer,
    client: IAMCredentials,
}

impl ReusableIamSigner {
    fn new(identity: Signer, client: IAMCredentials) -> Self {
        Self { identity, client }
    }
}

impl SigningProvider for ReusableIamSigner {
    async fn client_email(&self) -> google_cloud_auth::signer::Result<String> {
        self.identity.client_email().await
    }

    async fn sign(&self, content: &[u8]) -> google_cloud_auth::signer::Result<bytes::Bytes> {
        let email = self.client_email().await?;
        let request = self
            .client
            .sign_blob()
            .set_name(format!("projects/-/serviceAccounts/{email}"))
            .set_payload(bytes::Bytes::copy_from_slice(content));
        tokio::time::timeout(Duration::from_secs(60), request.send())
            .await
            .map_err(SigningError::from_msg)?
            .map(|response| response.signed_blob)
            .map_err(SigningError::from_msg)
    }
}

fn has_file_credentials(mut get: impl FnMut(&str) -> Option<std::ffi::OsString>) -> bool {
    // Preserve the SDK's local-key and impersonation behavior for file-based ADC.
    if get("GOOGLE_APPLICATION_CREDENTIALS").is_some() {
        return true;
    }
    let (variable, relative) = if cfg!(target_os = "windows") {
        ("APPDATA", "gcloud/application_default_credentials.json")
    } else {
        (
            "HOME",
            ".config/gcloud/application_default_credentials.json",
        )
    };
    get(variable).is_some_and(|root| PathBuf::from(root).join(relative).exists())
}

#[cfg(test)]
mod tests {
    use std::{
        net::SocketAddr,
        sync::{Arc, Mutex},
    };

    use axum::{
        Json, Router,
        extract::{ConnectInfo, State},
        routing::post,
    };
    use base64::{Engine, prelude::BASE64_STANDARD};
    use google_cloud_auth::{
        credentials::anonymous,
        signer::{Signer, SigningProvider},
    };
    use google_cloud_iam_credentials_v1::client::IAMCredentials;
    use serde_json::{Value, json};

    #[tokio::test]
    async fn signing_reuses_connections_without_reusing_signatures() -> anyhow::Result<()> {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let app = Router::new()
            .route("/{*path}", post(sign))
            .with_state(requests.clone());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        let client = IAMCredentials::builder()
            .with_credentials(anonymous::Builder::new().build())
            .with_endpoint(format!("http://{address}"))
            .build()
            .await?;
        let signer: Signer = super::ReusableIamSigner::new(Identity.into(), client).into();
        let first = signer.sign(b"first").await?;
        let second = signer.clone().sign(b"second").await?;
        server.abort();
        assert_eq!(first.as_ref(), b"first");
        assert_eq!(second.as_ref(), b"second");
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].0, requests[1].0,
            "signatures must share an HTTP connection"
        );
        assert_ne!(requests[0].1, requests[1].1);
        Ok(())
    }

    #[tokio::test]
    async fn independent_signatures_can_run_concurrently() -> anyhow::Result<()> {
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let app = Router::new().route(
            "/{*path}",
            post(move |Json(body): Json<Value>| {
                let barrier = barrier.clone();
                async move {
                    barrier.wait().await;
                    Json(json!({"keyId":"test-key","signedBlob":body["payload"]}))
                }
            }),
        );
        let (signer, server) = test_signer(app).await?;
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::try_join!(signer.sign(b"first"), signer.sign(b"second"))
        })
        .await;
        server.abort();
        let (first, second) = result??;
        assert_eq!(first.as_ref(), b"first");
        assert_eq!(second.as_ref(), b"second");
        Ok(())
    }

    #[tokio::test]
    async fn failed_signatures_are_not_returned_as_success() -> anyhow::Result<()> {
        let app = Router::new().route("/{*path}", post(|| async {
            (axum::http::StatusCode::FORBIDDEN, Json(json!({"error":{"code":403,"message":"denied","status":"PERMISSION_DENIED"}})))
        }));
        let (signer, server) = test_signer(app).await?;
        let result = signer.sign(b"first").await;
        server.abort();
        assert!(result.is_err());
        Ok(())
    }

    #[test]
    fn explicit_adc_keeps_the_sdk_signing_strategy() {
        assert!(super::has_file_credentials(|name| (name
            == "GOOGLE_APPLICATION_CREDENTIALS")
            .then(|| "/credentials.json".into())));
        assert!(!super::has_file_credentials(|_| None));
    }

    #[test]
    fn well_known_adc_keeps_the_sdk_signing_strategy() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let relative = if cfg!(target_os = "windows") {
            "gcloud"
        } else {
            ".config/gcloud"
        };
        let directory = root.path().join(relative);
        std::fs::create_dir_all(&directory)?;
        std::fs::write(directory.join("application_default_credentials.json"), "{}")?;
        assert!(super::has_file_credentials(|name| (name == "HOME"
            || name == "APPDATA")
            .then(|| root.path().as_os_str().to_owned())));
        Ok(())
    }

    async fn test_signer(
        app: Router,
    ) -> anyhow::Result<(Signer, tokio::task::JoinHandle<std::io::Result<()>>)> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let client = IAMCredentials::builder()
            .with_credentials(anonymous::Builder::new().build())
            .with_endpoint(format!("http://{address}"))
            .build()
            .await?;
        Ok((
            super::ReusableIamSigner::new(Identity.into(), client).into(),
            server,
        ))
    }

    type Requests = Arc<Mutex<Vec<(SocketAddr, String)>>>;

    async fn sign(
        State(requests): State<Requests>,
        ConnectInfo(peer): ConnectInfo<SocketAddr>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        let payload = body["payload"].as_str().unwrap().to_string();
        assert!(BASE64_STANDARD.decode(&payload).is_ok());
        requests.lock().unwrap().push((peer, payload.clone()));
        Json(json!({"keyId": "test-key", "signedBlob": payload}))
    }

    #[derive(Debug)]
    struct Identity;

    impl SigningProvider for Identity {
        async fn client_email(&self) -> google_cloud_auth::signer::Result<String> {
            Ok("test@example.iam.gserviceaccount.com".into())
        }

        async fn sign(&self, _: &[u8]) -> google_cloud_auth::signer::Result<bytes::Bytes> {
            panic!("the original signer must only supply identity, not perform IAM requests")
        }
    }
}
