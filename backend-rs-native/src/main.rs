use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing::info;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRequest {
    config: RunConfig,
    #[serde(default)]
    workers: Option<usize>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlayerConfig {
    name: String,
    range: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
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
struct PreviewTagsRequest {
    #[serde(default)]
    board_text: String,
    #[serde(default)]
    variant: String,
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

#[derive(Debug, Serialize, Clone)]
struct NativePlayerReq {
    mode: String,
    hand_size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pool: Option<Vec<Vec<u8>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plan: Option<native_sim::PlanNodeReq>,
    #[serde(skip_serializing_if = "Option::is_none")]
    weight_pct: Option<u8>,
}

#[derive(Debug, Serialize)]
struct NativeSimReq {
    variant: String,
    iteration_cap: usize,
    board: Vec<u8>,
    dead: Vec<u8>,
    players: Vec<NativePlayerReq>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workers: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence_target_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence_min_iters: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence_level: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<u64>,
}

#[derive(Debug, Clone)]
enum RangeExpr {
    Or(Box<RangeExpr>, Box<RangeExpr>),
    And(Box<RangeExpr>, Box<RangeExpr>),
    Not(Box<RangeExpr>, Box<RangeExpr>),
    Atom(RangeAtom),
}

#[derive(Debug, Clone)]
struct CompiledRangeExpr {
    expr: RangeExpr,
    weight_pct: u8,
}

#[derive(Debug, Clone)]
enum RangeAtom {
    Any,
    Never,
    Exact(Vec<u8>),
    Specs(Vec<Vec<Spec>>),
    PercentTopExact {
        table: Arc<PercentileTable>,
        pct: f64,
        boundary: PercentBoundary,
    },
    PercentRangeExact {
        table: Arc<PercentileTable>,
        low_pct: f64,
        high_pct: f64,
        low_boundary: PercentBoundary,
        high_boundary: PercentBoundary,
    },
    PercentTopHeuristic {
        threshold: f64,
    },
    PercentRangeHeuristic {
        low_threshold: f64,
        high_threshold: f64,
    },
    RankPattern([u8; 13]),
    FixedPattern(Vec<RankSuitSpec>),
    Tag(TagAtom),
}

#[derive(Debug, Clone, Copy)]
struct Spec {
    ranks_mask: u16,
    rank_var: i8,
    suit_mode: u8,
    suit_value: i8,
}

#[derive(Debug, Clone, Copy)]
struct RankSuitSpec {
    rank: u8,
    suit: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TagAtom {
    TopPair { plus: bool },
    Overpair { plus: bool },
    TwoPair { plus: bool },
    Set { plus: bool },
    FlushDraw,
    Flush { plus: bool },
    StraightDraw { min_outs: u8 },
    Straight { plus: bool },
}

#[derive(Debug, Clone)]
enum LexToken {
    Atom(String),
    Comma,
    Colon,
    Bang,
    LParen,
    RParen,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PercentileTable {
    basis: usize,
    #[serde(rename = "sampleSize")]
    sample_size: usize,
    #[serde(rename = "topScoreKeys")]
    top_score_keys: Vec<u32>,
    #[serde(rename = "topRanks")]
    top_ranks: Vec<u32>,
    #[serde(rename = "scoreKeysByComboRank")]
    score_keys_by_combo_rank: Vec<u32>,
}

#[derive(Debug, Clone, Copy)]
enum PercentBoundary {
    None,
    All,
    Partial {
        boundary_score: u32,
        boundary_rank: usize,
    },
}

const RANKS: &str = "23456789TJQKA";
const SUITS: &str = "cdhs";
const DEFAULT_PREP_SEED: u32 = 0x9e37_79b9;
const ALL_RANKS_MASK: u16 = 0x1fff;
const MACRO_REPLACEMENTS: [(&str, &str); 21] = [
    ("$s", ":xx"),
    ("$o", ":xy"),
    ("$ds", ":xxyy"),
    ("$ss", ":xxyz"),
    ("$np", "!RR"),
    ("$op", ":RRON"),
    ("$tp", ":RROO"),
    ("$nt", "!RRR"),
    ("$B", "[A-J]"),
    ("$M", "[T-7]"),
    ("$Z", "[6-2]"),
    ("$L", "[A,2,3,4,5,6,7,8]"),
    ("$N", "[K-9]"),
    ("$F", "[K-J]"),
    ("$R", "[A-T]"),
    ("$W", "[A,2,3,4,5]"),
    ("$0g", "AKQJ-"),
    ("$1g", "(AKQT-,AKJT-,AQJT-)"),
    ("$2g", "(AKQ9-,AKT9-,AJT9-)"),
    ("&", ":"),
    ("\t", ""),
];
const PERCENTILE_SAMPLE_SIZE: usize = 30_000;
const PREVIEW_PARALLEL_THRESHOLD: usize = 400_000;
const EXACT_PLAN_POOL_LIMIT_HOLDEM: usize = 40_000;
const EXACT_PLAN_POOL_LIMIT_PLO4: usize = 180_000;
const EXACT_PLAN_POOL_LIMIT_PLO5: usize = 260_000;
const CARD_COUNT: usize = 52;
const TAG_COVERAGE_CACHE_MAX: usize = 192;
const TAG_COVERAGE_TOKEN_ORDER: [&str; 17] = [
    "@tp",
    "@tp+",
    "@overpair",
    "@overpair+",
    "@2p",
    "@2p+",
    "@set",
    "@set+",
    "@s",
    "@s+",
    "@f",
    "@f+",
    "@fd",
    "@sd",
    "@sd4",
    "@sd8",
    "@sd12",
];
const TAG_COVERAGE_COUNT: usize = TAG_COVERAGE_TOKEN_ORDER.len();
const TAG_IDX_TP: usize = 0;
const TAG_IDX_TP_PLUS: usize = 1;
const TAG_IDX_OVERPAIR: usize = 2;
const TAG_IDX_OVERPAIR_PLUS: usize = 3;
const TAG_IDX_2P: usize = 4;
const TAG_IDX_2P_PLUS: usize = 5;
const TAG_IDX_SET: usize = 6;
const TAG_IDX_SET_PLUS: usize = 7;
const TAG_IDX_STRAIGHT: usize = 8;
const TAG_IDX_STRAIGHT_PLUS: usize = 9;
const TAG_IDX_FLUSH: usize = 10;
const TAG_IDX_FLUSH_PLUS: usize = 11;
const TAG_IDX_FD: usize = 12;
const TAG_IDX_SD: usize = 13;
const TAG_IDX_SD4: usize = 14;
const TAG_IDX_SD8: usize = 15;
const TAG_IDX_SD12: usize = 16;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "odds=info,tower_http=info".to_string()),
        )
        .init();

    // Warm percentile tables once so first simulation prep stays fast.
    let prewarm = std::env::var("PREWARM_PERCENTILES")
        .ok()
        .map(|v| {
            let t = v.trim().to_ascii_lowercase();
            !(t == "0" || t == "false" || t == "off" || t == "no")
        })
        .unwrap_or(true);
    if prewarm {
        prewarm_percentile_tables();
    }

    let static_root = resolve_static_root()?;

    let port = std::env::var("PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .unwrap_or(8789);

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/sim/run", post(sim_run))
        .route("/api/sim/preview/tag", post(sim_preview_tag))
        .route("/api/sim/preview/tags", post(sim_preview_tags))
        .route("/api/sim/preview/range", post(sim_preview_range))
        .fallback_service(ServeDir::new(static_root.clone()))
        .layer(TraceLayer::new_for_http());

    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let bind_addr = format!("{host}:{port}");

    info!(
        "rust native backend listening on http://{bind_addr} (static root: {})",
        static_root.display()
    );
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn resolve_static_root() -> Result<PathBuf, std::io::Error> {
    match std::env::var("APP_STATIC_ROOT") {
        Ok(value) => Ok(PathBuf::from(value)),
        Err(_) => std::env::current_dir(),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sigterm) => {
                let _ = sigterm.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("shutdown signal received");
}

fn prewarm_percentile_tables() {
    for variant in ["holdem", "plo4", "plo5", "plo6"] {
        let _ = exact_percentile_table(variant, "ours");
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn sim_run(Json(req): Json<RunRequest>) -> (StatusCode, Json<Value>) {
    let total_start = Instant::now();
    let prepare_start = Instant::now();
    let prep = match prepare_native_request(&req.config, req.workers) {
        Ok(v) => v,
        Err(msg) => return error_json(StatusCode::BAD_REQUEST, &msg),
    };
    let prepare_ms = prepare_start.elapsed().as_secs_f64() * 1000.0;

    let native_start = Instant::now();
    let raw = match run_native_sim(&prep).await {
        Ok(v) => v,
        Err(msg) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    };
    let native_ms = native_start.elapsed().as_secs_f64() * 1000.0;

    let out = json!({
        "ok": true,
        "mode": "monte-native-rust",
        "raw": {
            "iterations": raw.iterations,
            "elapsedMs": raw.elapsed_ms,
            "wins": raw.wins,
            "ties": raw.ties,
            "losses": raw.losses,
            "equityShares": raw.equity_shares,
            "comboCounts": raw.combo_counts,
            "comboLists": raw.combo_lists,
            "classCounts": raw.class_counts,
            "confidenceReached": raw.confidence_reached,
            "confidenceHalfWidthPct": raw.confidence_half_width_pct,
            "confidenceLevel": raw.confidence_level
        },
        "timings": {
            "prepareMs": prepare_ms,
            "nativeMs": native_ms,
            "totalMs": total_start.elapsed().as_secs_f64() * 1000.0
        }
    });
    (StatusCode::OK, Json(out))
}

async fn sim_preview_tag(Json(req): Json<PreviewTagRequest>) -> (StatusCode, Json<Value>) {
    let variant = req.variant.trim().to_lowercase();
    let hand_size = match variant_hand_size(&variant) {
        Some(v) => v,
        None => return error_json(StatusCode::BAD_REQUEST, "unsupported variant"),
    };
    let board = match parse_cards_text(&req.board_text) {
        Ok(v) => v,
        Err(msg) => return error_json(StatusCode::BAD_REQUEST, &msg),
    };
    if board.len() < 3 || board.len() > 5 {
        let empty = json!({ "matched": 0, "total": 0, "pct": 0, "approx": false });
        return (
            StatusCode::OK,
            Json(json!({ "ok": true, "combos": [], "coverage": empty })),
        );
    }

    let tag = match normalize_tag_token(&req.tag) {
        Some(t) => t,
        None => {
            let empty = coverage_json(0, 0);
            return (
                StatusCode::OK,
                Json(json!({ "ok": true, "combos": [], "coverage": empty })),
            );
        }
    };

    let cov_variant = variant.clone();
    let cov_board = board.clone();
    let bundle = match tokio::task::spawn_blocking(move || {
        tag_coverage_bundle_for(&cov_variant, hand_size, &cov_board)
    })
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return error_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("preview tag bundle task failed: {e}"),
            )
        }
    };
    let combos = preview_tag_core_combos_from_bundle(&bundle, tag);
    let matched = tag_coverage_index(tag)
        .and_then(|idx| bundle.matched_by_tag.get(idx).copied())
        .unwrap_or(0);
    let coverage = coverage_json(matched, bundle.total);
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "combos": combos, "coverage": coverage })),
    )
}

async fn sim_preview_tags(Json(req): Json<PreviewTagsRequest>) -> (StatusCode, Json<Value>) {
    let variant = req.variant.trim().to_lowercase();
    let hand_size = match variant_hand_size(&variant) {
        Some(v) => v,
        None => return error_json(StatusCode::BAD_REQUEST, "unsupported variant"),
    };
    let board = match parse_cards_text(&req.board_text) {
        Ok(v) => v,
        Err(msg) => return error_json(StatusCode::BAD_REQUEST, &msg),
    };

    let mut coverage_by_tag = serde_json::Map::<String, Value>::new();
    if board.len() < 3 || board.len() > 5 {
        for tag in TAG_COVERAGE_TOKEN_ORDER {
            coverage_by_tag.insert(tag.to_string(), coverage_json(0, 0));
        }
        return (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "total": 0,
                "coverageByTag": coverage_by_tag
            })),
        );
    }

    let cov_variant = variant.clone();
    let cov_board = board.clone();
    let bundle = match tokio::task::spawn_blocking(move || {
        tag_coverage_bundle_for(&cov_variant, hand_size, &cov_board)
    })
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return error_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("preview tags bundle task failed: {e}"),
            )
        }
    };

    for (idx, tag) in TAG_COVERAGE_TOKEN_ORDER.iter().enumerate() {
        let matched = bundle.matched_by_tag.get(idx).copied().unwrap_or(0);
        coverage_by_tag.insert((*tag).to_string(), coverage_json(matched, bundle.total));
    }
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "total": bundle.total,
            "coverageByTag": coverage_by_tag
        })),
    )
}

