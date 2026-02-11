use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing::{error, info};

#[derive(Clone)]
struct AppState {
    bridge: Arc<Mutex<BridgeClient>>,
}

struct BridgeClient {
    project_root: PathBuf,
    bridge_path: PathBuf,
    process: Option<BridgeProcess>,
}

struct BridgeProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRequest {
    config: RunConfig,
    #[serde(default)]
    workers: Option<usize>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerConfig {
    name: String,
    range: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunConfig {
    variant: String,
    #[serde(default)]
    percentile_profile: Option<String>,
    iteration_cap: i64,
    board: String,
    dead: String,
    players: Vec<PlayerConfig>,
    #[serde(default)]
    range_coverage: Option<Vec<Value>>,
    #[serde(default)]
    confidence_target_pct: Option<f64>,
    #[serde(default)]
    confidence_min_iterations: Option<i64>,
    #[serde(default)]
    confidence_level: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewTagRequest {
    #[serde(default)]
    board_text: String,
    #[serde(default)]
    variant: String,
    #[serde(default)]
    tag: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRangeRequest {
    #[serde(default)]
    board_text: String,
    #[serde(default)]
    variant: String,
    #[serde(default)]
    range_text: String,
    #[serde(default)]
    percentile_profile: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "backend_rs=info,tower_http=info".to_string()),
        )
        .init();

    let project_root = std::env::current_dir()?;
    let bridge_path = project_root.join("backend").join("bridge.mjs");
    if !bridge_path.exists() {
        return Err(format!("missing bridge script {}", bridge_path.display()).into());
    }

    let port = std::env::var("PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .unwrap_or(8788);

    let state = AppState {
        bridge: Arc::new(Mutex::new(BridgeClient::new(
            project_root.clone(),
            bridge_path,
        ))),
    };

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/sim/run", post(sim_run))
        .route("/api/sim/preview/tag", post(sim_preview_tag))
        .route("/api/sim/preview/range", post(sim_preview_range))
        .fallback_service(ServeDir::new(project_root))
        .with_state(state)
        .layer(TraceLayer::new_for_http());

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    info!("rust backend listening on http://localhost:{port}");
    axum::Server::bind(&addr)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn sim_run(
    State(state): State<AppState>,
    Json(req): Json<RunRequest>,
) -> (StatusCode, Json<Value>) {
    if req.config.players.len() < 2 || req.config.players.len() > 6 {
        return error_json(StatusCode::BAD_REQUEST, "players must be between 2 and 6");
    }

    let mut payload = json!({
        "action": "run-native",
        "config": req.config,
    });
    if let Some(workers) = req.workers {
        if workers > 0 {
            payload["workers"] = json!(workers);
        }
    }

    let bridge_start = Instant::now();
    let mut out = match call_bridge(&state, payload).await {
        Ok(v) => v,
        Err(msg) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    };

    if !out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let msg = out
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("simulation failed");
        return error_json(StatusCode::INTERNAL_SERVER_ERROR, msg);
    }

    let bridge_wall_ms = bridge_start.elapsed().as_secs_f64() * 1000.0;
    let timings = out.as_object_mut().and_then(|obj| {
        obj.entry("timings")
            .or_insert_with(|| json!({}))
            .as_object_mut()
    });
    if let Some(t) = timings {
        t.insert("bridgeWallMs".to_string(), json!(bridge_wall_ms));
        if let Some(total_ms) = t.get("totalMs").and_then(Value::as_f64) {
            let overhead = bridge_wall_ms - total_ms;
            if overhead > 0.0 {
                t.insert("bridgeOverheadMs".to_string(), json!(overhead));
            }
        }
    }

    (StatusCode::OK, Json(out))
}

async fn sim_preview_tag(
    State(state): State<AppState>,
    Json(req): Json<PreviewTagRequest>,
) -> (StatusCode, Json<Value>) {
    let payload = json!({
        "action": "preview-tag",
        "boardText": req.board_text,
        "variant": req.variant,
        "tag": req.tag,
    });
    match call_bridge(&state, payload).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(msg) => error_json(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

async fn sim_preview_range(
    State(state): State<AppState>,
    Json(req): Json<PreviewRangeRequest>,
) -> (StatusCode, Json<Value>) {
    let payload = json!({
        "action": "preview-range",
        "boardText": req.board_text,
        "variant": req.variant,
        "rangeText": req.range_text,
        "percentileProfile": req.percentile_profile.unwrap_or_default(),
    });
    match call_bridge(&state, payload).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(msg) => error_json(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

async fn call_bridge(state: &AppState, req: Value) -> Result<Value, String> {
    let mut bridge = state.bridge.lock().await;
    bridge
        .call(&req)
        .await
        .map_err(|err| format!("bridge failed: {err}"))
}

fn error_json(status: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({
            "ok": false,
            "error": msg,
        })),
    )
}

impl BridgeClient {
    fn new(project_root: PathBuf, bridge_path: PathBuf) -> Self {
        Self {
            project_root,
            bridge_path,
            process: None,
        }
    }

    async fn call(&mut self, req: &Value) -> Result<Value, String> {
        let payload = serde_json::to_string(req).map_err(|e| e.to_string())?;
        let mut last_err = String::from("bridge call failed");

        for _ in 0..2 {
            if let Err(err) = self.ensure_started().await {
                return Err(err);
            }

            if let Some(proc) = self.process.as_mut() {
                if proc.stdin.write_all(payload.as_bytes()).await.is_err()
                    || proc.stdin.write_all(b"\n").await.is_err()
                    || proc.stdin.flush().await.is_err()
                {
                    last_err = "write request to bridge failed".to_string();
                    self.stop().await;
                    continue;
                }

                let mut line = String::new();
                match proc.stdout.read_line(&mut line).await {
                    Ok(0) => {
                        last_err = "bridge exited".to_string();
                        self.stop().await;
                        continue;
                    }
                    Ok(_) => {}
                    Err(err) => {
                        last_err = format!("read bridge response failed: {err}");
                        self.stop().await;
                        continue;
                    }
                }

                let text = line.trim();
                if text.is_empty() {
                    last_err = "bridge returned empty response".to_string();
                    self.stop().await;
                    continue;
                }

                match serde_json::from_str::<Value>(text) {
                    Ok(v) => return Ok(v),
                    Err(err) => {
                        last_err = format!("bridge returned invalid json: {err}");
                        self.stop().await;
                        continue;
                    }
                }
            }
        }

        Err(last_err)
    }

    async fn ensure_started(&mut self) -> Result<(), String> {
        if self.process.is_some() {
            return Ok(());
        }

        let mut cmd = Command::new("node");
        cmd.arg(&self.bridge_path)
            .current_dir(&self.project_root)
            .env("BRIDGE_DAEMON", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start bridge: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "bridge stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "bridge stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "bridge stderr unavailable".to_string())?;
        tokio::spawn(log_bridge_stderr(stderr));

        self.process = Some(BridgeProcess {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        });
        Ok(())
    }

    async fn stop(&mut self) {
        if let Some(mut proc) = self.process.take() {
            let _ = proc.stdin.shutdown().await;
            let _ = proc.child.kill().await;
            let _ = proc.child.wait().await;
        }
    }
}

async fn log_bridge_stderr(stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let text = line.trim();
                if !text.is_empty() {
                    error!("[bridge] {text}");
                }
            }
            Err(err) => {
                error!("[bridge] stderr read error: {err}");
                break;
            }
        }
    }
}
