#![cfg(unix)]

use std::{process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
    time::timeout,
};

#[tokio::test]
async fn interrupt_exits_while_the_parent_stdin_pipe_is_open() -> Result<()> {
    assert_shutdown(Some("-INT")).await
}

#[tokio::test]
async fn terminate_exits_while_the_parent_stdin_pipe_is_open() -> Result<()> {
    assert_shutdown(Some("-TERM")).await
}

#[tokio::test]
async fn closing_parent_stdin_stops_the_runtime() -> Result<()> {
    assert_shutdown(None).await
}

async fn assert_shutdown(signal: Option<&str>) -> Result<()> {
    let project = tempfile::tempdir()?;
    std::fs::write(project.path().join("actors.ts"), "export {}\n")?;
    let mut child = Command::new(env!("CARGO_BIN_EXE_little-durable-objects"))
        .args(["dev", "--port", "0", "--entrypoint", "actors.ts"])
        .arg("--project")
        .arg(project.path())
        .env("DURABLE_OBJECT_PARENT_LIFETIME_STDIN", "1")
        .env("RUST_LOG", "info")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut parent_stdin = child.stdin.take();
    let mut output = BufReader::new(child.stdout.take().context("capture runtime output")?);
    timeout(Duration::from_secs(5), wait_until_ready(&mut output)).await??;
    tokio::time::sleep(Duration::from_millis(50)).await;

    if let Some(signal) = signal {
        let status = Command::new("kill")
            .args([
                signal,
                &child.id().context("runtime exited early")?.to_string(),
            ])
            .status()
            .await?;
        ensure!(status.success(), "send runtime shutdown signal");
    } else {
        drop(parent_stdin.take());
    }

    let status = timeout(Duration::from_secs(3), child.wait())
        .await
        .context("runtime did not exit after shutdown")??;
    ensure!(status.success(), "runtime exited with {status}");
    drop(parent_stdin);
    let mut remaining = String::new();
    output.read_to_string(&mut remaining).await?;
    let message = if signal.is_some() {
        "shutdown signal received"
    } else {
        "parent process exited"
    };
    ensure!(
        remaining.contains(message),
        "shutdown was not handled: {remaining}"
    );
    Ok(())
}

async fn wait_until_ready(output: &mut BufReader<tokio::process::ChildStdout>) -> Result<()> {
    let mut line = String::new();
    loop {
        ensure!(
            output.read_line(&mut line).await? != 0,
            "runtime exited before readiness"
        );
        if line.contains("Local actors ready at") {
            return Ok(());
        }
        line.clear();
    }
}