async fn sim_preview_range(Json(req): Json<PreviewRangeRequest>) -> (StatusCode, Json<Value>) {
    let variant = req.variant.trim().to_lowercase();
    let hand_size = match variant_hand_size(&variant) {
        Some(v) => v,
        None => return error_json(StatusCode::BAD_REQUEST, "unsupported variant"),
    };
    let board = match parse_cards_text(&req.board_text) {
        Ok(v) => v,
        Err(msg) => return error_json(StatusCode::BAD_REQUEST, &msg),
    };
    if board.len() > 5 {
        return error_json(StatusCode::BAD_REQUEST, "board must have at most 5 cards");
    }

    let dead = Vec::<u8>::new();
    let base = base_deck(&board, &dead);
    let total = n_choose_k(base.len(), hand_size);

    let range_text = req.range_text.trim();
    let range_compact = range_text
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    if let Some(tag) = normalize_tag_token(&range_compact) {
        let profile_norm = normalize_percentile_profile(
            &variant,
            req.percentile_profile.as_deref().unwrap_or_default(),
        );
        let sampler = NativePlayerReq {
            mode: "plan".to_string(),
            hand_size,
            pool: None,
            plan: Some(native_sim::PlanNodeReq::Tag {
                tag: plan_tag_from_atom(tag),
            }),
            weight_pct: None,
        };
        let cache_key =
            sampler_cache_key(&variant, hand_size, &board, &[], range_text, &profile_norm);
        sampler_cache_put(cache_key, &sampler);

        let cov_variant = variant.clone();
        let cov_board = board.clone();
        let bundle = match tokio::task::spawn_blocking(move || {
            tag_coverage_bundle_for(&cov_variant, hand_size, &cov_board)
        })
        .await
        {
            Ok(v) => v,
            Err(e) => {
                return error_json(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("preview pure-tag task failed: {e}"),
                )
            }
        };
        let matched = tag_coverage_index(tag)
            .and_then(|idx| bundle.matched_by_tag.get(idx).copied())
            .unwrap_or(0);
        let out = coverage_json(matched, bundle.total);
        return (StatusCode::OK, Json(json!({ "ok": true, "coverage": out })));
    }

    let profile_norm = normalize_percentile_profile(
        &variant,
        req.percentile_profile.as_deref().unwrap_or_default(),
    );
    let compiled = match compile_range_expr(
        range_text,
        &variant,
        hand_size,
        req.percentile_profile.as_deref(),
    ) {
        Ok(v) => v,
        Err(msg) => {
            return (
                StatusCode::OK,
                Json(json!({
                    "ok": false,
                    "error": msg
                })),
            );
        }
    };

    cache_sampler_from_preview(
        &variant,
        hand_size,
        &board,
        range_text,
        &profile_norm,
        &compiled,
    );

    if is_any_expr(&compiled.expr) {
        let out = json!({ "matched": total, "total": total, "pct": 100, "approx": false });
        return (StatusCode::OK, Json(json!({ "ok": true, "coverage": out })));
    }

    let cov_board = board.clone();
    let cov_base = base.clone();
    let cov_expr = compiled.expr.clone();
    let (matched, approx) = match tokio::task::spawn_blocking(move || {
        estimate_coverage(&cov_base, hand_size, total, |hand| {
            range_expr_match(&cov_expr, hand, &cov_board)
        })
    })
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return error_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("preview range coverage task failed: {e}"),
            )
        }
    };
    let out = json!({
        "matched": matched,
        "total": total,
        "pct": if total > 0 { (matched as f64 * 100.0) / total as f64 } else { 0.0 },
        "approx": approx
    });
    (StatusCode::OK, Json(json!({ "ok": true, "coverage": out })))
}

