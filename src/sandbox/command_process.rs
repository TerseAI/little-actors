use std::{collections::HashMap, process::Stdio, time::Instant};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, ChildStdout, Command},
};

use super::{MAX_PROVIDER_OUTPUT_BYTES, ProviderCommandTimings, elapsed_ms};

pub(super) async fn exchange<Request: Serialize, Reply: for<'de> Deserialize<'de>>(
    command: &str,
    environment: &HashMap<String, String>,
    request: &Request,
    started_at: Instant,
    timings: &mut ProviderCommandTimings,
) -> Result<Reply> {
    let mut document = serde_json::to_vec(request)?;
    ensure!(
        document.len() <= MAX_PROVIDER_OUTPUT_BYTES,
        "sandbox provider command is too large"
    );
    document.push(b'\n');
    let mut child = Command::new(command)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("start sandbox provider")?;
    timings.spawned_at_ms = Some(elapsed_ms(started_at));
    let stdin = child.stdin.take().context("open provider stdin")?;
    let stdout = child.stdout.take().context("open provider stdout")?;
    let (_, response, status) = tokio::try_join!(
        write_request(
            stdin,
            &document,
            started_at,
            &mut timings.request_written_at_ms
        ),
        read_response(stdout),
        async { child.wait().await.context("wait for sandbox provider") },
    )?;
    timings.process_completed_at_ms = Some(elapsed_ms(started_at));
    ensure!(
        status.success(),
        "sandbox provider exited with {status}; outcome may be unknown"
    );
    let response: ProviderResponse<Reply> =
        serde_json::from_slice(&response).context("decode provider response")?;
    timings.response_decoded_at_ms = Some(elapsed_ms(started_at));
    match response {
        ProviderResponse::Success { result } => Ok(result),
        ProviderResponse::Failure { error } => anyhow::bail!("sandbox provider failed: {error}"),
    }
}

async fn write_request(
    mut stdin: ChildStdin,
    document: &[u8],
    started_at: Instant,
    written_at_ms: &mut Option<u64>,
) -> Result<()> {
    stdin
        .write_all(document)
        .await
        .context("write provider command")?;
    stdin.shutdown().await.context("close provider stdin")?;
    *written_at_ms = Some(elapsed_ms(started_at));
    Ok(())
}

async fn read_response(stdout: ChildStdout) -> Result<Vec<u8>> {
    let mut response = Vec::new();
    stdout
        .take((MAX_PROVIDER_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut response)
        .await?;
    ensure!(
        response.len() <= MAX_PROVIDER_OUTPUT_BYTES,
        "provider stdout exceeds {MAX_PROVIDER_OUTPUT_BYTES} bytes"
    );
    Ok(response)
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ProviderResponse<T> {
    Success { result: T },
    Failure { error: String },
}
