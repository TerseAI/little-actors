use anyhow::Result;
use clap::{Parser, Subcommand};
use little_durable_objects::{
    control_plane::{ControlPlaneProcessConfig, DevOptions, serve_control_plane, serve_local},
    host::{ActorHostConfig, serve_actor_host},
};
use tokio::io::AsyncReadExt;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    if let Err(error) = run().await {
        error!(error = %format!("{error:#}"), "durable-object process failed");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    if let Some(Commands::Dev(options)) = cli.command {
        return serve_local(options, shutdown_signal()).await;
    }
    let shutdown = shutdown_signal();
    match std::env::var("DURABLE_OBJECT_PROCESS_ROLE")
        .as_deref()
        .unwrap_or("host")
    {
        "control_plane" => {
            serve_control_plane(ControlPlaneProcessConfig::from_env()?, shutdown).await
        }
        "host" => serve_actor_host(ActorHostConfig::from_env()?, shutdown).await,
        role => anyhow::bail!("unsupported DURABLE_OBJECT_PROCESS_ROLE {role:?}"),
    }
}

#[derive(Parser)]
#[command(
    version,
    about = "Run durable TypeScript actors locally or in the cloud"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    #[command(about = "Start local actors with automatic SQLite and file storage")]
    Dev(DevOptions),
}

async fn shutdown_signal() {
    if std::env::var_os("DURABLE_OBJECT_PARENT_LIFETIME_STDIN").is_none() {
        wait_for_signal().await;
        info!("shutdown signal received");
        return;
    }
    tokio::select! {
        _ = wait_for_signal() => info!("shutdown signal received"),
        _ = wait_for_parent_stdin_close() => info!("parent process exited"),
    }
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

async fn wait_for_parent_stdin_close() {
    let mut stdin = tokio::io::stdin();
    let mut buffer = [0_u8; 1];
    loop {
        match stdin.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}