fn prepare_native_request(cfg: &RunConfig, workers: Option<usize>) -> Result<NativeSimReq, String> {
    let variant = cfg.variant.trim().to_lowercase();
    let hand_size = variant_hand_size(&variant).ok_or_else(|| "unsupported variant".to_string())?;
    if cfg.players.len() < 2 || cfg.players.len() > 6 {
        return Err("players must be between 2 and 6".to_string());
    }

    let board = parse_cards_text(&cfg.board)?;
    if board.len() > 5 {
        return Err("board must have at most 5 cards".to_string());
    }
    let dead = parse_cards_text(&cfg.dead)?;
    validate_disjoint(&board, &dead)?;

    let profile = cfg.percentile_profile.as_deref();
    let players = cfg
        .players
        .par_iter()
        .enumerate()
        .map(|(idx, p)| {
            let seed = DEFAULT_PREP_SEED
                .wrapping_add((idx as u32).wrapping_add(1).wrapping_mul(0x9e37_79b9));
            let mut prep_rng = JsRng::new(seed);
            build_sampler_for_range(
                &variant,
                hand_size,
                &board,
                &dead,
                p.range.trim(),
                profile,
                &mut prep_rng,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(NativeSimReq {
        variant,
        iteration_cap: cfg.iteration_cap.max(1) as usize,
        board,
        dead,
        players,
        workers: workers.and_then(|w| if w > 0 { Some(w) } else { None }),
        confidence_target_pct: cfg.confidence_target_pct.filter(|v| *v > 0.0),
        confidence_min_iters: cfg.confidence_min_iterations.and_then(|v| {
            if v > 0 {
                Some(v as usize)
            } else {
                None
            }
        }),
        confidence_level: cfg.confidence_level.filter(|v| *v > 0.0),
        seed: Some(rand::random::<u64>()),
    })
}

fn build_sampler_for_range(
    variant: &str,
    hand_size: usize,
    board: &[u8],
    dead: &[u8],
    raw_range: &str,
    percentile_profile: Option<&str>,
    prep_rng: &mut JsRng,
) -> Result<NativePlayerReq, String> {
    let range = raw_range.trim();
    let profile_norm =
        normalize_percentile_profile(variant, percentile_profile.unwrap_or_default());
    let cache_key = sampler_cache_key(variant, hand_size, board, dead, range, &profile_norm);
    if let Some(cached) = sampler_cache_get(&cache_key) {
        let can_upgrade_plan = cached.mode == "plan"
            && exact_plan_pool_limit(variant) > 0
            && !plan_pool_too_large_contains(&cache_key);
        if !can_upgrade_plan {
            return Ok(cached);
        }
    }

    let compiled = compile_range_expr(range, variant, hand_size, percentile_profile)?;
    let expr = &compiled.expr;
    let weight_pct = compiled.weight_pct;
    if weight_pct == 0 {
        return Err("range appears empty on this board/dead-card setup".to_string());
    }
    let has_weight = weight_pct < 100;
    let weight_opt = if has_weight { Some(weight_pct) } else { None };

    if is_any_expr(expr) {
        let sampler = NativePlayerReq {
            mode: "all".to_string(),
            hand_size,
            pool: None,
            plan: None,
            weight_pct: weight_opt,
        };
        sampler_cache_put(cache_key, &sampler);
        return Ok(sampler);
    }

    if let Some(plan) = range_expr_to_plan(expr) {
        let limit = exact_plan_pool_limit(variant);
        if limit > 0 {
            let base = base_deck(board, dead);
            match collect_exact_pool_with_limit(&base, hand_size, board, expr, limit) {
                ExactPoolCollect::Empty => {
                    return Err("range appears empty on this board/dead-card setup".to_string());
                }
                ExactPoolCollect::Full(pool) => {
                    let sampler = NativePlayerReq {
                        mode: "pool".to_string(),
                        hand_size,
                        pool: Some(pool),
                        plan: None,
                        weight_pct: weight_opt,
                    };
                    sampler_cache_put(cache_key, &sampler);
                    return Ok(sampler);
                }
                ExactPoolCollect::TooLarge => {
                    plan_pool_too_large_mark(&cache_key);
                }
            }
        }
        let sampler = NativePlayerReq {
            mode: "plan".to_string(),
            hand_size,
            pool: None,
            plan: Some(plan),
            weight_pct: weight_opt,
        };
        sampler_cache_put(cache_key, &sampler);
        return Ok(sampler);
    }

    let base = base_deck(board, dead);
    let total = n_choose_k(base.len(), hand_size);
    let cap = pool_cap_for(hand_size);
    let (matched, pool, _approx) =
        build_pool_exact_with_cap(&base, hand_size, board, expr, cap, prep_rng);
    if matched == 0 || pool.is_empty() {
        return Err("range appears empty on this board/dead-card setup".to_string());
    }
    if matched >= total {
        let sampler = NativePlayerReq {
            mode: "all".to_string(),
            hand_size,
            pool: None,
            plan: None,
            weight_pct: weight_opt,
        };
        sampler_cache_put(cache_key, &sampler);
        return Ok(sampler);
    }
    let sampler = NativePlayerReq {
        mode: "pool".to_string(),
        hand_size,
        pool: Some(pool),
        plan: None,
        weight_pct: weight_opt,
    };
    sampler_cache_put(cache_key, &sampler);
    Ok(sampler)
}

#[derive(Debug)]
enum ExactPoolCollect {
    Empty,
    Full(Vec<Vec<u8>>),
    TooLarge,
}

fn exact_plan_pool_limit(variant: &str) -> usize {
    match variant {
        "holdem" => EXACT_PLAN_POOL_LIMIT_HOLDEM,
        "plo4" => EXACT_PLAN_POOL_LIMIT_PLO4,
        "plo5" => EXACT_PLAN_POOL_LIMIT_PLO5,
        _ => 0,
    }
}

fn collect_exact_pool_with_limit(
    base: &[u8],
    hand_size: usize,
    board: &[u8],
    expr: &RangeExpr,
    limit: usize,
) -> ExactPoolCollect {
    if base.len() < hand_size || hand_size == 0 || limit == 0 {
        return ExactPoolCollect::Empty;
    }

    let total = n_choose_k(base.len(), hand_size);
    if total >= PREVIEW_PARALLEL_THRESHOLD && rayon::current_num_threads() > 1 {
        return collect_exact_pool_with_limit_parallel(base, hand_size, board, expr, limit);
    }

    let mut overflow = false;
    let mut hand = vec![0u8; hand_size];
    let mut pool = Vec::<Vec<u8>>::new();
    collect_exact_pool_with_limit_rec(
        0,
        0,
        base,
        &mut hand,
        board,
        expr,
        limit,
        &mut pool,
        &mut overflow,
    );

    if overflow {
        ExactPoolCollect::TooLarge
    } else if pool.is_empty() {
        ExactPoolCollect::Empty
    } else {
        ExactPoolCollect::Full(pool)
    }
}

fn collect_exact_pool_with_limit_parallel(
    base: &[u8],
    hand_size: usize,
    board: &[u8],
    expr: &RangeExpr,
    limit: usize,
) -> ExactPoolCollect {
    let max_start = base.len() - hand_size;
    let matched = AtomicUsize::new(0);
    let overflow = AtomicBool::new(false);

    let mut pool = (0..=max_start)
        .into_par_iter()
        .map(|first_idx| {
            let mut hand = vec![0u8; hand_size];
            hand[0] = base[first_idx];
            let mut local = Vec::<Vec<u8>>::new();
            collect_exact_pool_with_limit_parallel_rec(
                base,
                first_idx + 1,
                1,
                &mut hand,
                board,
                expr,
                limit,
                &matched,
                &overflow,
                &mut local,
            );
            local
        })
        .reduce(Vec::<Vec<u8>>::new, |mut acc, mut part| {
            acc.append(&mut part);
            acc
        });

    if overflow.load(Ordering::Relaxed) {
        return ExactPoolCollect::TooLarge;
    }
    let keep = matched.load(Ordering::Relaxed).min(limit);
    if pool.len() > keep {
        pool.truncate(keep);
    }
    if pool.is_empty() {
        ExactPoolCollect::Empty
    } else {
        ExactPoolCollect::Full(pool)
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_exact_pool_with_limit_rec(
    start: usize,
    depth: usize,
    base: &[u8],
    hand: &mut [u8],
    board: &[u8],
    expr: &RangeExpr,
    limit: usize,
    pool: &mut Vec<Vec<u8>>,
    overflow: &mut bool,
) {
    if *overflow {
        return;
    }
    if depth == hand.len() {
        if range_expr_match(expr, hand, board) {
            if pool.len() >= limit {
                *overflow = true;
                return;
            }
            pool.push(hand.to_vec());
        }
        return;
    }

    let need = hand.len() - depth;
    if base.len() < need || start > base.len() - need {
        return;
    }
    for i in start..=base.len() - need {
        if *overflow {
            return;
        }
        hand[depth] = base[i];
        collect_exact_pool_with_limit_rec(
            i + 1,
            depth + 1,
            base,
            hand,
            board,
            expr,
            limit,
            pool,
            overflow,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_exact_pool_with_limit_parallel_rec(
    base: &[u8],
    start: usize,
    depth: usize,
    hand: &mut [u8],
    board: &[u8],
    expr: &RangeExpr,
    limit: usize,
    matched: &AtomicUsize,
    overflow: &AtomicBool,
    local: &mut Vec<Vec<u8>>,
) {
    if overflow.load(Ordering::Relaxed) {
        return;
    }
    if depth == hand.len() {
        if range_expr_match(expr, hand, board) {
            let prev = matched.fetch_add(1, Ordering::Relaxed);
            if prev >= limit {
                overflow.store(true, Ordering::Relaxed);
                return;
            }
            local.push(hand.to_vec());
        }
        return;
    }

    let need = hand.len() - depth;
    if base.len() < need || start > base.len() - need {
        return;
    }
    for i in start..=base.len() - need {
        if overflow.load(Ordering::Relaxed) {
            return;
        }
        hand[depth] = base[i];
        collect_exact_pool_with_limit_parallel_rec(
            base,
            i + 1,
            depth + 1,
            hand,
            board,
            expr,
            limit,
            matched,
            overflow,
            local,
        );
    }
}

fn cache_sampler_from_preview(
    variant: &str,
    hand_size: usize,
    board: &[u8],
    range: &str,
    profile_norm: &str,
    compiled: &CompiledRangeExpr,
) {
    let weight_pct = compiled.weight_pct;
    if weight_pct == 0 {
        return;
    }
    let weight_opt = if weight_pct < 100 {
        Some(weight_pct)
    } else {
        None
    };

    let sampler = if is_any_expr(&compiled.expr) {
        Some(NativePlayerReq {
            mode: "all".to_string(),
            hand_size,
            pool: None,
            plan: None,
            weight_pct: weight_opt,
        })
    } else if let Some(plan) = range_expr_to_plan(&compiled.expr) {
        Some(NativePlayerReq {
            mode: "plan".to_string(),
            hand_size,
            pool: None,
            plan: Some(plan),
            weight_pct: weight_opt,
        })
    } else {
        None
    };

    if let Some(s) = sampler {
        let cache_key = sampler_cache_key(variant, hand_size, board, &[], range, profile_norm);
        sampler_cache_put(cache_key, &s);
    }
}

fn range_expr_to_plan(expr: &RangeExpr) -> Option<native_sim::PlanNodeReq> {
    match expr {
        RangeExpr::Or(left, right) => Some(native_sim::PlanNodeReq::Or {
            left: Box::new(range_expr_to_plan(left)?),
            right: Box::new(range_expr_to_plan(right)?),
        }),
        RangeExpr::And(left, right) => Some(native_sim::PlanNodeReq::And {
            left: Box::new(range_expr_to_plan(left)?),
            right: Box::new(range_expr_to_plan(right)?),
        }),
        RangeExpr::Not(left, right) => Some(native_sim::PlanNodeReq::Not {
            left: Box::new(range_expr_to_plan(left)?),
            right: Box::new(range_expr_to_plan(right)?),
        }),
        RangeExpr::Atom(atom) => atom_to_plan(atom),
    }
}

fn atom_to_plan(atom: &RangeAtom) -> Option<native_sim::PlanNodeReq> {
    match atom {
        RangeAtom::Any => Some(native_sim::PlanNodeReq::Specs {
            entries: vec![Vec::new()],
        }),
        RangeAtom::Never => {
            let any = native_sim::PlanNodeReq::Specs {
                entries: vec![Vec::new()],
            };
            Some(native_sim::PlanNodeReq::Not {
                left: Box::new(any.clone()),
                right: Box::new(any),
            })
        }
        RangeAtom::Exact(cards) => Some(native_sim::PlanNodeReq::Specs {
            entries: vec![cards.iter().map(|c| exact_card_spec(*c)).collect()],
        }),
        RangeAtom::Specs(entries) => Some(native_sim::PlanNodeReq::Specs {
            entries: entries
                .iter()
                .map(|entry| entry.iter().copied().map(spec_to_plan_spec).collect())
                .collect(),
        }),
        RangeAtom::PercentTopExact { table, pct, .. } => Some(native_sim::PlanNodeReq::PctBits {
            bits_b64: None,
            bits: Some(pct_top_bits(&table, *pct)),
        }),
        RangeAtom::PercentRangeExact {
            low_pct,
            high_pct,
            table,
            ..
        } => {
            let mut high_bits = pct_top_bits(&table, *high_pct);
            let low_bits = pct_top_bits(&table, *low_pct);
            for (dst, low) in high_bits.iter_mut().zip(low_bits.iter()) {
                *dst &= !*low;
            }
            Some(native_sim::PlanNodeReq::PctBits {
                bits_b64: None,
                bits: Some(high_bits),
            })
        }
        RangeAtom::PercentTopHeuristic { threshold } => {
            Some(native_sim::PlanNodeReq::HeuristicTop {
                threshold: *threshold,
            })
        }
        RangeAtom::PercentRangeHeuristic {
            low_threshold,
            high_threshold,
        } => Some(native_sim::PlanNodeReq::HeuristicRange {
            low_threshold: *low_threshold,
            high_threshold: *high_threshold,
        }),
        RangeAtom::RankPattern(req) => {
            let mut entry = Vec::<native_sim::SpecReq>::new();
            for (rank_idx, count) in req.iter().enumerate() {
                for _ in 0..*count {
                    entry.push(native_sim::SpecReq {
                        ranks_mask: 1u16 << rank_idx,
                        rank_var: -1,
                        suit_mode: 0,
                        suit_value: -1,
                    });
                }
            }
            Some(native_sim::PlanNodeReq::Specs {
                entries: vec![entry],
            })
        }
        RangeAtom::FixedPattern(specs) => Some(native_sim::PlanNodeReq::Specs {
            entries: vec![specs
                .iter()
                .map(|s| native_sim::SpecReq {
                    ranks_mask: 1u16 << s.rank,
                    rank_var: -1,
                    suit_mode: if s.suit.is_some() { 1 } else { 0 },
                    suit_value: s.suit.map(|v| v as i8).unwrap_or(-1),
                })
                .collect()],
        }),
        RangeAtom::Tag(tag) => Some(native_sim::PlanNodeReq::Tag {
            tag: plan_tag_from_atom(*tag),
        }),
    }
}

fn spec_to_plan_spec(s: Spec) -> native_sim::SpecReq {
    native_sim::SpecReq {
        ranks_mask: s.ranks_mask,
        rank_var: s.rank_var,
        suit_mode: s.suit_mode,
        suit_value: s.suit_value,
    }
}

fn exact_card_spec(card: u8) -> native_sim::SpecReq {
    native_sim::SpecReq {
        ranks_mask: 1u16 << card_rank(card),
        rank_var: -1,
        suit_mode: 1,
        suit_value: card_suit(card) as i8,
    }
}

fn plan_tag_from_atom(tag: TagAtom) -> native_sim::PlanTagReq {
    match tag {
        TagAtom::TopPair { plus } => native_sim::PlanTagReq {
            kind: native_sim::PlanTagKind::TopPair,
            plus,
            min_outs: 0,
        },
        TagAtom::Overpair { plus } => native_sim::PlanTagReq {
            kind: native_sim::PlanTagKind::Overpair,
            plus,
            min_outs: 0,
        },
        TagAtom::TwoPair { plus } => native_sim::PlanTagReq {
            kind: native_sim::PlanTagKind::TwoPair,
            plus,
            min_outs: 0,
        },
        TagAtom::Set { plus } => native_sim::PlanTagReq {
            kind: native_sim::PlanTagKind::Set,
            plus,
            min_outs: 0,
        },
        TagAtom::FlushDraw => native_sim::PlanTagReq {
            kind: native_sim::PlanTagKind::FlushDraw,
            plus: false,
            min_outs: 0,
        },
        TagAtom::Flush { plus } => native_sim::PlanTagReq {
            kind: native_sim::PlanTagKind::Flush,
            plus,
            min_outs: 0,
        },
        TagAtom::StraightDraw { min_outs } => native_sim::PlanTagReq {
            kind: native_sim::PlanTagKind::StraightDraw,
            plus: false,
            min_outs,
        },
        TagAtom::Straight { plus } => native_sim::PlanTagReq {
            kind: native_sim::PlanTagKind::Straight,
            plus,
            min_outs: 0,
        },
    }
}

fn pct_top_bits(table: &PercentileTable, pct: f64) -> Vec<u8> {
    let combo_space = table.score_keys_by_combo_rank.len();
    let mut bits = vec![0u8; (combo_space + 7) / 8];
    if combo_space == 0 || table.sample_size == 0 {
        return bits;
    }

    let clamped = pct.clamp(0.0, 100.0);
    let basis = table.basis.max(1);
    let steps = 100usize.saturating_mul(basis);
    let idx = ((clamped * basis as f64).round() as usize).min(steps);
    let count = ((idx as f64 / steps as f64) * table.sample_size as f64).floor() as usize;
    if count == 0 {
        return bits;
    }
    if count >= table.sample_size {
        for combo_idx in 0..combo_space {
            set_bit(&mut bits, combo_idx);
        }
        return bits;
    }
    if idx >= table.top_score_keys.len() || idx >= table.top_ranks.len() {
        return bits;
    }

    let boundary_score = table.top_score_keys[idx];
    let boundary_rank = table.top_ranks[idx] as usize;
    for rank in 0..combo_space {
        let score = table.score_keys_by_combo_rank[rank];
        if score > boundary_score || (score == boundary_score && rank <= boundary_rank) {
            set_bit(&mut bits, rank);
        }
    }
    bits
}

fn set_bit(bits: &mut [u8], idx: usize) {
    let byte = idx >> 3;
    if byte >= bits.len() {
        return;
    }
    bits[byte] |= 1u8 << (idx & 7);
}

fn sampler_cache_key(
    variant: &str,
    hand_size: usize,
    board: &[u8],
    dead: &[u8],
    raw_range: &str,
    percentile_profile: &str,
) -> String {
    let mut dead_sorted = dead.to_vec();
    dead_sorted.sort_unstable();
    let range_norm = raw_range
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    format!(
        "{variant}|h:{hand_size}|b:{}|d:{}|pp:{percentile_profile}|r:{range_norm}",
        cards_key(board),
        cards_key(&dead_sorted)
    )
}

fn cards_key(cards: &[u8]) -> String {
    if cards.is_empty() {
        return "-".to_string();
    }
    cards
        .iter()
        .map(|c| format!("{c:02}"))
        .collect::<Vec<_>>()
        .join("")
}

#[derive(Default)]
struct SamplerCacheStore {
    map: HashMap<String, NativePlayerReq>,
    lru: VecDeque<String>,
}

impl SamplerCacheStore {
    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.lru.iter().position(|k| k == key) {
            self.lru.remove(pos);
        }
        self.lru.push_back(key.to_string());
    }

    fn get(&mut self, key: &str) -> Option<NativePlayerReq> {
        let out = self.map.get(key).cloned();
        if out.is_some() {
            self.touch(key);
        }
        out
    }

    fn insert(&mut self, key: String, sampler: NativePlayerReq) {
        if self.map.contains_key(&key) {
            self.map.insert(key.clone(), sampler);
            self.touch(&key);
            return;
        }
        while self.map.len() >= SAMPLER_CACHE_MAX {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            self.map.remove(&oldest);
        }
        self.touch(&key);
        self.map.insert(key, sampler);
    }
}

fn sampler_cache_get(key: &str) -> Option<NativePlayerReq> {
    let cache = SAMPLER_CACHE.get_or_init(|| Mutex::new(SamplerCacheStore::default()));
    let mut guard = cache.lock().ok()?;
    guard.get(key)
}

fn sampler_cache_put(key: String, sampler: &NativePlayerReq) {
    let cache = SAMPLER_CACHE.get_or_init(|| Mutex::new(SamplerCacheStore::default()));
    let mut guard = match cache.lock() {
        Ok(v) => v,
        Err(_) => return,
    };
    guard.insert(key, sampler.clone());
}

fn tag_coverage_cache_key(variant: &str, board: &[u8]) -> String {
    let mut board_sorted = board.to_vec();
    board_sorted.sort_unstable();
    format!("{variant}|b:{}", cards_key(&board_sorted))
}

fn tag_coverage_cache_get(key: &str) -> Option<Arc<TagCoverageBundle>> {
    let cache = TAG_COVERAGE_CACHE.get_or_init(|| Mutex::new(TagCoverageCacheStore::default()));
    let mut guard = cache.lock().ok()?;
    guard.get(key)
}

fn tag_coverage_cache_put(key: String, bundle: Arc<TagCoverageBundle>) {
    let cache = TAG_COVERAGE_CACHE.get_or_init(|| Mutex::new(TagCoverageCacheStore::default()));
    let mut guard = match cache.lock() {
        Ok(v) => v,
        Err(_) => return,
    };
    guard.insert(key, bundle);
}

fn tag_bit(idx: usize) -> u32 {
    1u32 << idx
}

fn tag_coverage_index(tag: TagAtom) -> Option<usize> {
    match tag {
        TagAtom::TopPair { plus: false } => Some(TAG_IDX_TP),
        TagAtom::TopPair { plus: true } => Some(TAG_IDX_TP_PLUS),
        TagAtom::Overpair { plus: false } => Some(TAG_IDX_OVERPAIR),
        TagAtom::Overpair { plus: true } => Some(TAG_IDX_OVERPAIR_PLUS),
        TagAtom::TwoPair { plus: false } => Some(TAG_IDX_2P),
        TagAtom::TwoPair { plus: true } => Some(TAG_IDX_2P_PLUS),
        TagAtom::Set { plus: false } => Some(TAG_IDX_SET),
        TagAtom::Set { plus: true } => Some(TAG_IDX_SET_PLUS),
        TagAtom::Straight { plus: false } => Some(TAG_IDX_STRAIGHT),
        TagAtom::Straight { plus: true } => Some(TAG_IDX_STRAIGHT_PLUS),
        TagAtom::Flush { plus: false } => Some(TAG_IDX_FLUSH),
        TagAtom::Flush { plus: true } => Some(TAG_IDX_FLUSH_PLUS),
        TagAtom::FlushDraw => Some(TAG_IDX_FD),
        TagAtom::StraightDraw { min_outs: 1 } => Some(TAG_IDX_SD),
        TagAtom::StraightDraw { min_outs: 4 } => Some(TAG_IDX_SD4),
        TagAtom::StraightDraw { min_outs: 8 } => Some(TAG_IDX_SD8),
        TagAtom::StraightDraw { min_outs: 12 } => Some(TAG_IDX_SD12),
        _ => None,
    }
}

fn add_counts_from_mask(mut mask: u32, out: &mut [usize; TAG_COVERAGE_COUNT]) {
    while mask != 0 {
        let bit = mask.trailing_zeros() as usize;
        if bit < TAG_COVERAGE_COUNT {
            out[bit] = out[bit].saturating_add(1);
        }
        mask &= mask - 1;
    }
}

fn core_tag_mask_for_coverage(core: [u8; 2], board: &[u8], is_holdem: bool) -> u32 {
    if board.len() < 3 {
        return 0;
    }
    let (made_flush, flush_draw) = core_flush_flags(core, board, is_holdem);
    let straight_now = if is_holdem {
        has_holdem_straight_by_ranks(&core, board)
    } else {
        has_omaha_core_straight(core, board)
    };
    let outs = if board.len() < 5 && !straight_now {
        core_straight_outs(core, board, is_holdem)
    } else {
        0
    };
    let ready = evaluate_core_ready_state(core, board, is_holdem);

    let mut mask = 0u32;
    let is_top_pair = ready.class_id == 1 && ready.pair_rank == ready.top_board;
    let is_top_pair_plus = ready.class_id == 1 && ready.pair_rank >= ready.top_board;

    if is_top_pair {
        mask |= tag_bit(TAG_IDX_TP);
    }
    if ready.class_id >= 2 || is_top_pair_plus {
        mask |= tag_bit(TAG_IDX_TP_PLUS);
    }

    if is_holdem {
        if ready.is_overpair {
            mask |= tag_bit(TAG_IDX_OVERPAIR);
        }
        if ready.is_overpair || ready.class_id >= 2 {
            mask |= tag_bit(TAG_IDX_OVERPAIR_PLUS);
        }
    }

    if ready.class_id == 2 {
        mask |= tag_bit(TAG_IDX_2P);
    }
    if ready.class_id >= 2 {
        mask |= tag_bit(TAG_IDX_2P_PLUS);
    }
    if ready.class_id == 3 {
        mask |= tag_bit(TAG_IDX_SET);
    }
    if ready.class_id >= 3 {
        mask |= tag_bit(TAG_IDX_SET_PLUS);
    }

    if straight_now {
        mask |= tag_bit(TAG_IDX_STRAIGHT);
    }
    if ready.class_id >= 4 {
        mask |= tag_bit(TAG_IDX_STRAIGHT_PLUS);
    }

    if made_flush {
        mask |= tag_bit(TAG_IDX_FLUSH);
    }
    if ready.class_id >= 5 {
        mask |= tag_bit(TAG_IDX_FLUSH_PLUS);
    }
    if flush_draw {
        mask |= tag_bit(TAG_IDX_FD);
    }

    if board.len() < 5 && !straight_now {
        if outs >= 1 {
            mask |= tag_bit(TAG_IDX_SD);
        }
        if outs >= 4 {
            mask |= tag_bit(TAG_IDX_SD4);
        }
        if outs >= 8 {
            mask |= tag_bit(TAG_IDX_SD8);
        }
        if outs >= 12 {
            mask |= tag_bit(TAG_IDX_SD12);
        }
    }
    mask
}

fn build_tag_coverage_bundle(variant: &str, hand_size: usize, board: &[u8]) -> TagCoverageBundle {
    let base = base_deck(board, &[]);
    let total = n_choose_k(base.len(), hand_size);
    let is_holdem = variant == "holdem";

    let mut pair_tag_masks = vec![0u32; CARD_COUNT * CARD_COUNT];
    for i in 0..base.len() {
        let c1 = base[i];
        for j in (i + 1)..base.len() {
            let c2 = base[j];
            let mask = core_tag_mask_for_coverage([c1, c2], board, is_holdem);
            let idx12 = c1 as usize * CARD_COUNT + c2 as usize;
            let idx21 = c2 as usize * CARD_COUNT + c1 as usize;
            pair_tag_masks[idx12] = mask;
            pair_tag_masks[idx21] = mask;
        }
    }

    let mut matched_by_tag = [0usize; TAG_COVERAGE_COUNT];
    if hand_size == 2 {
        for i in 0..base.len() {
            let c1 = base[i];
            for j in (i + 1)..base.len() {
                let c2 = base[j];
                let idx = c1 as usize * CARD_COUNT + c2 as usize;
                add_counts_from_mask(pair_tag_masks[idx], &mut matched_by_tag);
            }
        }
    } else {
        enumerate_hands(&base, hand_size, |hand| {
            let mut hand_mask = 0u32;
            for i in 0..hand.len().saturating_sub(1) {
                let row = hand[i] as usize * CARD_COUNT;
                for j in (i + 1)..hand.len() {
                    hand_mask |= pair_tag_masks[row + hand[j] as usize];
                }
            }
            add_counts_from_mask(hand_mask, &mut matched_by_tag);
        });
    }

    TagCoverageBundle {
        base,
        total,
        matched_by_tag,
        pair_tag_masks,
    }
}

fn tag_coverage_bundle_for(
    variant: &str,
    hand_size: usize,
    board: &[u8],
) -> Arc<TagCoverageBundle> {
    let key = tag_coverage_cache_key(variant, board);
    if let Some(cached) = tag_coverage_cache_get(&key) {
        return cached;
    }
    let built = Arc::new(build_tag_coverage_bundle(variant, hand_size, board));
    tag_coverage_cache_put(key, built.clone());
    built
}

fn preview_tag_core_combos_from_bundle(bundle: &TagCoverageBundle, tag: TagAtom) -> Vec<String> {
    let Some(idx) = tag_coverage_index(tag) else {
        return Vec::new();
    };
    let target_bit = tag_bit(idx);
    let use_suit = tag_uses_suit_labels(tag);
    let mut labels = BTreeSet::<String>::new();
    for i in 0..bundle.base.len() {
        let c1 = bundle.base[i];
        for j in (i + 1)..bundle.base.len() {
            let c2 = bundle.base[j];
            let mask = bundle.pair_tag_masks[c1 as usize * CARD_COUNT + c2 as usize];
            if (mask & target_bit) == 0 {
                continue;
            }
            let label = if use_suit {
                core_suit_label(c1, c2)
            } else {
                core_rank_label(c1, c2)
            };
            labels.insert(label);
        }
    }
    labels.into_iter().collect()
}

fn coverage_json(matched: usize, total: usize) -> Value {
    json!({
        "matched": matched,
        "total": total,
        "pct": if total > 0 { (matched as f64 * 100.0) / total as f64 } else { 0.0 },
        "approx": false
    })
}

fn estimate_coverage<F>(base: &[u8], hand_size: usize, total: usize, predicate: F) -> (usize, bool)
where
    F: Fn(&[u8]) -> bool + Sync,
{
    if total >= PREVIEW_PARALLEL_THRESHOLD && rayon::current_num_threads() > 1 {
        let matched = count_matching_hands_parallel(base, hand_size, &predicate);
        return (matched, false);
    }

    let mut matched = 0usize;
    enumerate_hands(base, hand_size, |hand| {
        if predicate(hand) {
            matched += 1;
        }
    });
    (matched, false)
}

fn count_matching_hands_parallel<F>(base: &[u8], hand_size: usize, predicate: &F) -> usize
where
    F: Fn(&[u8]) -> bool + Sync,
{
    if hand_size == 0 {
        return if predicate(&[]) { 1 } else { 0 };
    }
    if base.len() < hand_size {
        return 0;
    }
    let max_start = base.len() - hand_size;
    (0..=max_start)
        .into_par_iter()
        .map(|first_idx| {
            let mut hand = vec![0u8; hand_size];
            hand[0] = base[first_idx];
            count_matching_hands_rec(base, first_idx + 1, 1, &mut hand, predicate)
        })
        .sum()
}

fn count_matching_hands_rec<F>(
    base: &[u8],
    start: usize,
    depth: usize,
    hand: &mut [u8],
    predicate: &F,
) -> usize
where
    F: Fn(&[u8]) -> bool,
{
    if depth == hand.len() {
        return usize::from(predicate(hand));
    }

    let need = hand.len() - depth;
    if base.len() < need || start > base.len() - need {
        return 0;
    }

    let mut matched = 0usize;
    for i in start..=base.len() - need {
        hand[depth] = base[i];
        matched += count_matching_hands_rec(base, i + 1, depth + 1, hand, predicate);
    }
    matched
}

fn enumerate_hands<F>(base: &[u8], hand_size: usize, mut f: F)
where
    F: FnMut(&[u8]),
{
    let mut hand = vec![0u8; hand_size];

    fn rec<F>(start: usize, depth: usize, base: &[u8], hand: &mut [u8], f: &mut F)
    where
        F: FnMut(&[u8]),
    {
        if depth == hand.len() {
            f(hand);
            return;
        }
        let need = hand.len() - depth;
        if base.len() < need || start > base.len() - need {
            return;
        }
        for i in start..=base.len() - need {
            hand[depth] = base[i];
            rec(i + 1, depth + 1, base, hand, f);
        }
    }

    rec(0, 0, base, &mut hand, &mut f);
}

#[derive(Clone, Copy)]
struct JsRng {
    t: u32,
}

impl JsRng {
    fn new(seed: u32) -> Self {
        Self { t: seed }
    }

    fn next_f64(&mut self) -> f64 {
        self.t = self.t.wrapping_add(0x6d2b79f5);
        let mut r = ((self.t ^ (self.t >> 15)).wrapping_mul(1 | self.t)) as u32;
        r ^= r.wrapping_add((r ^ (r >> 7)).wrapping_mul(61 | r));
        ((r ^ (r >> 14)) as f64) / 4294967296.0
    }
}

fn build_pool_exact_with_cap(
    base: &[u8],
    hand_size: usize,
    board: &[u8],
    expr: &RangeExpr,
    cap: usize,
    rng: &mut JsRng,
) -> (usize, Vec<Vec<u8>>, bool) {
    let mut matched = 0usize;
    let mut pool = Vec::<Vec<u8>>::new();
    enumerate_hands(base, hand_size, |hand| {
        if range_expr_match(expr, hand, board) {
            matched += 1;
            if pool.len() < cap {
                pool.push(hand.to_vec());
            } else {
                // Reservoir replacement: keep a uniform capped sample across all matches.
                let j = (rng.next_f64() * matched as f64) as usize;
                if j < cap {
                    pool[j] = hand.to_vec();
                }
            }
        }
    });
    (matched, pool, false)
}

fn percentile_seed(variant: &str) -> u64 {
    // Keep heuristic percentile thresholds stable across runs for variants without
    // exact precomputed percentile tables.
    let mut h = 0xcbf29ce484222325u64;
    for b in variant.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h ^ 0x9E37_79B9_7F4A_7C15
}

static PERCENTILE_CACHE: OnceLock<Mutex<HashMap<String, Vec<f64>>>> = OnceLock::new();
static SAMPLER_CACHE: OnceLock<Mutex<SamplerCacheStore>> = OnceLock::new();
static TAG_COVERAGE_CACHE: OnceLock<Mutex<TagCoverageCacheStore>> = OnceLock::new();
static PLAN_POOL_TOO_LARGE_KEYS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static EXACT_PERCENTILE_TABLES: OnceLock<
    Mutex<HashMap<String, HashMap<String, Arc<PercentileTable>>>>,
> = OnceLock::new();
static CHOOSE_52_TABLE: OnceLock<[[usize; 7]; 53]> = OnceLock::new();
const SAMPLER_CACHE_MAX: usize = 96;

#[derive(Clone)]
struct TagCoverageBundle {
    base: Vec<u8>,
    total: usize,
    matched_by_tag: [usize; TAG_COVERAGE_COUNT],
    pair_tag_masks: Vec<u32>,
}

#[derive(Default)]
struct TagCoverageCacheStore {
    map: HashMap<String, Arc<TagCoverageBundle>>,
    lru: VecDeque<String>,
}

impl TagCoverageCacheStore {
    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.lru.iter().position(|k| k == key) {
            self.lru.remove(pos);
        }
        self.lru.push_back(key.to_string());
    }

    fn get(&mut self, key: &str) -> Option<Arc<TagCoverageBundle>> {
        let out = self.map.get(key).cloned();
        if out.is_some() {
            self.touch(key);
        }
        out
    }

    fn insert(&mut self, key: String, bundle: Arc<TagCoverageBundle>) {
        if self.map.contains_key(&key) {
            self.map.insert(key.clone(), bundle);
            self.touch(&key);
            return;
        }
        while self.map.len() >= TAG_COVERAGE_CACHE_MAX {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            self.map.remove(&oldest);
        }
        self.touch(&key);
        self.map.insert(key, bundle);
    }
}

fn plan_pool_too_large_contains(key: &str) -> bool {
    let cache = PLAN_POOL_TOO_LARGE_KEYS.get_or_init(|| Mutex::new(HashSet::new()));
    let guard = match cache.lock() {
        Ok(v) => v,
        Err(_) => return false,
    };
    guard.contains(key)
}

fn plan_pool_too_large_mark(key: &str) {
    let cache = PLAN_POOL_TOO_LARGE_KEYS.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key.to_string());
    }
}

fn percentile_threshold(variant: &str, pct: f64) -> f64 {
    let key = variant.to_lowercase();
    let cache = PERCENTILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap();
    let scores = guard.entry(key.clone()).or_insert_with(|| {
        let hand_size = variant_hand_size(&key).unwrap_or(2);
        let mut rng = SmallRng::seed_from_u64(percentile_seed(&key));
        let mut deck: Vec<u8> = (0u8..52u8).collect();
        let mut out = Vec::<f64>::with_capacity(PERCENTILE_SAMPLE_SIZE);
        for _ in 0..PERCENTILE_SAMPLE_SIZE {
            for i in 0..hand_size {
                let j = i + rng.gen_range(0..(52 - i));
                deck.swap(i, j);
            }
            out.push(evaluate_heuristic(&deck[..hand_size]));
        }
        out.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        out
    });

    if scores.is_empty() {
        return 0.0;
    }
    let clamped = pct.clamp(0.0, 100.0);
    let idx = ((clamped / 100.0) * scores.len() as f64).floor() as usize;
    let idx = idx.min(scores.len().saturating_sub(1));
    scores[idx]
}

fn evaluate_heuristic(hand: &[u8]) -> f64 {
    let mut ranks = hand
        .iter()
        .map(|c| card_rank_value(*c) as i32)
        .collect::<Vec<_>>();
    ranks.sort_unstable_by(|a, b| b.cmp(a));

    let mut rank_counts = [0u8; 15];
    let mut suit_counts = [0u8; 4];
    for c in hand {
        rank_counts[card_rank_value(*c) as usize] =
            rank_counts[card_rank_value(*c) as usize].saturating_add(1);
        suit_counts[card_suit(*c) as usize] = suit_counts[card_suit(*c) as usize].saturating_add(1);
    }

    let mut freq = rank_counts
        .iter()
        .copied()
        .filter(|v| *v > 0)
        .collect::<Vec<_>>();
    freq.sort_unstable_by(|a, b| b.cmp(a));
    let freq0 = *freq.first().unwrap_or(&0);
    let freq1 = *freq.get(1).unwrap_or(&0);
    let suit_peak = suit_counts.iter().copied().max().unwrap_or(0);

    let mut uniq = ranks.clone();
    uniq.sort_unstable();
    uniq.dedup();
    let mut conn = 0f64;
    for i in 1..uniq.len() {
        let d = uniq[i] - uniq[i - 1];
        if d == 1 {
            conn += 7.0;
        } else if d == 2 {
            conn += 3.0;
        }
    }

    let variant = variant_from_hand_size(hand.len());
    let mut score =
        ranks.iter().map(|r| *r as f64).sum::<f64>() * if variant == "holdem" { 2.7 } else { 1.8 };

    if freq0 >= 2 {
        score += 26.0 * freq0 as f64;
    }
    if freq1 >= 2 {
        score += 8.0;
    }
    score += conn;

    if variant == "holdem" {
        if suit_peak == 2 {
            score += 7.0;
        }
    } else {
        if suit_peak >= 2 {
            score += 6.0;
        }
        if suit_peak >= 3 {
            score -= 2.0;
        }
        if suit_peak >= 4 {
            score -= 5.0;
        }
    }
    if ranks.contains(&14) {
        score += 5.0;
    }
    score
}

fn normalize_percentile_profile(variant: &str, raw_profile: &str) -> String {
    let v = variant.to_lowercase();
    let wanted = raw_profile.trim().to_lowercase();
    match v.as_str() {
        "plo4" | "plo5" => {
            if wanted == "ppt6max" {
                "ppt6max".to_string()
            } else {
                "ours".to_string()
            }
        }
        _ => "ours".to_string(),
    }
}

fn exact_percentile_table(variant: &str, profile: &str) -> Option<Arc<PercentileTable>> {
    let profile_norm = normalize_percentile_profile(variant, profile);
    let cache = EXACT_PERCENTILE_TABLES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().ok()?;
    if !guard.contains_key(&profile_norm) {
        let loaded = load_percentile_tables_for_profile(&profile_norm).ok()?;
        guard.insert(profile_norm.clone(), loaded);
    }
    let profile_tables = guard.get(&profile_norm)?;
    profile_tables.get(&variant.to_lowercase()).cloned()
}

fn load_percentile_tables_for_profile(
    profile: &str,
) -> Result<HashMap<String, Arc<PercentileTable>>, String> {
    let (path, export_name) = if profile == "ppt6max" {
        (
            "src/percentile-tables-ppt6max.js",
            "PPT_6MAX_PERCENTILE_TABLES",
        )
    } else {
        ("src/percentile-tables.js", "PRECOMPUTED_PERCENTILE_TABLES")
    };
    let text = fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    let object_text = extract_exported_object_literal(&text, export_name)
        .ok_or_else(|| format!("failed to parse {export_name} in {path}"))?;
    let parsed: HashMap<String, PercentileTable> =
        json5::from_str(&object_text).map_err(|e| format!("parse {path}: {e}"))?;
    let mut out = HashMap::<String, Arc<PercentileTable>>::new();
    for (variant, table) in parsed {
        out.insert(variant.to_lowercase(), Arc::new(table));
    }
    Ok(out)
}

fn extract_exported_object_literal(text: &str, export_name: &str) -> Option<String> {
    let marker = format!("export const {export_name}");
    let start_marker = text.find(&marker)?;
    let after = &text[start_marker..];
    let eq_pos = after.find('=')?;
    let tail = &after[eq_pos + 1..];
    let open_rel = tail.find('{')?;
    let start = start_marker + eq_pos + 1 + open_rel;
    let chars: Vec<char> = text.chars().collect();

    let mut depth = 0i32;
    let mut in_string = false;
    let mut quote = '\0';
    let mut escaped = false;
    let mut end = None;

    for (i, ch) in chars.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if *ch == '\\' {
                escaped = true;
                continue;
            }
            if *ch == quote {
                in_string = false;
            }
            continue;
        }

        if *ch == '"' || *ch == '\'' {
            in_string = true;
            quote = *ch;
            continue;
        }
        if *ch == '{' {
            depth += 1;
        } else if *ch == '}' {
            depth -= 1;
            if depth == 0 {
                end = Some(i);
                break;
            }
        }
    }
    let end = end?;
    Some(chars[start..=end].iter().collect())
}

fn percent_boundary_for(table: &PercentileTable, pct: f64) -> PercentBoundary {
    if table.sample_size == 0 {
        return PercentBoundary::None;
    }
    let clamped = pct.clamp(0.0, 100.0);
    let steps = 100usize.saturating_mul(table.basis.max(1));
    let idx = ((clamped * table.basis.max(1) as f64).round() as usize).min(steps);
    let count = ((idx as f64 / steps as f64) * table.sample_size as f64).floor() as usize;
    if count == 0 {
        return PercentBoundary::None;
    }
    if count >= table.sample_size {
        return PercentBoundary::All;
    }

    if table.top_score_keys.len() <= idx || table.top_ranks.len() <= idx {
        return PercentBoundary::None;
    }
    PercentBoundary::Partial {
        boundary_score: table.top_score_keys[idx],
        boundary_rank: table.top_ranks[idx] as usize,
    }
}

fn in_top_exact_boundary(table: &PercentileTable, boundary: PercentBoundary, hand: &[u8]) -> bool {
    if hand.is_empty() {
        return false;
    }
    match boundary {
        PercentBoundary::None => return false,
        PercentBoundary::All => return true,
        PercentBoundary::Partial { .. } => {}
    }
    let hand_rank = combo_rank_52(hand);
    if hand_rank >= table.sample_size || hand_rank >= table.score_keys_by_combo_rank.len() {
        return false;
    }
    let score_key = table.score_keys_by_combo_rank[hand_rank];
    match boundary {
        PercentBoundary::Partial {
            boundary_score,
            boundary_rank,
        } => {
            score_key > boundary_score
                || (score_key == boundary_score && hand_rank <= boundary_rank)
        }
        PercentBoundary::None => false,
        PercentBoundary::All => true,
    }
}

fn combo_rank_52(hand_cards: &[u8]) -> usize {
    let choose = CHOOSE_52_TABLE.get_or_init(build_choose_52_table);
    let k = hand_cards.len();
    let mut rank = 0usize;
    let mut start = 0usize;
    for i in 0..k {
        let ci = hand_cards[i] as usize;
        for v in start..ci {
            rank += choose[52 - (v + 1)][k - i - 1];
        }
        start = ci + 1;
    }
    rank
}

fn build_choose_52_table() -> [[usize; 7]; 53] {
    let mut table = [[0usize; 7]; 53];
    for n in 0..=52 {
        table[n][0] = 1;
        for k in 1..=6 {
            if k > n {
                table[n][k] = 0;
            } else if k == n {
                table[n][k] = 1;
            } else {
                table[n][k] = table[n - 1][k - 1] + table[n - 1][k];
            }
        }
    }
    table
}

fn compile_range_expr(
    text: &str,
    variant: &str,
    hand_size: usize,
    percentile_profile: Option<&str>,
) -> Result<CompiledRangeExpr, String> {
    let t = text.trim();
    let raw = if t.is_empty() { "*" } else { t };
    let expanded = expand_expr_macros(&strip_spaces(raw));
    let source = if expanded.is_empty() {
        "*".to_string()
    } else {
        expanded
    };
    let toks = tokenize_expr(&source)?;
    let mut p = ExprParser {
        tokens: toks,
        pos: 0,
        variant: variant.to_string(),
        percentile_profile: percentile_profile.unwrap_or_default().to_lowercase(),
        hand_size,
    };
    let expr = p.parse_union()?;
    if p.pos != p.tokens.len() {
        return Err("unexpected trailing tokens in range".to_string());
    }
    Ok(expr)
}

fn strip_spaces(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

fn expand_expr_macros(expr: &str) -> String {
    let mut out = expr.to_string();
    for (from, to) in MACRO_REPLACEMENTS {
        out = out.replace(from, to);
    }
    out
}

fn tokenize_expr(text: &str) -> Result<Vec<LexToken>, String> {
    let s = text.trim();
    if s.is_empty() {
        return Ok(vec![LexToken::Atom("*".to_string())]);
    }

    let mut out = Vec::new();
    let mut buf = String::new();
    let mut bracket_depth = 0i32;
    for ch in s.chars() {
        if ch == '[' {
            bracket_depth += 1;
            buf.push(ch);
            continue;
        }
        if ch == ']' {
            bracket_depth -= 1;
            if bracket_depth < 0 {
                return Err("unexpected ']' in range expression".to_string());
            }
            buf.push(ch);
            continue;
        }

        if bracket_depth == 0 && matches!(ch, ',' | ':' | '!' | '(' | ')' | '&') {
            if !buf.is_empty() {
                out.push(LexToken::Atom(buf.clone()));
                buf.clear();
            }
            out.push(match ch {
                ',' => LexToken::Comma,
                ':' | '&' => LexToken::Colon,
                '!' => LexToken::Bang,
                '(' => LexToken::LParen,
                ')' => LexToken::RParen,
                _ => unreachable!(),
            });
            continue;
        }

        buf.push(ch);
    }
    if bracket_depth != 0 {
        return Err("missing ']' in range expression".to_string());
    }
    if !buf.is_empty() {
        out.push(LexToken::Atom(buf));
    }
    if out.is_empty() {
        return Err("empty range expression".to_string());
    }
    Ok(out)
}

struct ExprParser {
    tokens: Vec<LexToken>,
    pos: usize,
    variant: String,
    percentile_profile: String,
    hand_size: usize,
}

impl ExprParser {
    fn parse_union(&mut self) -> Result<CompiledRangeExpr, String> {
        let mut left = self.parse_constraint()?;
        while self.match_tok(|t| matches!(t, LexToken::Comma)) {
            let right = self.parse_constraint()?;
            left = CompiledRangeExpr {
                expr: RangeExpr::Or(Box::new(left.expr), Box::new(right.expr)),
                // Keep ',' as pure union weight (matching frontend parser behavior).
                weight_pct: 100,
            };
        }
        Ok(left)
    }

    // Keep ':' and '!' at the same precedence (matching frontend parser behavior).
    fn parse_constraint(&mut self) -> Result<CompiledRangeExpr, String> {
        let mut left = self.parse_primary()?;
        while self.match_tok(|t| matches!(t, LexToken::Colon) || matches!(t, LexToken::Bang)) {
            let op = self.tokens[self.pos - 1].clone();
            let right = self.parse_primary()?;
            let weight_pct = left.weight_pct.min(right.weight_pct);
            left = CompiledRangeExpr {
                expr: match op {
                    LexToken::Colon => RangeExpr::And(Box::new(left.expr), Box::new(right.expr)),
                    LexToken::Bang => RangeExpr::Not(Box::new(left.expr), Box::new(right.expr)),
                    _ => unreachable!(),
                },
                weight_pct,
            };
        }
        Ok(left)
    }

    fn parse_primary(&mut self) -> Result<CompiledRangeExpr, String> {
        if self.match_tok(|t| matches!(t, LexToken::LParen)) {
            let expr = self.parse_union()?;
            if !self.match_tok(|t| matches!(t, LexToken::RParen)) {
                return Err("missing ')' in range expression".to_string());
            }
            return Ok(expr);
        }

        let atom = match self.peek() {
            Some(LexToken::Atom(s)) => s.clone(),
            Some(_) => return Err("expected range atom".to_string()),
            None => return Err("unexpected end of range expression".to_string()),
        };
        self.pos += 1;
        let (compiled_atom, weight_pct) = compile_atom(
            &atom,
            &self.variant,
            self.hand_size,
            &self.percentile_profile,
        )?;
        Ok(CompiledRangeExpr {
            expr: RangeExpr::Atom(compiled_atom),
            weight_pct,
        })
    }

    fn match_tok<F>(&mut self, f: F) -> bool
    where
        F: FnOnce(&LexToken) -> bool,
    {
        if let Some(tok) = self.tokens.get(self.pos) {
            if f(tok) {
                self.pos += 1;
                return true;
            }
        }
        false
    }

    fn peek(&self) -> Option<&LexToken> {
        self.tokens.get(self.pos)
    }
}

fn strip_weight_suffix(atom: &str) -> (String, Option<u8>) {
    let t = atom.trim();
    if let Some(idx) = t.rfind('@') {
        if idx + 1 < t.len() {
            let suffix = &t[idx + 1..];
            if !suffix.is_empty() && suffix.len() <= 3 && suffix.chars().all(|c| c.is_ascii_digit())
            {
                let w = suffix.parse::<u8>().unwrap_or(100).min(100);
                return (t[..idx].to_string(), Some(w));
            }
        }
    }
    (t.to_string(), None)
}

fn parse_percent_top(atom: &str) -> Option<f64> {
    if !atom.ends_with('%') {
        return None;
    }
    let body = &atom[..atom.len() - 1];
    if body.contains("%-") || body.contains('-') {
        return None;
    }
    parse_percent_number(body)
}

fn parse_percent_range(atom: &str) -> Option<(f64, f64)> {
    let marker = "%-";
    let mid = atom.find(marker)?;
    if !atom.ends_with('%') {
        return None;
    }
    let low_raw = &atom[..mid];
    let high_raw = &atom[mid + marker.len()..atom.len() - 1];
    let low = parse_percent_number(low_raw)?;
    let high = parse_percent_number(high_raw)?;
    if low > high {
        return None;
    }
    Some((low, high))
}

fn parse_percent_number(raw: &str) -> Option<f64> {
    if raw.is_empty() || raw.starts_with('.') || raw.ends_with('.') {
        return None;
    }
    let mut dots = 0usize;
    for ch in raw.chars() {
        if ch == '.' {
            dots += 1;
            if dots > 1 {
                return None;
            }
            continue;
        }
        if !ch.is_ascii_digit() {
            return None;
        }
    }
    let p = raw.parse::<f64>().ok()?;
    if !(0.0..=100.0).contains(&p) {
        return None;
    }
    Some(p)
}

fn compile_atom(
    atom: &str,
    variant: &str,
    hand_size: usize,
    percentile_profile: &str,
) -> Result<(RangeAtom, u8), String> {
    let t = atom.trim();
    let (raw_atom, weight_opt) = strip_weight_suffix(t);
    let atom_text = raw_atom.trim();
    if atom_text.is_empty() {
        return Err("empty range atom".to_string());
    }
    let weight = weight_opt.unwrap_or(100).min(100);
    if weight == 0 {
        return Ok((RangeAtom::Never, 0));
    }
    if atom_text == "*" {
        return Ok((RangeAtom::Any, weight));
    }

    if let Some(tag) = normalize_tag_token(atom_text) {
        return Ok((RangeAtom::Tag(tag), weight));
    }

    if let Some((low, high)) = parse_percent_range(atom_text) {
        let profile = normalize_percentile_profile(variant, percentile_profile);
        if let Some(table) = exact_percentile_table(variant, &profile) {
            return Ok((
                RangeAtom::PercentRangeExact {
                    low_boundary: percent_boundary_for(&table, low),
                    high_boundary: percent_boundary_for(&table, high),
                    table,
                    low_pct: low,
                    high_pct: high,
                },
                weight,
            ));
        }
        let low_threshold = percentile_threshold(variant, low);
        let high_threshold = percentile_threshold(variant, high);
        return Ok((
            RangeAtom::PercentRangeHeuristic {
                low_threshold,
                high_threshold,
            },
            weight,
        ));
    }
    if let Some(p) = parse_percent_top(atom_text) {
        let profile = normalize_percentile_profile(variant, percentile_profile);
        if let Some(table) = exact_percentile_table(variant, &profile) {
            return Ok((
                RangeAtom::PercentTopExact {
                    boundary: percent_boundary_for(&table, p),
                    table,
                    pct: p,
                },
                weight,
            ));
        }
        let threshold = percentile_threshold(variant, p);
        return Ok((RangeAtom::PercentTopHeuristic { threshold }, weight));
    }

    if let Some(exact) = parse_exact_literal(atom_text, hand_size) {
        return Ok((RangeAtom::Exact(exact), weight));
    }

    if let Some(entries) = parse_spec_atom(atom_text, variant, hand_size) {
        return Ok((RangeAtom::Specs(entries), weight));
    }

    if let Some(rank_req) = parse_rank_pattern(atom_text, hand_size) {
        if rank_req.iter().all(|v| *v == 0) {
            return Ok((RangeAtom::Any, weight));
        }
        return Ok((RangeAtom::RankPattern(rank_req), weight));
    }

    if let Some(specs) = parse_fixed_pattern(atom_text, hand_size) {
        return Ok((RangeAtom::FixedPattern(specs), weight));
    }

    Err(format!(
        "unsupported atom '{atom_text}' (supported: '*', tags (@tp/@2p/@set/@fd/@f/@s etc.), percent filters (30%,20%-40%), PPT-like specs/macros, exact cards)"
    ))
}

fn parse_spec_atom(atom: &str, variant: &str, hand_size: usize) -> Option<Vec<Vec<Spec>>> {
    let expanded_shortcuts = expand_shortcuts(atom, variant);
    let leaves = expand_span(&expanded_shortcuts);
    let mut entries = Vec::<Vec<Spec>>::new();

    for leaf in leaves {
        let specs = parse_leaf_specs(&leaf).ok()?;
        if specs.is_empty() || specs.len() > hand_size {
            return None;
        }
        entries.push(specs);
    }
    if entries.is_empty() {
        return None;
    }
    Some(entries)
}

fn expand_shortcuts(atom: &str, variant: &str) -> String {
    if variant != "holdem" {
        return atom.to_string();
    }
    let chars: Vec<char> = atom.chars().collect();
    let mut out = String::with_capacity(atom.len() + 8);
    let mut i = 0usize;
    while i < chars.len() {
        if i + 2 < chars.len()
            && rank_char_to_idx(chars[i].to_ascii_uppercase()).is_some()
            && rank_char_to_idx(chars[i + 1].to_ascii_uppercase()).is_some()
            && matches!(chars[i + 2].to_ascii_lowercase(), 's' | 'o')
            && (i + 3 == chars.len() || !chars[i + 3].is_ascii_alphanumeric())
        {
            let r1 = chars[i].to_ascii_uppercase();
            let r2 = chars[i + 1].to_ascii_uppercase();
            let mapped = if chars[i + 2].to_ascii_lowercase() == 's' {
                "x"
            } else {
                "y"
            };
            out.push(r1);
            out.push('x');
            out.push(r2);
            out.push_str(mapped);
            i += 3;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn expand_span(atom: &str) -> Vec<String> {
    let s = atom.to_ascii_uppercase();

    if s.len() >= 3 {
        let chars: Vec<char> = s.chars().collect();
        let last = chars[chars.len() - 1];
        if (last == '+' || last == '-')
            && chars[..chars.len() - 1]
                .iter()
                .all(|c| rank_char_to_idx(*c).is_some())
        {
            let body: Vec<char> = chars[..chars.len() - 1].to_vec();
            if body.len() >= 2 {
                let dir: i32 = if last == '+' { 1 } else { -1 };
                let a = rank_char_to_idx(body[0]).unwrap() as i32;
                let b = rank_char_to_idx(body[1]).unwrap() as i32;
                let mut out = Vec::<String>::new();
                let mut i = a;
                let mut j = b;
                while (0..13).contains(&i) && (0..13).contains(&j) {
                    let mut hand = String::new();
                    hand.push(RANKS.chars().nth(i as usize).unwrap_or('2'));
                    hand.push(RANKS.chars().nth(j as usize).unwrap_or('2'));
                    for c in body.iter().skip(2) {
                        hand.push(*c);
                    }
                    out.push(hand);
                    i += dir;
                    j += dir;
                }
                if !out.is_empty() {
                    return out;
                }
            }
        }
    }

    if let Some((left, right)) = split_rank_span_bounds(&s) {
        if left.len() == right.len()
            && (2..=6).contains(&left.len())
            && left.chars().all(|c| rank_char_to_idx(c).is_some())
            && right.chars().all(|c| rank_char_to_idx(c).is_some())
        {
            let mut pairs = Vec::<(i32, i32)>::new();
            for (lc, rc) in left.chars().zip(right.chars()) {
                pairs.push((
                    rank_char_to_idx(lc).unwrap() as i32,
                    rank_char_to_idx(rc).unwrap() as i32,
                ));
            }
            let steps = pairs
                .iter()
                .map(|(a, b)| (a - b).abs() as usize)
                .max()
                .unwrap_or(0)
                + 1;
            let mut out = Vec::<String>::new();
            for step in 0..steps {
                let mut hand = String::new();
                let mut ok = true;
                for (a, b) in &pairs {
                    let dir = (b - a).signum();
                    let v = a + (step as i32) * dir;
                    if !(0..13).contains(&v) {
                        ok = false;
                        break;
                    }
                    hand.push(RANKS.chars().nth(v as usize).unwrap_or('2'));
                }
                if ok {
                    out.push(hand);
                }
            }
            if !out.is_empty() {
                return out;
            }
        }
    }

    vec![atom.to_string()]
}

fn split_rank_span_bounds(s: &str) -> Option<(&str, &str)> {
    let mut dash_pos = None;
    for (idx, ch) in s.char_indices() {
        if ch == '-' {
            if dash_pos.is_some() {
                return None;
            }
            dash_pos = Some(idx);
        }
    }
    let pos = dash_pos?;
    if pos == 0 || pos + 1 >= s.len() {
        return None;
    }
    Some((&s[..pos], &s[pos + 1..]))
}

fn parse_leaf_specs(leaf: &str) -> Result<Vec<Spec>, String> {
    let chars: Vec<char> = leaf.chars().collect();
    let mut specs = Vec::<Spec>::new();
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        if ch == '{' {
            let end = find_matching_char(&chars, i, '{', '}')
                .ok_or_else(|| "missing '}' in grouped atom".to_string())?;
            let inner: String = chars[i + 1..end].iter().collect();
            let nested = parse_leaf_specs(&inner)?;
            specs.extend(nested);
            i = end + 1;
            continue;
        }

        if ch == '*' {
            let (suit_mode, suit_value, advance) = parse_optional_suit(&chars, i + 1);
            specs.push(Spec {
                ranks_mask: ALL_RANKS_MASK,
                rank_var: -1,
                suit_mode,
                suit_value,
            });
            i += 1 + advance;
            continue;
        }

        if ch == '[' {
            let end = find_next_char(&chars, i + 1, ']')
                .ok_or_else(|| "missing ']' in rank list".to_string())?;
            let token: String = chars[i..=end].iter().collect();
            let ranks_mask =
                rank_mask_from_expr(&token).ok_or_else(|| format!("invalid rank list: {token}"))?;
            let (suit_mode, suit_value, advance) = parse_optional_suit(&chars, end + 1);
            specs.push(Spec {
                ranks_mask,
                rank_var: -1,
                suit_mode,
                suit_value,
            });
            i = end + 1 + advance;
            continue;
        }

        let up = ch.to_ascii_uppercase();
        if rank_char_to_idx(up).is_some() || matches!(up, 'R' | 'O' | 'N') {
            let mut ranks_mask = if let Some(idx) = rank_char_to_idx(up) {
                1u16 << idx
            } else {
                ALL_RANKS_MASK
            };
            let rank_var = match up {
                'R' => 0,
                'O' => 1,
                'N' => 2,
                _ => -1,
            };
            let mut consumed = 1usize;

            if rank_var < 0 && i + 1 < chars.len() && matches!(chars[i + 1], '+' | '-') {
                let idx = rank_char_to_idx(up).unwrap() as usize;
                ranks_mask = if chars[i + 1] == '+' {
                    ((1u32 << 13) - (1u32 << idx)) as u16
                } else {
                    ((1u32 << (idx + 1)) - 1) as u16
                };
                consumed += 1;
            }

            let (suit_mode, suit_value, advance) = parse_optional_suit(&chars, i + consumed);
            consumed += advance;
            specs.push(Spec {
                ranks_mask,
                rank_var,
                suit_mode,
                suit_value,
            });
            i += consumed;
            continue;
        }

        if let Some((suit_mode, suit_value)) = suit_token_info(ch) {
            specs.push(Spec {
                ranks_mask: ALL_RANKS_MASK,
                rank_var: -1,
                suit_mode,
                suit_value,
            });
            i += 1;
            continue;
        }

        return Err(format!("unexpected token '{ch}' in atom '{leaf}'"));
    }

    Ok(specs)
}

fn parse_optional_suit(chars: &[char], idx: usize) -> (u8, i8, usize) {
    if idx >= chars.len() {
        return (0, -1, 0);
    }
    if let Some((mode, value)) = suit_token_info(chars[idx]) {
        return (mode, value, 1);
    }
    (0, -1, 0)
}

fn suit_token_info(ch: char) -> Option<(u8, i8)> {
    match ch.to_ascii_lowercase() {
        'c' => Some((1, 0)),
        'd' => Some((1, 1)),
        'h' => Some((1, 2)),
        's' => Some((1, 3)),
        'x' => Some((2, 0)),
        'y' => Some((2, 1)),
        'z' => Some((2, 2)),
        'w' => Some((2, 3)),
        _ => None,
    }
}

fn rank_mask_from_expr(expr: &str) -> Option<u16> {
    let e = expr.trim().to_ascii_uppercase();
    if e.len() == 1 {
        let ch = e.chars().next()?;
        if let Some(idx) = rank_char_to_idx(ch) {
            return Some(1u16 << idx);
        }
        if matches!(ch, 'R' | 'O' | 'N') {
            return Some(ALL_RANKS_MASK);
        }
    }

    if let Some((left, right)) = split_rank_span_bounds(&e) {
        if left.len() == 1 && right.len() == 1 {
            let l = rank_char_to_idx(left.chars().next()?)? as usize;
            let r = rank_char_to_idx(right.chars().next()?)? as usize;
            let lo = l.min(r);
            let hi = l.max(r);
            let mut mask = 0u16;
            for i in lo..=hi {
                mask |= 1u16 << i;
            }
            return Some(mask);
        }
    }

    if e.starts_with('[') && e.ends_with(']') {
        let inside = &e[1..e.len() - 1];
        let mut mask = 0u16;
        for part in inside
            .split(',')
            .map(|x| x.trim())
            .filter(|x| !x.is_empty())
        {
            if let Some(m) = rank_mask_from_expr(part) {
                mask |= m;
                continue;
            }
            return None;
        }
        if mask != 0 {
            return Some(mask);
        }
    }

    None
}

fn find_next_char(chars: &[char], start: usize, want: char) -> Option<usize> {
    for (idx, ch) in chars.iter().enumerate().skip(start) {
        if *ch == want {
            return Some(idx);
        }
    }
    None
}

fn find_matching_char(chars: &[char], start: usize, open: char, close: char) -> Option<usize> {
    if chars.get(start).copied()? != open {
        return None;
    }
    let mut depth = 0i32;
    for (idx, ch) in chars.iter().enumerate().skip(start) {
        if *ch == open {
            depth += 1;
        } else if *ch == close {
            depth -= 1;
            if depth == 0 {
                return Some(idx);
            }
        }
    }
    None
}

fn parse_exact_literal(text: &str, hand_size: usize) -> Option<Vec<u8>> {
    if text.len() != hand_size * 2 {
        return None;
    }
    let parsed = parse_cards_text(text).ok()?;
    if parsed.len() != hand_size {
        return None;
    }
    let mut out = parsed;
    out.sort_unstable();
    Some(out)
}

fn parse_rank_pattern(text: &str, hand_size: usize) -> Option<[u8; 13]> {
    let t = text.trim().to_uppercase();
    if t.chars().count() != hand_size {
        return None;
    }
    let mut req = [0u8; 13];
    for ch in t.chars() {
        if ch == '*' {
            continue;
        }
        let idx = rank_char_to_idx(ch)? as usize;
        req[idx] = req[idx].saturating_add(1);
    }
    Some(req)
}

fn parse_fixed_pattern(text: &str, hand_size: usize) -> Option<Vec<RankSuitSpec>> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let chars: Vec<char> = t.chars().collect();
    let mut specs = Vec::new();
    let mut i = 0usize;

    while i < chars.len() {
        let r = chars[i].to_ascii_uppercase();
        let rank = rank_char_to_idx(r)?;
        i += 1;

        let suit = if i < chars.len() {
            let s = chars[i].to_ascii_lowercase();
            if let Some(suit_idx) = suit_char_to_idx(s) {
                i += 1;
                Some(suit_idx)
            } else {
                None
            }
        } else {
            None
        };

        specs.push(RankSuitSpec { rank, suit });
    }

    if specs.len() != hand_size {
        return None;
    }
    Some(specs)
}

fn normalize_tag_token(raw: &str) -> Option<TagAtom> {
    let mut t = raw.trim().to_lowercase();
    if t.is_empty() {
        return None;
    }
    t = t.replace(' ', "");

    if t == "@straight" {
        t = "@s".to_string();
    } else if t == "@flush" {
        t = "@f".to_string();
    } else if t == "@tpplus" {
        t = "@tp+".to_string();
    }

    let plus = t.ends_with('+');
    let base = if plus { &t[..t.len() - 1] } else { t.as_str() };

    match base {
        "@tp" => Some(TagAtom::TopPair { plus }),
        "@overpair" => Some(TagAtom::Overpair { plus }),
        "@2p" => Some(TagAtom::TwoPair { plus }),
        "@set" => Some(TagAtom::Set { plus }),
        "@fd" if !plus => Some(TagAtom::FlushDraw),
        "@f" => Some(TagAtom::Flush { plus }),
        "@s" => Some(TagAtom::Straight { plus }),
        "@sd" if !plus => Some(TagAtom::StraightDraw { min_outs: 1 }),
        "@sd4" if !plus => Some(TagAtom::StraightDraw { min_outs: 4 }),
        "@sd8" if !plus => Some(TagAtom::StraightDraw { min_outs: 8 }),
        "@sd12" if !plus => Some(TagAtom::StraightDraw { min_outs: 12 }),
        _ => None,
    }
}

fn is_any_expr(expr: &RangeExpr) -> bool {
    matches!(expr, RangeExpr::Atom(RangeAtom::Any))
}

fn range_expr_match(expr: &RangeExpr, hand: &[u8], board: &[u8]) -> bool {
    match expr {
        RangeExpr::Or(left, right) => {
            range_expr_match(left, hand, board) || range_expr_match(right, hand, board)
        }
        RangeExpr::And(left, right) => {
            range_expr_match(left, hand, board) && range_expr_match(right, hand, board)
        }
        RangeExpr::Not(left, right) => {
            range_expr_match(left, hand, board) && !range_expr_match(right, hand, board)
        }
        RangeExpr::Atom(atom) => atom_match(atom, hand, board),
    }
}

fn atom_match(atom: &RangeAtom, hand: &[u8], board: &[u8]) -> bool {
    match atom {
        RangeAtom::Any => true,
        RangeAtom::Never => false,
        RangeAtom::Exact(expected) => hand == expected,
        RangeAtom::Specs(entries) => entries.iter().any(|specs| match_specs(specs, hand)),
        RangeAtom::PercentTopExact {
            table, boundary, ..
        } => in_top_exact_boundary(table, *boundary, hand),
        RangeAtom::PercentRangeExact {
            table,
            low_boundary,
            high_boundary,
            ..
        } => {
            in_top_exact_boundary(table, *high_boundary, hand)
                && !in_top_exact_boundary(table, *low_boundary, hand)
        }
        RangeAtom::PercentTopHeuristic { threshold } => evaluate_heuristic(hand) >= *threshold,
        RangeAtom::PercentRangeHeuristic {
            low_threshold,
            high_threshold,
        } => {
            let s = evaluate_heuristic(hand);
            s <= *low_threshold && s >= *high_threshold
        }
        RangeAtom::RankPattern(req) => rank_pattern_match(req, hand),
        RangeAtom::FixedPattern(specs) => fixed_pattern_match(specs, hand),
        RangeAtom::Tag(tag) => full_tag_match(*tag, hand, board),
    }
}

fn match_specs(specs_input: &[Spec], hand: &[u8]) -> bool {
    if specs_input.len() > hand.len() {
        return false;
    }

    let wildcard = Spec {
        ranks_mask: ALL_RANKS_MASK,
        rank_var: -1,
        suit_mode: 0,
        suit_value: -1,
    };

    let mut specs = Vec::with_capacity(hand.len());
    specs.extend_from_slice(specs_input);
    while specs.len() < hand.len() {
        specs.push(wildcard);
    }

    let mut used = vec![false; hand.len()];
    let mut rank_bindings = [-1i8; 3];
    let mut suit_bindings = [-1i8; 4];
    let mut fixed_ranks = [false; 13];

    for spec in &specs {
        if spec.rank_var < 0 && spec.ranks_mask.count_ones() == 1 {
            let idx = spec.ranks_mask.trailing_zeros() as usize;
            if idx < fixed_ranks.len() {
                fixed_ranks[idx] = true;
            }
        }
    }

    match_specs_rec(
        0,
        &specs,
        hand,
        &mut used,
        &mut rank_bindings,
        &mut suit_bindings,
        &fixed_ranks,
    )
}

fn match_specs_rec(
    i: usize,
    specs: &[Spec],
    hand: &[u8],
    used: &mut [bool],
    rank_bindings: &mut [i8; 3],
    suit_bindings: &mut [i8; 4],
    fixed_ranks: &[bool; 13],
) -> bool {
    if i >= specs.len() {
        return true;
    }

    let spec = specs[i];
    for j in 0..hand.len() {
        if used[j] {
            continue;
        }
        let c = hand[j];
        let rank_idx = card_rank(c) as usize;
        if rank_idx >= 13 || (spec.ranks_mask & (1u16 << rank_idx)) == 0 {
            continue;
        }

        let mut bound_rank_key: Option<usize> = None;
        if spec.rank_var >= 0 {
            let key = spec.rank_var as usize;
            let cur = rank_bindings[key];
            if cur >= 0 {
                if cur != rank_idx as i8 {
                    continue;
                }
            } else {
                if fixed_ranks[rank_idx] {
                    continue;
                }
                rank_bindings[key] = rank_idx as i8;
                bound_rank_key = Some(key);
            }
        }

        let suit = card_suit(c) as i8;
        let mut bound_suit_key: Option<usize> = None;
        let suit_ok = match spec.suit_mode {
            0 => true,
            1 => suit == spec.suit_value,
            2 => {
                let key = spec.suit_value as usize;
                let cur = suit_bindings[key];
                if cur >= 0 {
                    cur == suit
                } else if suit_bindings.iter().any(|v| *v == suit) {
                    false
                } else {
                    suit_bindings[key] = suit;
                    bound_suit_key = Some(key);
                    true
                }
            }
            _ => false,
        };
        if !suit_ok {
            if let Some(k) = bound_rank_key {
                rank_bindings[k] = -1;
            }
            if let Some(k) = bound_suit_key {
                suit_bindings[k] = -1;
            }
            continue;
        }

        used[j] = true;
        if match_specs_rec(
            i + 1,
            specs,
            hand,
            used,
            rank_bindings,
            suit_bindings,
            fixed_ranks,
        ) {
            return true;
        }
        used[j] = false;

        if let Some(k) = bound_rank_key {
            rank_bindings[k] = -1;
        }
        if let Some(k) = bound_suit_key {
            suit_bindings[k] = -1;
        }
    }
    false
}

fn rank_pattern_match(req: &[u8; 13], hand: &[u8]) -> bool {
    let mut counts = [0u8; 13];
    for c in hand {
        counts[card_rank(*c) as usize] = counts[card_rank(*c) as usize].saturating_add(1);
    }
    for i in 0..13 {
        if counts[i] < req[i] {
            return false;
        }
    }
    true
}

fn fixed_pattern_match(specs: &[RankSuitSpec], hand: &[u8]) -> bool {
    let mut used = vec![false; hand.len()];

    fn rec(i: usize, specs: &[RankSuitSpec], hand: &[u8], used: &mut [bool]) -> bool {
        if i == specs.len() {
            return true;
        }
        let spec = specs[i];
        for h in 0..hand.len() {
            if used[h] {
                continue;
            }
            let c = hand[h];
            if card_rank(c) != spec.rank {
                continue;
            }
            if let Some(s) = spec.suit {
                if card_suit(c) != s {
                    continue;
                }
            }
            used[h] = true;
            if rec(i + 1, specs, hand, used) {
                return true;
            }
            used[h] = false;
        }
        false
    }

    rec(0, specs, hand, &mut used)
}

fn full_tag_match(tag: TagAtom, hand: &[u8], board: &[u8]) -> bool {
    if board.len() < 3 {
        return false;
    }
    let is_holdem = hand.len() == 2;

    if let TagAtom::StraightDraw { min_outs } = tag {
        if board.len() >= 5 {
            return false;
        }
        let has_straight_now = if is_holdem {
            if hand.len() != 2 {
                return false;
            }
            has_holdem_straight_by_ranks(&[hand[0], hand[1]], board)
        } else {
            has_omaha_straight(hand, board)
        };
        if has_straight_now {
            return false;
        }
        return straight_outs_for_hand(hand, board, is_holdem) >= min_outs;
    }

    if is_holdem {
        if hand.len() != 2 {
            return false;
        }
        let core = [hand[0], hand[1]];
        return core_tag_match(tag, core, board, true);
    }

    for i in 0..hand.len().saturating_sub(1) {
        for j in (i + 1)..hand.len() {
            if core_tag_match(tag, [hand[i], hand[j]], board, false) {
                return true;
            }
        }
    }
    false
}

fn core_tag_match(tag: TagAtom, core: [u8; 2], board: &[u8], is_holdem: bool) -> bool {
    if board.len() < 3 {
        return false;
    }
    if matches!(tag, TagAtom::Overpair { .. }) && !is_holdem {
        return false;
    }

    let (made_flush, flush_draw) = core_flush_flags(core, board, is_holdem);
    match tag {
        TagAtom::TopPair { plus } => {
            let eval = evaluate_core_ready_state(core, board, is_holdem);
            if plus {
                return eval.class_id >= 2
                    || (eval.class_id == 1 && eval.pair_rank >= eval.top_board);
            }
            return eval.class_id == 1 && eval.pair_rank == eval.top_board;
        }
        TagAtom::Overpair { plus } => {
            let eval = evaluate_core_ready_state(core, board, is_holdem);
            if plus {
                return eval.is_overpair || eval.class_id >= 2;
            }
            return eval.is_overpair;
        }
        TagAtom::TwoPair { plus } => {
            let eval = evaluate_core_ready_state(core, board, is_holdem);
            return if plus {
                eval.class_id >= 2
            } else {
                eval.class_id == 2
            };
        }
        TagAtom::Set { plus } => {
            let eval = evaluate_core_ready_state(core, board, is_holdem);
            return if plus {
                eval.class_id >= 3
            } else {
                eval.class_id == 3
            };
        }
        TagAtom::FlushDraw => return flush_draw,
        TagAtom::Flush { plus } => {
            if !plus {
                return made_flush;
            }
            let eval = evaluate_core_ready_state(core, board, is_holdem);
            return eval.class_id >= 5;
        }
        TagAtom::Straight { plus } => {
            if plus {
                let eval = evaluate_core_ready_state(core, board, is_holdem);
                return eval.class_id >= 4;
            }
            if is_holdem {
                return has_holdem_straight_by_ranks(&core, board);
            }
            return has_omaha_core_straight(core, board);
        }
        TagAtom::StraightDraw { min_outs } => {
            if board.len() >= 5 {
                return false;
            }
            let has_straight_now = if is_holdem {
                has_holdem_straight_by_ranks(&core, board)
            } else {
                has_omaha_core_straight(core, board)
            };
            if has_straight_now {
                return false;
            }
            let outs = core_straight_outs(core, board, is_holdem);
            return outs >= min_outs;
        }
    }
}

fn core_flush_flags(core: [u8; 2], board: &[u8], is_holdem: bool) -> (bool, bool) {
    let mut board_suit = [0u8; 4];
    for c in board {
        board_suit[card_suit(*c) as usize] = board_suit[card_suit(*c) as usize].saturating_add(1);
    }

    let mut core_suit = [0u8; 4];
    core_suit[card_suit(core[0]) as usize] += 1;
    core_suit[card_suit(core[1]) as usize] += 1;

    let mut made_flush = false;
    let mut flush_draw = false;
    for s in 0..4 {
        if is_holdem {
            let total = board_suit[s] + core_suit[s];
            if total >= 5 {
                made_flush = true;
            }
            if !made_flush && board.len() < 5 && total == 4 {
                flush_draw = true;
            }
        } else {
            if core_suit[s] >= 2 && board_suit[s] >= 3 {
                made_flush = true;
            }
            if !made_flush && board.len() < 5 && core_suit[s] >= 2 && board_suit[s] == 2 {
                flush_draw = true;
            }
        }
    }
    (made_flush, flush_draw)
}

#[derive(Clone, Copy)]
struct ReadyCoreEval {
    class_id: u8,
    pair_rank: u8,
    top_board: u8,
    is_overpair: bool,
}

fn evaluate_core_ready_state(core: [u8; 2], board: &[u8], is_holdem: bool) -> ReadyCoreEval {
    let top_board = board.iter().map(|c| card_rank_value(*c)).max().unwrap_or(2);

    let (class_id, pair_rank) = if is_holdem {
        best_holdem_core_class(core, board)
    } else {
        best_omaha_core_class(core, board)
    };

    let is_overpair = is_holdem
        && card_rank_value(core[0]) == card_rank_value(core[1])
        && card_rank_value(core[0]) > top_board;

    ReadyCoreEval {
        class_id,
        pair_rank,
        top_board,
        is_overpair,
    }
}

fn best_holdem_core_class(core: [u8; 2], board: &[u8]) -> (u8, u8) {
    let mut all = Vec::<u8>::with_capacity(2 + board.len());
    all.push(core[0]);
    all.push(core[1]);
    all.extend_from_slice(board);
    if all.len() < 5 {
        return (0, 0);
    }

    let mut best_class = 0u8;
    let mut best_pair = 0u8;
    let n = all.len();
    for a in 0..=n - 5 {
        for b in a + 1..=n - 4 {
            for c in b + 1..=n - 3 {
                for d in c + 1..=n - 2 {
                    for e in d + 1..=n - 1 {
                        let cards = [all[a], all[b], all[c], all[d], all[e]];
                        let (class_id, pair_rank) = eval_five_cards_class(cards);
                        if class_id > best_class
                            || (class_id == best_class && class_id == 1 && pair_rank > best_pair)
                        {
                            best_class = class_id;
                            best_pair = pair_rank;
                        }
                    }
                }
            }
        }
    }
    (best_class, best_pair)
}

fn best_omaha_core_class(core: [u8; 2], board: &[u8]) -> (u8, u8) {
    if board.len() < 3 {
        return (0, 0);
    }
    let mut best_class = 0u8;
    let mut best_pair = 0u8;
    for i in 0..board.len().saturating_sub(2) {
        for j in (i + 1)..board.len().saturating_sub(1) {
            for k in (j + 1)..board.len() {
                let cards = [core[0], core[1], board[i], board[j], board[k]];
                let (class_id, pair_rank) = eval_five_cards_class(cards);
                if class_id > best_class
                    || (class_id == best_class && class_id == 1 && pair_rank > best_pair)
                {
                    best_class = class_id;
                    best_pair = pair_rank;
                }
            }
        }
    }
    (best_class, best_pair)
}

fn eval_five_cards_class(cards: [u8; 5]) -> (u8, u8) {
    let mut rank_counts = [0u8; 15];
    let mut suit_counts = [0u8; 4];
    for c in cards {
        let r = card_rank_value(c) as usize;
        let s = card_suit(c) as usize;
        rank_counts[r] = rank_counts[r].saturating_add(1);
        suit_counts[s] = suit_counts[s].saturating_add(1);
    }

    let is_flush = suit_counts.iter().any(|v| *v == 5);
    let straight_high = straight_high_from_counts(&rank_counts);
    let is_straight = straight_high > 0;

    let mut freq = Vec::<(u8, u8)>::new();
    for r in (2..=14).rev() {
        let c = rank_counts[r as usize];
        if c > 0 {
            freq.push((c, r as u8));
        }
    }
    freq.sort_unstable_by(|(ca, ra), (cb, rb)| cb.cmp(ca).then_with(|| rb.cmp(ra)));

    if is_straight && is_flush {
        return (8, 0);
    }
    if freq.first().map(|(c, _)| *c).unwrap_or(0) == 4 {
        return (7, 0);
    }
    if freq.len() >= 2 && freq[0].0 == 3 && freq[1].0 == 2 {
        return (6, 0);
    }
    if is_flush {
        return (5, 0);
    }
    if is_straight {
        return (4, 0);
    }
    if freq.first().map(|(c, _)| *c).unwrap_or(0) == 3 {
        return (3, 0);
    }
    if freq.len() >= 2 && freq[0].0 == 2 && freq[1].0 == 2 {
        return (2, 0);
    }
    if freq.first().map(|(c, _)| *c).unwrap_or(0) == 2 {
        return (1, freq[0].1);
    }
    (0, 0)
}

fn straight_high_from_counts(rank_counts: &[u8; 15]) -> u8 {
    for hi in (6..=14).rev() {
        if rank_counts[hi] > 0
            && rank_counts[hi - 1] > 0
            && rank_counts[hi - 2] > 0
            && rank_counts[hi - 3] > 0
            && rank_counts[hi - 4] > 0
        {
            return hi as u8;
        }
    }
    if rank_counts[14] > 0
        && rank_counts[5] > 0
        && rank_counts[4] > 0
        && rank_counts[3] > 0
        && rank_counts[2] > 0
    {
        return 5;
    }
    0
}

fn core_straight_outs(core: [u8; 2], board: &[u8], is_holdem: bool) -> u8 {
    if board.len() >= 5 {
        return 0;
    }

    let hr1 = card_rank_value(core[0]);
    let hr2 = card_rank_value(core[1]);
    let mut board_ranks = Vec::<u8>::with_capacity(board.len() + 1);
    for &c in board {
        board_ranks.push(card_rank_value(c));
    }

    let mut used_rank_count = [0u8; 15];
    used_rank_count[hr1 as usize] = used_rank_count[hr1 as usize].saturating_add(1);
    used_rank_count[hr2 as usize] = used_rank_count[hr2 as usize].saturating_add(1);
    for &r in &board_ranks {
        used_rank_count[r as usize] = used_rank_count[r as usize].saturating_add(1);
    }

    let mut outs = 0u8;
    for r in 2u8..=14u8 {
        let remain = 4u8.saturating_sub(used_rank_count[r as usize]);
        if remain == 0 {
            continue;
        }
        board_ranks.push(r);
        let makes = if is_holdem {
            has_holdem_straight_by_rank_values(hr1, hr2, &board_ranks)
        } else {
            has_omaha_core_straight_ranks(hr1, hr2, &board_ranks)
        };
        board_ranks.pop();
        if makes {
            outs = outs.saturating_add(remain);
        }
    }
    outs
}

fn straight_outs_for_hand(hand: &[u8], board: &[u8], is_holdem: bool) -> u8 {
    if board.len() >= 5 {
        return 0;
    }
    if is_holdem && hand.len() != 2 {
        return 0;
    }

    let mut board_ranks = Vec::<u8>::with_capacity(board.len() + 1);
    for &c in board {
        board_ranks.push(card_rank_value(c));
    }
    let mut used_rank_count = [0u8; 15];
    for &c in hand.iter().chain(board.iter()) {
        let r = card_rank_value(c);
        used_rank_count[r as usize] = used_rank_count[r as usize].saturating_add(1);
    }
    let mut outs = 0u8;
    if is_holdem {
        let hr1 = card_rank_value(hand[0]);
        let hr2 = card_rank_value(hand[1]);
        for r in 2u8..=14u8 {
            let remain = 4u8.saturating_sub(used_rank_count[r as usize]);
            if remain == 0 {
                continue;
            }
            board_ranks.push(r);
            if has_holdem_straight_by_rank_values(hr1, hr2, &board_ranks) {
                outs = outs.saturating_add(remain);
            }
            board_ranks.pop();
        }
    } else {
        for r in 2u8..=14u8 {
            let remain = 4u8.saturating_sub(used_rank_count[r as usize]);
            if remain == 0 {
                continue;
            }
            board_ranks.push(r);
            if has_omaha_straight_by_rank_values(hand, &board_ranks) {
                outs = outs.saturating_add(remain);
            }
            board_ranks.pop();
        }
    }
    outs
}

fn has_holdem_straight_by_ranks(hand2: &[u8; 2], board: &[u8]) -> bool {
    let hr1 = card_rank_value(hand2[0]);
    let hr2 = card_rank_value(hand2[1]);
    let mut board_ranks = Vec::<u8>::with_capacity(board.len());
    for &c in board {
        board_ranks.push(card_rank_value(c));
    }
    has_holdem_straight_by_rank_values(hr1, hr2, &board_ranks)
}

fn has_holdem_straight_by_rank_values(hr1: u8, hr2: u8, board_ranks: &[u8]) -> bool {
    let mut present = [false; 15];
    present[hr1 as usize] = true;
    present[hr2 as usize] = true;
    for &r in board_ranks {
        present[r as usize] = true;
    }

    for hi in (6..=14).rev() {
        if present[hi] && present[hi - 1] && present[hi - 2] && present[hi - 3] && present[hi - 4] {
            return true;
        }
    }
    present[14] && present[5] && present[4] && present[3] && present[2]
}

fn has_omaha_core_straight(core: [u8; 2], board: &[u8]) -> bool {
    if board.len() < 3 {
        return false;
    }
    let hr1 = card_rank_value(core[0]);
    let hr2 = card_rank_value(core[1]);
    let mut board_ranks = Vec::<u8>::with_capacity(board.len());
    for &c in board {
        board_ranks.push(card_rank_value(c));
    }
    has_omaha_core_straight_ranks(hr1, hr2, &board_ranks)
}

fn has_omaha_straight(hand: &[u8], board: &[u8]) -> bool {
    if board.len() < 3 {
        return false;
    }
    let mut board_ranks = Vec::<u8>::with_capacity(board.len());
    for &c in board {
        board_ranks.push(card_rank_value(c));
    }
    has_omaha_straight_by_rank_values(hand, &board_ranks)
}

fn has_omaha_straight_by_rank_values(hand: &[u8], board_ranks: &[u8]) -> bool {
    if board_ranks.len() < 3 {
        return false;
    }
    for i in 0..hand.len().saturating_sub(1) {
        let hr1 = card_rank_value(hand[i]);
        for j in (i + 1)..hand.len() {
            let hr2 = card_rank_value(hand[j]);
            if has_omaha_core_straight_ranks(hr1, hr2, board_ranks) {
                return true;
            }
        }
    }
    false
}

fn has_omaha_core_straight_ranks(hr1: u8, hr2: u8, board_ranks: &[u8]) -> bool {
    if board_ranks.len() < 3 {
        return false;
    }
    for i in 0..board_ranks.len().saturating_sub(2) {
        let r1 = board_ranks[i];
        for j in (i + 1)..board_ranks.len().saturating_sub(1) {
            let r2 = board_ranks[j];
            for k in (j + 1)..board_ranks.len() {
                let r3 = board_ranks[k];
                if is_five_rank_straight(hr1, hr2, r1, r2, r3) {
                    return true;
                }
            }
        }
    }
    false
}

fn is_five_rank_straight(r1: u8, r2: u8, r3: u8, r4: u8, r5: u8) -> bool {
    let mut seen = [false; 15];
    for r in [r1, r2, r3, r4, r5] {
        seen[r as usize] = true;
    }
    let uniq = (2..=14).filter(|r| seen[*r]).count();
    if uniq != 5 {
        return false;
    }
    for hi in (6..=14).rev() {
        if seen[hi] && seen[hi - 1] && seen[hi - 2] && seen[hi - 3] && seen[hi - 4] {
            return true;
        }
    }
    seen[14] && seen[5] && seen[4] && seen[3] && seen[2]
}

fn tag_uses_suit_labels(tag: TagAtom) -> bool {
    matches!(tag, TagAtom::FlushDraw | TagAtom::Flush { plus: false })
}

fn core_rank_label(c1: u8, c2: u8) -> String {
    const RANK_CHARS: &str = "??23456789TJQKA";
    let r1 = card_rank_value(c1);
    let r2 = card_rank_value(c2);
    let high = r1.max(r2);
    let low = r1.min(r2);
    let has_face_num_mix = high >= 11 && low <= 10;
    let (a, b) = if has_face_num_mix {
        (low, high)
    } else {
        (high, low)
    };
    let ac = RANK_CHARS.chars().nth(a as usize).unwrap_or('?');
    let bc = RANK_CHARS.chars().nth(b as usize).unwrap_or('?');
    format!("{ac}{bc}")
}

fn core_suit_label(c1: u8, c2: u8) -> String {
    let s1 = SUITS.chars().nth(card_suit(c1) as usize).unwrap_or('x');
    let s2 = SUITS.chars().nth(card_suit(c2) as usize).unwrap_or('x');
    format!("{s1}{s2}")
}

fn to_native_sim_request(payload: &NativeSimReq) -> native_sim::SimRequest {
    native_sim::SimRequest {
        variant: payload.variant.clone(),
        iteration_cap: payload.iteration_cap,
        board: payload.board.clone(),
        dead: payload.dead.clone(),
        players: payload
            .players
            .iter()
            .map(|p| native_sim::SimPlayerReq {
                mode: p.mode.clone(),
                hand_size: p.hand_size,
                pool: p.pool.clone(),
                plan: p.plan.clone(),
                weight_pct: p.weight_pct,
            })
            .collect(),
        workers: payload.workers,
        seed: payload.seed,
        confidence_target_pct: payload.confidence_target_pct,
        confidence_min_iters: payload.confidence_min_iters,
        confidence_level: payload.confidence_level,
    }
}

async fn run_native_sim(payload: &NativeSimReq) -> Result<native_sim::RawOut, String> {
    let sim_req = to_native_sim_request(payload);
    let out = tokio::task::spawn_blocking(move || native_sim::run_sim(sim_req))
        .await
        .map_err(|e| format!("join native-sim task: {e}"))?;
    out.map_err(|e| format!("native simulator failed: {e}"))
}

fn parse_cards_text(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let s = text.trim().replace(' ', "");
    if s.is_empty() {
        return Ok(out);
    }
    if s.len() % 2 != 0 {
        return Err(format!("invalid card text '{text}'"));
    }

    let mut seen = [false; 52];
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let r = chars[i].to_ascii_uppercase();
        let u = chars[i + 1].to_ascii_lowercase();
        let rank = rank_char_to_idx(r).ok_or_else(|| format!("invalid rank '{}'", chars[i]))?;
        let suit = suit_char_to_idx(u).ok_or_else(|| format!("invalid suit '{}'", chars[i + 1]))?;
        let id = rank as usize * 4 + suit as usize;
        if seen[id] {
            return Err(format!("duplicate card '{}{}'", r, u));
        }
        seen[id] = true;
        out.push(id as u8);
        i += 2;
    }
    Ok(out)
}

fn validate_disjoint(a: &[u8], b: &[u8]) -> Result<(), String> {
    let mut seen = [false; 52];
    for c in a.iter().chain(b.iter()) {
        if *c > 51 {
            return Err(format!("invalid card id {}", c));
        }
        let idx = *c as usize;
        if seen[idx] {
            return Err(format!("duplicate card id {}", c));
        }
        seen[idx] = true;
    }
    Ok(())
}

fn base_deck(board: &[u8], dead: &[u8]) -> Vec<u8> {
    let mut blocked = [false; 52];
    for c in board.iter().chain(dead.iter()) {
        blocked[*c as usize] = true;
    }
    let mut out = Vec::with_capacity(52 - board.len() - dead.len());
    for c in 0u8..52u8 {
        if !blocked[c as usize] {
            out.push(c);
        }
    }
    out
}

fn n_choose_k(n: usize, k: usize) -> usize {
    if k > n {
        return 0;
    }
    if k == 0 || k == n {
        return 1;
    }
    let kk = k.min(n - k);
    let mut out = 1usize;
    for i in 1..=kk {
        out = (out * (n - kk + i)) / i;
    }
    out
}

fn variant_hand_size(variant: &str) -> Option<usize> {
    match variant {
        "holdem" => Some(2),
        "plo4" => Some(4),
        "plo5" => Some(5),
        "plo6" => Some(6),
        _ => None,
    }
}

fn variant_from_hand_size(hand_size: usize) -> &'static str {
    match hand_size {
        2 => "holdem",
        4 => "plo4",
        5 => "plo5",
        6 => "plo6",
        _ => "",
    }
}

fn pool_cap_for(hand_size: usize) -> usize {
    match hand_size {
        2 => 20_000,
        4 => 180_000,
        5 => 320_000,
        6 => 160_000,
        _ => 64_000,
    }
}

fn rank_char_to_idx(ch: char) -> Option<u8> {
    RANKS.find(ch).map(|idx| idx as u8)
}

fn suit_char_to_idx(ch: char) -> Option<u8> {
    SUITS.find(ch).map(|idx| idx as u8)
}

fn card_rank(card: u8) -> u8 {
    card / 4
}

fn card_rank_value(card: u8) -> u8 {
    card / 4 + 2
}

fn card_suit(card: u8) -> u8 {
    card % 4
}

fn error_json(status: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({
            "ok": false,
            "error": msg
        })),
    )
}
