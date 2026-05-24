use anyhow::{Context, Result};
use aya_poker::base::{Hand, CARDS};
use aya_poker::{omaha_rank, poker_rank, PokerRankCategory};
use base64::engine::general_purpose::STANDARD as B64_STANDARD;
use base64::Engine as _;
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

type ChooseTable = [[usize; 7]; 53];

static COMBO_RANK_PREFIX: OnceLock<[[usize; 53]; 7]> = OnceLock::new();
static EXACT_OURS_HOLDEM: OnceLock<Option<Arc<ExactPercentileTable>>> = OnceLock::new();
static EXACT_OURS_PLO4: OnceLock<Option<Arc<ExactPercentileTable>>> = OnceLock::new();
static EXACT_OURS_PLO5: OnceLock<Option<Arc<ExactPercentileTable>>> = OnceLock::new();
static EXACT_OURS_PLO6: OnceLock<Option<Arc<ExactPercentileTable>>> = OnceLock::new();
static EXACT_PPT6MAX_PLO4: OnceLock<Option<Arc<ExactPercentileTable>>> = OnceLock::new();
static EXACT_PPT6MAX_PLO5: OnceLock<Option<Arc<ExactPercentileTable>>> = OnceLock::new();
static EXACT_CHOOSE: OnceLock<ChooseTable> = OnceLock::new();

#[derive(Debug)]
struct ExactPercentileTable {
    basis: usize,
    sample_size: usize,
    top_score_keys: Vec<u16>,
    top_ranks: Vec<u32>,
    score_keys_by_combo_rank: Vec<u16>,
}

#[derive(Debug, Clone)]
pub struct ExactPercentileTableRef {
    table: Arc<ExactPercentileTable>,
}

#[derive(Debug, Clone, Copy)]
pub enum ExactPercentBoundary {
    None,
    All,
    Partial {
        boundary_score: u16,
        boundary_rank: usize,
    },
}

#[derive(Debug, Clone)]
pub struct SimRequest {
    pub variant: String,
    pub iteration_cap: usize,
    pub board: Vec<u8>,
    pub dead: Vec<u8>,
    pub players: Vec<SimPlayerReq>,
    pub workers: Option<usize>,
    pub seed: Option<u64>,
    pub confidence_target_pct: Option<f64>,
    pub confidence_min_iters: Option<usize>,
    pub confidence_level: Option<f64>,
    pub max_runtime_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SimPlayerReq {
    pub mode: String,
    pub hand_size: usize,
    pub pool: Option<Vec<Vec<u8>>>,
    pub plan: Option<PlanNodeReq>,
    pub range_text: Option<String>,
    pub weight_pct: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    mode: String,
    variant: String,
    #[serde(default)]
    iteration_cap: usize,
    #[serde(default)]
    board: Vec<u8>,
    #[serde(default)]
    dead: Vec<u8>,
    #[serde(default)]
    players: Vec<PlayerReq>,
    workers: Option<usize>,
    seed: Option<u64>,
    confidence_target_pct: Option<f64>,
    confidence_min_iters: Option<usize>,
    confidence_level: Option<f64>,
    max_runtime_ms: Option<u64>,
    #[serde(default)]
    hand_size: usize,
    pool_cap: Option<usize>,
    plan: Option<PlanNodeReq>,
    range_text: Option<String>,
    percentile_profile: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PlayerReq {
    mode: String,
    hand_size: usize,
    #[serde(default)]
    pool: Option<Vec<Vec<u8>>>,
    #[serde(default)]
    plan: Option<PlanNodeReq>,
    #[serde(default)]
    range_text: Option<String>,
    #[serde(default)]
    weight_pct: Option<u8>,
}

#[derive(Debug, Serialize)]
struct Response {
    ok: bool,
    error: Option<String>,
    raw: Option<RawOut>,
    equity_rank: Option<EquityRankOut>,
    pool_build: Option<PoolBuildOut>,
    coverage: Option<CoverageOut>,
    tag_shortcuts: Option<TagShortcutsOut>,
}

#[derive(Debug, Serialize)]
pub struct RawOut {
    pub iterations: usize,
    pub elapsed_ms: f64,
    pub wins: Vec<usize>,
    pub ties: Vec<usize>,
    pub losses: Vec<usize>,
    pub equity_shares: Vec<f64>,
    pub combo_counts: Vec<usize>,
    pub combo_lists: Vec<Vec<String>>,
    pub class_counts: Vec<Vec<usize>>,
    pub confidence_reached: bool,
    pub confidence_half_width_pct: f64,
    pub confidence_level: f64,
}

#[derive(Debug, Serialize)]
struct EquityRankOut {
    variant: String,
    hand_size: usize,
    combo_space: usize,
    iteration_cap: usize,
    observations: usize,
    elapsed_ms: f64,
    basis: usize,
    score_scale: usize,
    zero_sample_combos: usize,
    min_samples: u32,
    max_samples: u32,
    mean_samples_per_combo: f64,
    score_keys_by_combo_rank: Vec<u16>,
    top_score_keys: Vec<u16>,
    top_ranks: Vec<u32>,
}

#[derive(Debug, Serialize)]
struct PoolBuildOut {
    variant: String,
    hand_size: usize,
    total: usize,
    matched: usize,
    pool: Vec<Vec<u8>>,
}

#[derive(Debug, Serialize)]
struct CoverageOut {
    matched: usize,
    total: usize,
    pct: f64,
    approx: bool,
}

#[derive(Debug, Serialize)]
struct TagShortcutsOut {
    combos_by_tag: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum PlanNodeReq {
    #[serde(rename = "or")]
    Or {
        left: Box<PlanNodeReq>,
        right: Box<PlanNodeReq>,
    },
    #[serde(rename = "and")]
    And {
        left: Box<PlanNodeReq>,
        right: Box<PlanNodeReq>,
    },
    #[serde(rename = "not")]
    Not {
        left: Box<PlanNodeReq>,
        right: Box<PlanNodeReq>,
    },
    #[serde(rename = "specs")]
    Specs { entries: Vec<Vec<SpecReq>> },
    #[serde(rename = "pct_bits")]
    PctBits {
        #[serde(default)]
        bits_b64: Option<String>,
        #[serde(default)]
        bits: Option<Vec<u8>>,
    },
    #[serde(rename = "pct_exact_top")]
    PctExactTop {
        variant: String,
        profile: String,
        pct: f64,
    },
    #[serde(rename = "pct_exact_range")]
    PctExactRange {
        variant: String,
        profile: String,
        low_pct: f64,
        high_pct: f64,
    },
    #[serde(rename = "heuristic_top")]
    HeuristicTop { threshold: f64 },
    #[serde(rename = "heuristic_range")]
    HeuristicRange {
        low_threshold: f64,
        high_threshold: f64,
    },
    #[serde(rename = "tag")]
    Tag { tag: PlanTagReq },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecReq {
    pub ranks_mask: u16,
    pub rank_var: i8,
    pub suit_mode: u8,
    pub suit_value: i8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanTagKind {
    TopPair,
    Overpair,
    TwoPair,
    Set,
    FlushDraw,
    Flush,
    StraightDraw,
    Straight,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PlanTagReq {
    pub kind: PlanTagKind,
    #[serde(default)]
    pub plus: bool,
    #[serde(default)]
    pub min_outs: u8,
}

#[derive(Clone)]
enum PlanNode {
    Or(Box<PlanNode>, Box<PlanNode>),
    And(Box<PlanNode>, Box<PlanNode>),
    Not(Box<PlanNode>, Box<PlanNode>),
    Specs {
        entries: Vec<Vec<Spec>>,
    },
    PctBits {
        bits: Vec<u8>,
    },
    PctExactTop {
        table: Arc<ExactPercentileTable>,
        boundary: ExactPercentBoundary,
    },
    PctExactRange {
        table: Arc<ExactPercentileTable>,
        low_boundary: ExactPercentBoundary,
        high_boundary: ExactPercentBoundary,
    },
    HeuristicTop {
        threshold: f64,
    },
    HeuristicRange {
        low_threshold: f64,
        high_threshold: f64,
    },
    Tag(TagAtom),
}

#[derive(Clone, Copy)]
struct Spec {
    ranks_mask: u16,
    rank_var: i8,
    suit_mode: u8,
    suit_value: i8,
}

#[derive(Clone)]
enum Sampler {
    All {
        hand_size: usize,
        weight_pct: u8,
    },
    Pool {
        hand_size: usize,
        pool: Vec<PoolEntry>,
        weight_pct: u8,
    },
    Plan {
        hand_size: usize,
        plan: PlanNode,
        weight_pct: u8,
    },
}

#[derive(Clone)]
struct PoolEntry {
    cards: [u8; 6],
    mask: u64,
}

impl PoolEntry {
    fn new(cards: &[u8]) -> Self {
        let mut fixed = [0u8; 6];
        fixed[..cards.len()].copy_from_slice(cards);
        Self {
            cards: fixed,
            mask: cards_mask(cards),
        }
    }
}

#[derive(Clone, Copy)]
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

struct ComboSet {
    bits: Vec<u64>,
    seen: usize,
}

impl ComboSet {
    fn new(total_space: usize) -> Self {
        let words = (total_space + 63) / 64;
        Self {
            bits: vec![0u64; words],
            seen: 0,
        }
    }

    fn insert_index(&mut self, idx: usize) {
        let word = idx >> 6;
        let bit = idx & 63;
        let mask = 1u64 << bit;
        let cur = self.bits[word];
        if (cur & mask) == 0 {
            self.bits[word] = cur | mask;
            self.seen += 1;
        }
    }

    fn merge_from(&mut self, other: &ComboSet) {
        for i in 0..self.bits.len() {
            let before = self.bits[i];
            let merged = before | other.bits[i];
            if merged != before {
                self.seen += (merged ^ before).count_ones() as usize;
                self.bits[i] = merged;
            }
        }
    }

    fn count(&self) -> usize {
        self.seen
    }
}

struct Partial {
    iterations: usize,
    wins: Vec<usize>,
    ties: Vec<usize>,
    losses: Vec<usize>,
    equity_shares: Vec<f64>,
    equity_squares: Vec<f64>,
    combo_sets: Vec<ComboSet>,
    class_counts: Vec<Vec<usize>>,
}

struct EquityRankPartial {
    counts: Vec<u32>,
    shares: Vec<f32>,
}

#[derive(Clone, Copy)]
struct ConfidenceCfg {
    enabled: bool,
    target_pct: f64,
    min_iters: usize,
    level: f64,
    z: f64,
}

fn sim_request_to_internal(req: SimRequest) -> Request {
    Request {
        mode: "sim".to_string(),
        variant: req.variant,
        iteration_cap: req.iteration_cap,
        board: req.board,
        dead: req.dead,
        players: req
            .players
            .into_iter()
            .map(|p| PlayerReq {
                mode: p.mode,
                hand_size: p.hand_size,
                pool: p.pool,
                plan: p.plan,
                range_text: p.range_text,
                weight_pct: p.weight_pct,
            })
            .collect(),
        workers: req.workers,
        seed: req.seed,
        confidence_target_pct: req.confidence_target_pct,
        confidence_min_iters: req.confidence_min_iters,
        confidence_level: req.confidence_level,
        max_runtime_ms: req.max_runtime_ms,
        hand_size: 0,
        pool_cap: None,
        plan: None,
        range_text: None,
        percentile_profile: None,
        tags: Vec::new(),
    }
}

pub fn run_sim(req: SimRequest) -> Result<RawOut> {
    let internal = sim_request_to_internal(req);
    let out = run_sim_mode(&internal)?;
    out.raw.context("missing raw sim output")
}

fn error_response_value(msg: impl Into<String>) -> Value {
    serde_json::json!({
        "ok": false,
        "error": msg.into(),
        "raw": null,
        "equity_rank": null,
        "pool_build": null,
        "coverage": null,
        "tag_shortcuts": null
    })
}

pub fn run_request_json(input: &str) -> Value {
    match serde_json::from_str::<Value>(input) {
        Ok(v) => run_request_value(v),
        Err(err) => error_response_value(format!("invalid input json: {err}")),
    }
}

pub fn run_request_value(input: Value) -> Value {
    match run_request_value_inner(input) {
        Ok(v) => v,
        Err(err) => error_response_value(err.to_string()),
    }
}

fn run_request_value_inner(input: Value) -> Result<Value> {
    let req: Request = serde_json::from_value(input).context("invalid input json")?;
    let out = run_request(&req)?;
    serde_json::to_value(out).context("failed to serialize output json")
}

fn run_request(req: &Request) -> Result<Response> {
    let mode = request_mode(&req);
    match mode {
        "sim" => run_sim_mode(&req),
        "equity-rank" => run_equity_rank_mode(&req),
        "build-pool" => run_build_pool_mode(&req),
        "preview-range" => run_preview_range_mode(&req),
        "tag-shortcuts" => run_tag_shortcuts_mode(&req),
        _ => anyhow::bail!("unsupported mode '{}'", mode),
    }
}

fn request_mode(req: &Request) -> &str {
    if req.mode.trim().is_empty() {
        "sim"
    } else {
        req.mode.as_str()
    }
}

fn run_sim_mode(req: &Request) -> Result<Response> {
    validate_request(req)?;

    let samplers = build_samplers(req)?;
    let workers = choose_workers(req.workers, req.iteration_cap);
    let seed = req.seed.unwrap_or(0x9E37_79B9_A5A5_1234);
    let conf = confidence_cfg(req);
    let choose = build_choose_table();
    let combo_space = choose[52][variant_hand_size(&req.variant)];
    let start = Instant::now();
    let deadline = simulation_deadline(start, req.max_runtime_ms);

    let thread_pool = ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()
        .context("failed to build rayon thread pool")?;

    let pcount = req.players.len();
    let mut total = new_partial(pcount, combo_space);
    let mut remaining = req.iteration_cap;
    let mut round = 0usize;
    let round_iters = choose_round_iters(req.iteration_cap, workers, conf.enabled);

    while remaining > 0 {
        if deadline_reached(deadline) {
            break;
        }
        let run_now = if conf.enabled {
            remaining.min(round_iters)
        } else {
            remaining
        };
        if run_now == 0 {
            break;
        }

        let parts = split_iterations(run_now, workers);
        let partials: Vec<Partial> = thread_pool.install(|| {
            parts
                .into_par_iter()
                .enumerate()
                .map(|(idx, iters)| {
                    let worker_seed = seed
                        .wrapping_add(((idx as u64) + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15))
                        .wrapping_add((round as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9));
                    simulate_partition(
                        req,
                        &samplers,
                        iters,
                        worker_seed,
                        &choose,
                        combo_space,
                        deadline,
                    )
                })
                .collect()
        });

        for part in partials {
            merge_in_place(&mut total, part);
        }

        if total.iterations == 0 {
            break;
        }

        remaining = remaining.saturating_sub(run_now);
        round = round.wrapping_add(1);

        if conf.enabled {
            let (done, _) = confidence_reached(&total, conf);
            if done {
                break;
            }
        }
        if deadline_reached(deadline) {
            break;
        }
    }

    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    let (_, max_half_width_pct) = confidence_reached(&total, conf);
    let confidence_reached_now = conf.enabled
        && total.iterations >= conf.min_iters
        && max_half_width_pct.is_finite()
        && max_half_width_pct <= conf.target_pct;

    let out = Response {
        ok: true,
        error: None,
        raw: Some(RawOut {
            iterations: total.iterations,
            elapsed_ms,
            wins: total.wins,
            ties: total.ties,
            losses: total.losses,
            equity_shares: total.equity_shares,
            combo_counts: total.combo_sets.iter().map(ComboSet::count).collect(),
            combo_lists: (0..pcount).map(|_| Vec::new()).collect(),
            class_counts: total.class_counts,
            confidence_reached: confidence_reached_now,
            confidence_half_width_pct: if max_half_width_pct.is_finite() {
                max_half_width_pct
            } else {
                0.0
            },
            confidence_level: conf.level,
        }),
        equity_rank: None,
        pool_build: None,
        coverage: None,
        tag_shortcuts: None,
    };
    Ok(out)
}

const EQUITY_PERCENT_BASIS: usize = 1000;
const EQUITY_SCORE_SCALE: usize = 10_000;

fn run_equity_rank_mode(req: &Request) -> Result<Response> {
    validate_equity_rank_request(req)?;
    let hand_size = variant_hand_size(&req.variant);
    let combo_space = n_choose_k(52, hand_size);
    let workers = choose_workers(req.workers, req.iteration_cap);
    let seed = req.seed.unwrap_or(0x7E57_EA10_1234_5678);
    let choose = build_choose_table();

    let thread_pool = ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()
        .context("failed to build rayon thread pool")?;
    let start = std::time::Instant::now();

    let parts = split_iterations(req.iteration_cap, workers);
    let partials: Vec<EquityRankPartial> = thread_pool.install(|| {
        parts
            .into_par_iter()
            .enumerate()
            .map(|(idx, iters)| {
                let worker_seed = seed
                    .wrapping_add(((idx as u64) + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15))
                    .wrapping_add(0xBF58_476D_1CE4_E5B9);
                simulate_equity_rank_partition(
                    &req.variant,
                    hand_size,
                    iters,
                    worker_seed,
                    &choose,
                    combo_space,
                )
            })
            .collect()
    });

    let mut total = new_equity_rank_partial(combo_space);
    for p in partials {
        merge_equity_rank_in_place(&mut total, p);
    }

    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    let stats = build_equity_rank_stats(&total, combo_space);

    let out = Response {
        ok: true,
        error: None,
        raw: None,
        equity_rank: Some(EquityRankOut {
            variant: req.variant.clone(),
            hand_size,
            combo_space,
            iteration_cap: req.iteration_cap,
            observations: stats.observations,
            elapsed_ms,
            basis: EQUITY_PERCENT_BASIS,
            score_scale: EQUITY_SCORE_SCALE,
            zero_sample_combos: stats.zero_sample_combos,
            min_samples: stats.min_samples,
            max_samples: stats.max_samples,
            mean_samples_per_combo: stats.mean_samples_per_combo,
            score_keys_by_combo_rank: stats.score_keys_by_combo_rank,
            top_score_keys: stats.top_score_keys,
            top_ranks: stats.top_ranks,
        }),
        pool_build: None,
        coverage: None,
        tag_shortcuts: None,
    };
    Ok(out)
}

fn run_build_pool_mode(req: &Request) -> Result<Response> {
    let expected = variant_hand_size(&req.variant);
    if expected == 0 {
        anyhow::bail!("unsupported variant '{}'", req.variant);
    }
    validate_board_and_dead(&req.board, &req.dead)?;

    let hand_size = if req.hand_size > 0 {
        req.hand_size
    } else {
        expected
    };
    if hand_size != expected {
        anyhow::bail!(
            "hand_size {} does not match variant {} ({})",
            hand_size,
            req.variant,
            expected
        );
    }

    let cap = req.pool_cap.unwrap_or(320_000).max(1);
    let raw_plan;
    let plan_req = if let Some(plan) = req.plan.as_ref() {
        Some(plan)
    } else if let Some(range_text) = req.range_text.as_deref() {
        raw_plan = compile_range_text_to_plan(
            range_text,
            &req.variant,
            req.percentile_profile.as_deref().unwrap_or_default(),
        )?;
        raw_plan.as_ref()
    } else {
        None
    }
    .context("missing plan or range_text for build-pool mode")?;
    let plan = compile_plan_node(plan_req)?;
    let choose = build_choose_table();
    let seed = req.seed.unwrap_or(0xC0DE_F00D_9E37_79B9);
    let mut rng = SmallRng::seed_from_u64(seed);
    let is_holdem = req.variant == "holdem";

    let mut blocked = [false; 52];
    for &c in req.board.iter().chain(req.dead.iter()) {
        blocked[c as usize] = true;
    }
    let mut base_deck = Vec::with_capacity(52 - req.board.len() - req.dead.len());
    for c in 0u8..52u8 {
        if !blocked[c as usize] {
            base_deck.push(c);
        }
    }
    if base_deck.len() < hand_size {
        anyhow::bail!("not enough available cards for hand_size {}", hand_size);
    }

    let total = n_choose_k(base_deck.len(), hand_size);
    let mut hand = vec![0u8; hand_size];
    let mut pool: Vec<Vec<u8>> = Vec::with_capacity(cap.min(total));
    let mut matched = 0usize;
    enumerate_pool_with_plan(
        0,
        0,
        &base_deck,
        hand_size,
        &mut hand,
        &plan,
        &choose,
        &req.board,
        is_holdem,
        cap,
        &mut rng,
        &mut pool,
        &mut matched,
    );

    let out = Response {
        ok: true,
        error: None,
        raw: None,
        equity_rank: None,
        pool_build: Some(PoolBuildOut {
            variant: req.variant.clone(),
            hand_size,
            total,
            matched,
            pool,
        }),
        coverage: None,
        tag_shortcuts: None,
    };
    Ok(out)
}

fn run_preview_range_mode(req: &Request) -> Result<Response> {
    let expected = variant_hand_size(&req.variant);
    if expected == 0 {
        anyhow::bail!("unsupported variant '{}'", req.variant);
    }
    validate_board_and_dead(&req.board, &req.dead)?;

    let hand_size = if req.hand_size > 0 {
        req.hand_size
    } else {
        expected
    };
    if hand_size != expected {
        anyhow::bail!(
            "hand_size {} does not match variant {} ({})",
            hand_size,
            req.variant,
            expected
        );
    }

    let raw_plan;
    let plan_req = if let Some(plan) = req.plan.as_ref() {
        Some(plan)
    } else {
        let range_text = req
            .range_text
            .as_deref()
            .context("missing plan or range_text for preview-range mode")?;
        raw_plan = compile_range_text_to_plan(
            range_text,
            &req.variant,
            req.percentile_profile.as_deref().unwrap_or_default(),
        )?;
        raw_plan.as_ref()
    };

    let mut blocked = [false; 52];
    for &c in req.board.iter().chain(req.dead.iter()) {
        blocked[c as usize] = true;
    }
    let mut base_deck = Vec::with_capacity(52 - req.board.len() - req.dead.len());
    for c in 0u8..52u8 {
        if !blocked[c as usize] {
            base_deck.push(c);
        }
    }
    if base_deck.len() < hand_size {
        anyhow::bail!("not enough available cards for hand_size {}", hand_size);
    }

    let total = n_choose_k(base_deck.len(), hand_size);
    let matched = if let Some(plan_req) = plan_req {
        if req.board.is_empty() && req.dead.is_empty() {
            if let Some(count) = exact_preflop_count_for_plan(plan_req, &req.variant, hand_size) {
                count
            } else {
                let plan = compile_plan_node(plan_req)?;
                count_plan_matches(
                    &base_deck,
                    hand_size,
                    &plan,
                    &build_choose_table(),
                    &req.board,
                    req.variant == "holdem",
                )
            }
        } else {
            let plan = compile_plan_node(plan_req)?;
            count_plan_matches(
                &base_deck,
                hand_size,
                &plan,
                &build_choose_table(),
                &req.board,
                req.variant == "holdem",
            )
        }
    } else {
        total
    };

    Ok(Response {
        ok: true,
        error: None,
        raw: None,
        equity_rank: None,
        pool_build: None,
        coverage: Some(CoverageOut {
            matched: matched.min(total),
            total,
            pct: if total > 0 {
                (matched.min(total) as f64 * 100.0) / total as f64
            } else {
                0.0
            },
            approx: false,
        }),
        tag_shortcuts: None,
    })
}

fn run_tag_shortcuts_mode(req: &Request) -> Result<Response> {
    let expected = variant_hand_size(&req.variant);
    if expected == 0 {
        anyhow::bail!("unsupported variant '{}'", req.variant);
    }
    validate_board_and_dead(&req.board, &req.dead)?;
    if req.board.len() < 3 || req.board.len() > 5 {
        return Ok(Response {
            ok: true,
            error: None,
            raw: None,
            equity_rank: None,
            pool_build: None,
            coverage: None,
            tag_shortcuts: Some(TagShortcutsOut {
                combos_by_tag: BTreeMap::new(),
            }),
        });
    }

    let tags: Vec<String> = if req.tags.is_empty() {
        vec![
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
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    } else {
        req.tags.clone()
    };

    let is_holdem = req.variant == "holdem";
    let base = available_deck(&req.board, &req.dead);
    let mut combos_by_tag = BTreeMap::new();
    for raw_tag in tags {
        let Some(tag_req) = tag_plan_req(&raw_tag.to_ascii_lowercase()) else {
            continue;
        };
        let tag = plan_tag_to_atom(tag_req);
        let labels = tag_shortcut_labels_for_native(&base, &req.board, tag, is_holdem);
        combos_by_tag.insert(normalize_tag_label(&raw_tag), labels);
    }

    Ok(Response {
        ok: true,
        error: None,
        raw: None,
        equity_rank: None,
        pool_build: None,
        coverage: None,
        tag_shortcuts: Some(TagShortcutsOut { combos_by_tag }),
    })
}

fn available_deck(board: &[u8], dead: &[u8]) -> Vec<u8> {
    let mut blocked = [false; 52];
    for &card in board.iter().chain(dead.iter()) {
        blocked[card as usize] = true;
    }
    (0u8..52u8)
        .filter(|card| !blocked[*card as usize])
        .collect()
}

fn plan_tag_to_atom(tag: PlanTagReq) -> TagAtom {
    match tag.kind {
        PlanTagKind::TopPair => TagAtom::TopPair { plus: tag.plus },
        PlanTagKind::Overpair => TagAtom::Overpair { plus: tag.plus },
        PlanTagKind::TwoPair => TagAtom::TwoPair { plus: tag.plus },
        PlanTagKind::Set => TagAtom::Set { plus: tag.plus },
        PlanTagKind::FlushDraw => TagAtom::FlushDraw,
        PlanTagKind::Flush => TagAtom::Flush { plus: tag.plus },
        PlanTagKind::StraightDraw => TagAtom::StraightDraw {
            min_outs: tag.min_outs.max(1),
        },
        PlanTagKind::Straight => TagAtom::Straight { plus: tag.plus },
    }
}

fn tag_shortcut_labels_for_native(
    base: &[u8],
    board: &[u8],
    tag: TagAtom,
    is_holdem: bool,
) -> Vec<String> {
    let use_suit = tag_uses_suit_labels(tag);
    let mut labels = BTreeSet::<String>::new();
    for i in 0..base.len() {
        let c1 = base[i];
        for &c2 in base.iter().skip(i + 1) {
            if !core_tag_match(tag, [c1, c2], board, is_holdem) {
                continue;
            }
            let label = if use_suit {
                core_suit_label(c1, c2)
            } else {
                core_rank_label_for_board(c1, c2, board)
            };
            labels.insert(label);
        }
    }
    labels.into_iter().collect()
}

fn tag_uses_suit_labels(tag: TagAtom) -> bool {
    matches!(tag, TagAtom::FlushDraw | TagAtom::Flush { plus: false })
}

fn core_rank_label(c1: u8, c2: u8) -> String {
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
    format!("{}{}", rank_value_char(a), rank_value_char(b))
}

fn core_rank_label_for_board(c1: u8, c2: u8, board: &[u8]) -> String {
    let r1 = card_rank_value(c1);
    let r2 = card_rank_value(c2);
    if r1 != r2 {
        let pos1 = board.iter().position(|card| card_rank_value(*card) == r1);
        let pos2 = board.iter().position(|card| card_rank_value(*card) == r2);
        if let (Some(a), Some(b)) = (pos1, pos2) {
            let (first, second) = if a <= b { (r1, r2) } else { (r2, r1) };
            return format!("{}{}", rank_value_char(first), rank_value_char(second));
        }
    }
    core_rank_label(c1, c2)
}

fn rank_value_char(rank: u8) -> char {
    RANK_CHARS
        .get(rank.saturating_sub(2) as usize)
        .map(|c| *c as char)
        .unwrap_or('?')
}

fn core_suit_label(c1: u8, c2: u8) -> String {
    const SUITS: &[u8; 4] = b"cdhs";
    let s1 = SUITS.get(card_suit(c1) as usize).copied().unwrap_or(b'x') as char;
    let s2 = SUITS.get(card_suit(c2) as usize).copied().unwrap_or(b'x') as char;
    format!("{s1}{s2}")
}

fn normalize_tag_label(tag: &str) -> String {
    tag.trim().to_ascii_lowercase()
}

#[derive(Debug, Clone)]
enum RangeAst {
    Atom(String),
    Or(Box<RangeAst>, Box<RangeAst>),
    And(Box<RangeAst>, Box<RangeAst>),
    Not(Box<RangeAst>, Box<RangeAst>),
}

#[derive(Debug, Clone)]
enum RangeToken {
    Atom(String),
    Comma,
    Colon,
    Bang,
    LParen,
    RParen,
}

struct RangeParser {
    tokens: Vec<RangeToken>,
    pos: usize,
}

const RANK_CHARS: &[u8; 13] = b"23456789TJQKA";
const ALL_RANKS_MASK: u16 = 0x1fff;

fn compile_range_text_to_plan(
    range_text: &str,
    variant: &str,
    percentile_profile: &str,
) -> Result<Option<PlanNodeReq>> {
    let stripped = strip_range_spaces(range_text);
    if stripped.is_empty() || stripped == "*" {
        return Ok(None);
    }
    let expanded = expand_expr_macros(&stripped);
    let tokens = tokenize_range_expr(&expanded)?;
    let ast = RangeParser { tokens, pos: 0 }.parse()?;
    Ok(Some(ast_to_plan(&ast, variant, percentile_profile)?))
}

fn strip_range_weight(range_text: &str) -> (&str, Option<u8>) {
    let compact = range_text.trim();
    let Some(at_pos) = compact.rfind('@') else {
        return (compact, None);
    };
    let suffix = &compact[at_pos + 1..];
    if suffix.is_empty() || suffix.len() > 3 || !suffix.chars().all(|c| c.is_ascii_digit()) {
        return (compact, None);
    }
    let value = suffix.parse::<u8>().ok().map(|v| v.clamp(1, 100));
    (compact[..at_pos].trim_end(), value)
}

fn strip_range_spaces(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| if c == '&' { ':' } else { c })
        .collect()
}

fn expand_expr_macros(expr: &str) -> String {
    const REPLACEMENTS: &[(&str, &str)] = &[
        ("$overpair", ":RRON"),
        ("$tpplus", ":RROO"),
        ("$straight", "@s"),
        ("$flush", "@f"),
        ("$ds", ":xxyy"),
        ("$ss", ":xxyz"),
        ("$np", "!RR"),
        ("$op", ":RRON"),
        ("$tp", ":RROO"),
        ("$nt", "!RRR"),
        ("$0g", "AKQJ-"),
        ("$1g", "(AKQT-,AKJT-,AQJT-)"),
        ("$2g", "(AKQ9-,AKT9-,AJT9-)"),
        ("$s", ":xx"),
        ("$o", ":xy"),
        ("$b", "[A-J]"),
        ("$m", "[T-7]"),
        ("$z", "[6-2]"),
        ("$l", "[A,2,3,4,5,6,7,8]"),
        ("$n", "[K-9]"),
        ("$f", "[K-J]"),
        ("$r", "[A-T]"),
        ("$w", "[A,2,3,4,5]"),
    ];
    let mut out = String::new();
    let mut i = 0usize;
    while i < expr.len() {
        let rest = &expr[i..];
        if !rest.starts_with('$') {
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let rest_lower = rest.to_ascii_lowercase();
        let found = REPLACEMENTS
            .iter()
            .find(|(key, _)| rest_lower.starts_with(*key));
        let Some((key, replacement)) = found else {
            out.push('$');
            i += 1;
            continue;
        };
        let prev = out.chars().last().unwrap_or('\0');
        let is_and = matches!(*key, "$s" | "$o" | "$ds" | "$ss" | "$op" | "$tp");
        let is_not = matches!(*key, "$np" | "$nt");
        if is_and {
            let payload = replacement.strip_prefix(':').unwrap_or(replacement);
            if prev == '\0' || prev == ',' || prev == '(' {
                out.push_str("*:");
                out.push_str(payload);
            } else if prev == ':' {
                out.push_str(payload);
            } else {
                out.push(':');
                out.push_str(payload);
            }
        } else if is_not {
            let payload = replacement.strip_prefix('!').unwrap_or(replacement);
            if prev == '\0' || prev == ',' || prev == '(' || prev == ':' {
                out.push_str("*!");
                out.push_str(payload);
            } else if prev == '!' {
                out.push_str(payload);
            } else {
                out.push('!');
                out.push_str(payload);
            }
        } else {
            out.push_str(replacement);
        }
        i += key.len();
    }
    out
}

fn tokenize_range_expr(s: &str) -> Result<Vec<RangeToken>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut bracket_depth = 0i32;
    for ch in s.chars() {
        if ch == '[' {
            bracket_depth += 1;
        } else if ch == ']' {
            bracket_depth -= 1;
            if bracket_depth < 0 {
                anyhow::bail!("unexpected ']' in range");
            }
        }
        if bracket_depth == 0 && matches!(ch, ',' | ':' | '!' | '(' | ')') {
            if !cur.is_empty() {
                out.push(RangeToken::Atom(std::mem::take(&mut cur)));
            }
            out.push(match ch {
                ',' => RangeToken::Comma,
                ':' => RangeToken::Colon,
                '!' => RangeToken::Bang,
                '(' => RangeToken::LParen,
                ')' => RangeToken::RParen,
                _ => unreachable!(),
            });
        } else {
            cur.push(ch);
        }
    }
    if bracket_depth != 0 {
        anyhow::bail!("missing ']' in range");
    }
    if !cur.is_empty() {
        out.push(RangeToken::Atom(cur));
    }
    Ok(out)
}

impl RangeParser {
    fn parse(mut self) -> Result<RangeAst> {
        let ast = self.parse_union()?;
        if self.pos != self.tokens.len() {
            anyhow::bail!("unexpected trailing expression");
        }
        Ok(ast)
    }

    fn peek(&self) -> Option<&RangeToken> {
        self.tokens.get(self.pos)
    }

    fn take(&mut self) -> Option<RangeToken> {
        let tok = self.tokens.get(self.pos).cloned();
        if tok.is_some() {
            self.pos += 1;
        }
        tok
    }

    fn parse_primary(&mut self) -> Result<RangeAst> {
        match self.take() {
            Some(RangeToken::LParen) => {
                let out = self.parse_union()?;
                match self.take() {
                    Some(RangeToken::RParen) => Ok(out),
                    _ => anyhow::bail!("missing ')' in expression"),
                }
            }
            Some(RangeToken::Atom(v)) => Ok(RangeAst::Atom(v)),
            _ => anyhow::bail!("expected range atom"),
        }
    }

    fn parse_constraint(&mut self) -> Result<RangeAst> {
        let mut left = self.parse_primary()?;
        while matches!(self.peek(), Some(RangeToken::Colon | RangeToken::Bang)) {
            let is_not = matches!(self.take(), Some(RangeToken::Bang));
            let right = self.parse_primary()?;
            left = if is_not {
                RangeAst::Not(Box::new(left), Box::new(right))
            } else {
                RangeAst::And(Box::new(left), Box::new(right))
            };
        }
        Ok(left)
    }

    fn parse_union(&mut self) -> Result<RangeAst> {
        let mut left = self.parse_constraint()?;
        while matches!(self.peek(), Some(RangeToken::Comma)) {
            self.take();
            let right = self.parse_constraint()?;
            left = RangeAst::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }
}

fn ast_to_plan(ast: &RangeAst, variant: &str, percentile_profile: &str) -> Result<PlanNodeReq> {
    match ast {
        RangeAst::Atom(atom) => atom_to_plan_req(atom, variant, percentile_profile),
        RangeAst::Or(left, right) => Ok(PlanNodeReq::Or {
            left: Box::new(ast_to_plan(left, variant, percentile_profile)?),
            right: Box::new(ast_to_plan(right, variant, percentile_profile)?),
        }),
        RangeAst::And(left, right) => Ok(PlanNodeReq::And {
            left: Box::new(ast_to_plan(left, variant, percentile_profile)?),
            right: Box::new(ast_to_plan(right, variant, percentile_profile)?),
        }),
        RangeAst::Not(left, right) => Ok(PlanNodeReq::Not {
            left: Box::new(ast_to_plan(left, variant, percentile_profile)?),
            right: Box::new(ast_to_plan(right, variant, percentile_profile)?),
        }),
    }
}

fn atom_to_plan_req(atom: &str, variant: &str, percentile_profile: &str) -> Result<PlanNodeReq> {
    let atom = expand_atom_shortcuts(atom, variant);
    let atom = strip_range_weight(&atom).0.to_string();
    if atom == "*" {
        return Ok(PlanNodeReq::Specs {
            entries: vec![Vec::new()],
        });
    }
    let lower = atom.to_ascii_lowercase();
    if let Some(tag) = tag_plan_req(&lower) {
        return Ok(PlanNodeReq::Tag { tag });
    }

    if let Some((low, high)) = parse_percent_range_atom(&atom)? {
        return Ok(PlanNodeReq::PctExactRange {
            variant: variant.to_string(),
            profile: normalize_exact_profile(variant, percentile_profile),
            low_pct: low,
            high_pct: high,
        });
    }
    if let Some(pct) = parse_percent_top_atom(&atom)? {
        return Ok(PlanNodeReq::PctExactTop {
            variant: variant.to_string(),
            profile: normalize_exact_profile(variant, percentile_profile),
            pct,
        });
    }

    let expanded = expand_span_atom(&atom);
    let mut entries = Vec::with_capacity(expanded.len());
    for leaf in expanded {
        entries.push(parse_leaf_specs_to_req(&leaf)?);
    }
    Ok(PlanNodeReq::Specs { entries })
}

fn parse_percent_value(s: &str) -> Result<Option<f64>> {
    if s.is_empty() {
        return Ok(None);
    }
    let v: f64 = s
        .parse()
        .with_context(|| format!("invalid percent value '{s}'"))?;
    if !(0.0..=100.0).contains(&v) {
        anyhow::bail!("percent value must be 0..100");
    }
    Ok(Some(v))
}

fn parse_percent_top_atom(atom: &str) -> Result<Option<f64>> {
    let Some(raw) = atom.strip_suffix('%') else {
        return Ok(None);
    };
    if raw.contains('%') || raw.contains('-') {
        return Ok(None);
    }
    parse_percent_value(raw)
}

fn parse_percent_range_atom(atom: &str) -> Result<Option<(f64, f64)>> {
    let Some(raw) = atom.strip_suffix('%') else {
        return Ok(None);
    };
    let Some((left, right_with_pct)) = raw.split_once("%-") else {
        return Ok(None);
    };
    let low = parse_percent_value(left)?.context("invalid percent range")?;
    let high = parse_percent_value(right_with_pct)?.context("invalid percent range")?;
    if low > high {
        anyhow::bail!("percent range low bound exceeds high bound");
    }
    Ok(Some((low, high)))
}

fn tag_plan_req(atom: &str) -> Option<PlanTagReq> {
    let (base, plus) = atom.strip_suffix('+').map_or((atom, false), |v| (v, true));
    match base {
        "@tp" => Some(PlanTagReq {
            kind: PlanTagKind::TopPair,
            plus,
            min_outs: 0,
        }),
        "@overpair" => Some(PlanTagReq {
            kind: PlanTagKind::Overpair,
            plus,
            min_outs: 0,
        }),
        "@2p" => Some(PlanTagReq {
            kind: PlanTagKind::TwoPair,
            plus,
            min_outs: 0,
        }),
        "@set" => Some(PlanTagReq {
            kind: PlanTagKind::Set,
            plus,
            min_outs: 0,
        }),
        "@fd" if !plus => Some(PlanTagReq {
            kind: PlanTagKind::FlushDraw,
            plus: false,
            min_outs: 0,
        }),
        "@f" => Some(PlanTagReq {
            kind: PlanTagKind::Flush,
            plus,
            min_outs: 0,
        }),
        "@s" => Some(PlanTagReq {
            kind: PlanTagKind::Straight,
            plus,
            min_outs: 0,
        }),
        "@sd" if !plus => Some(straight_draw_tag(1)),
        "@sd4" if !plus => Some(straight_draw_tag(4)),
        "@sd8" if !plus => Some(straight_draw_tag(8)),
        "@sd12" if !plus => Some(straight_draw_tag(12)),
        "@straight" => Some(PlanTagReq {
            kind: PlanTagKind::Straight,
            plus,
            min_outs: 0,
        }),
        "@flush" => Some(PlanTagReq {
            kind: PlanTagKind::Flush,
            plus,
            min_outs: 0,
        }),
        _ => None,
    }
}

fn straight_draw_tag(min_outs: u8) -> PlanTagReq {
    PlanTagReq {
        kind: PlanTagKind::StraightDraw,
        plus: false,
        min_outs,
    }
}

fn expand_atom_shortcuts(atom: &str, variant: &str) -> String {
    if variant != "holdem" {
        return atom.to_string();
    }
    let chars: Vec<char> = atom.chars().collect();
    if chars.len() == 3
        && is_rank_char(chars[0])
        && is_rank_char(chars[1])
        && matches!(chars[2], 's' | 'S' | 'o' | 'O')
    {
        if chars[2].eq_ignore_ascii_case(&'s') {
            return format!("{}x{}x", chars[0], chars[1]);
        }
        return format!("{}x{}y", chars[0], chars[1]);
    }
    atom.to_string()
}

fn expand_span_atom(atom: &str) -> Vec<String> {
    let upper = atom.to_ascii_uppercase();
    if upper.len() >= 3 && (upper.ends_with('+') || upper.ends_with('-')) {
        let body = &upper[..upper.len() - 1];
        if body.len() >= 2 && body.chars().all(is_rank_char) {
            let dir: isize = if upper.ends_with('+') { 1 } else { -1 };
            let mut i = rank_index(body.as_bytes()[0] as char).unwrap() as isize;
            let mut j = rank_index(body.as_bytes()[1] as char).unwrap() as isize;
            let suffix = &body[2..];
            let mut out = Vec::new();
            while (0..13).contains(&i) && (0..13).contains(&j) {
                out.push(format!(
                    "{}{}{}",
                    RANK_CHARS[i as usize] as char, RANK_CHARS[j as usize] as char, suffix
                ));
                i += dir;
                j += dir;
            }
            if !out.is_empty() {
                return out;
            }
        }
    }
    if let Some((left, right)) = upper.split_once('-') {
        if (2..=6).contains(&left.len())
            && left.len() == right.len()
            && left.chars().all(is_rank_char)
            && right.chars().all(is_rank_char)
        {
            let pairs: Vec<(isize, isize)> = left
                .chars()
                .zip(right.chars())
                .map(|(l, r)| {
                    (
                        rank_index(l).unwrap() as isize,
                        rank_index(r).unwrap() as isize,
                    )
                })
                .collect();
            let steps = pairs
                .iter()
                .map(|(a, b)| (a - b).unsigned_abs())
                .max()
                .unwrap_or(0)
                + 1;
            let mut out = Vec::new();
            for step in 0..steps {
                let mut hand = String::new();
                let mut ok = true;
                for (a, b) in &pairs {
                    let dir = (b - a).signum();
                    let v = a + step as isize * dir;
                    if !(0..13).contains(&v) {
                        ok = false;
                        break;
                    }
                    hand.push(RANK_CHARS[v as usize] as char);
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

fn parse_leaf_specs_to_req(leaf: &str) -> Result<Vec<SpecReq>> {
    let chars: Vec<char> = leaf.chars().collect();
    let mut specs = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '{' {
            let end = chars[i + 1..]
                .iter()
                .position(|c| *c == '}')
                .map(|pos| i + 1 + pos)
                .context("missing '}'")?;
            specs.extend(parse_leaf_specs_to_req(
                &chars[i + 1..end].iter().collect::<String>(),
            )?);
            i = end + 1;
            continue;
        }
        if ch == '*' {
            let (suit_mode, suit_value, advance) = parse_optional_suit(&chars, i + 1);
            specs.push(SpecReq {
                ranks_mask: ALL_RANKS_MASK,
                rank_var: -1,
                suit_mode,
                suit_value,
            });
            i += 1 + advance;
            continue;
        }
        if ch == '[' {
            let end = chars[i + 1..]
                .iter()
                .position(|c| *c == ']')
                .map(|pos| i + 1 + pos)
                .context("missing ']' in rank list")?;
            let inner: String = chars[i..=end].iter().collect();
            let ranks_mask = rank_mask_from_expr(&inner)
                .with_context(|| format!("invalid rank list: {inner}"))?;
            let (suit_mode, suit_value, advance) = parse_optional_suit(&chars, end + 1);
            specs.push(SpecReq {
                ranks_mask,
                rank_var: -1,
                suit_mode,
                suit_value,
            });
            i = end + 1 + advance;
            continue;
        }
        if is_rank_char(ch) || is_rank_var(ch) {
            let rank_var = rank_var_index(ch).unwrap_or(-1);
            let mut ranks_mask = if is_rank_char(ch) {
                1u16 << rank_index(ch).unwrap()
            } else {
                ALL_RANKS_MASK
            };
            let mut consumed_rank_suffix = 0usize;
            if is_rank_char(ch) && i + 1 < chars.len() && matches!(chars[i + 1], '+' | '-') {
                let idx = rank_index(ch).unwrap();
                ranks_mask = if chars[i + 1] == '+' {
                    (!0u16 << idx) & ALL_RANKS_MASK
                } else {
                    (1u16 << (idx + 1)) - 1
                };
                consumed_rank_suffix = 1;
            }
            let suit_pos = i + 1 + consumed_rank_suffix;
            let (suit_mode, suit_value, advance) = parse_optional_suit(&chars, suit_pos);
            specs.push(SpecReq {
                ranks_mask,
                rank_var,
                suit_mode,
                suit_value,
            });
            i += 1 + consumed_rank_suffix + advance;
            continue;
        }
        if let Some((suit_mode, suit_value)) = suit_spec(ch) {
            specs.push(SpecReq {
                ranks_mask: ALL_RANKS_MASK,
                rank_var: -1,
                suit_mode,
                suit_value,
            });
            i += 1;
            continue;
        }
        anyhow::bail!("unexpected token '{}' in {}", ch, leaf);
    }
    Ok(specs)
}

fn parse_optional_suit(chars: &[char], idx: usize) -> (u8, i8, usize) {
    if idx >= chars.len() {
        return (0, -1, 0);
    }
    if let Some((mode, value)) = suit_spec(chars[idx]) {
        (mode, value, 1)
    } else {
        (0, -1, 0)
    }
}

fn suit_spec(ch: char) -> Option<(u8, i8)> {
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
    let upper = expr.to_ascii_uppercase();
    if upper.len() == 1 {
        return rank_index(upper.chars().next()?).map(|idx| 1u16 << idx);
    }
    if let Some((a, b)) = upper.split_once('-') {
        if a.len() == 1 && b.len() == 1 {
            let ia = rank_index(a.chars().next()?)?;
            let ib = rank_index(b.chars().next()?)?;
            let lo = ia.min(ib);
            let hi = ia.max(ib);
            let mut mask = 0u16;
            for idx in lo..=hi {
                mask |= 1u16 << idx;
            }
            return Some(mask);
        }
    }
    if upper.starts_with('[') && upper.ends_with(']') {
        let mut mask = 0u16;
        for part in upper[1..upper.len() - 1].split(',') {
            let sub = rank_mask_from_expr(part.trim())?;
            mask |= sub;
        }
        return (mask != 0).then_some(mask);
    }
    None
}

fn is_rank_char(ch: char) -> bool {
    matches!(
        ch.to_ascii_uppercase(),
        '2'..='9' | 'T' | 'J' | 'Q' | 'K' | 'A'
    )
}

fn rank_index(ch: char) -> Option<usize> {
    RANK_CHARS
        .iter()
        .position(|r| *r as char == ch.to_ascii_uppercase())
}

fn is_rank_var(ch: char) -> bool {
    matches!(ch.to_ascii_uppercase(), 'R' | 'O' | 'N')
}

fn rank_var_index(ch: char) -> Option<i8> {
    match ch.to_ascii_uppercase() {
        'R' => Some(0),
        'O' => Some(1),
        'N' => Some(2),
        _ => None,
    }
}

fn compile_plan_node(req: &PlanNodeReq) -> Result<PlanNode> {
    match req {
        PlanNodeReq::Or { left, right } => Ok(PlanNode::Or(
            Box::new(compile_plan_node(left)?),
            Box::new(compile_plan_node(right)?),
        )),
        PlanNodeReq::And { left, right } => Ok(PlanNode::And(
            Box::new(compile_plan_node(left)?),
            Box::new(compile_plan_node(right)?),
        )),
        PlanNodeReq::Not { left, right } => Ok(PlanNode::Not(
            Box::new(compile_plan_node(left)?),
            Box::new(compile_plan_node(right)?),
        )),
        PlanNodeReq::Specs { entries } => {
            let mut out = Vec::with_capacity(entries.len());
            for entry in entries {
                let mut specs = Vec::with_capacity(entry.len());
                for s in entry {
                    if s.rank_var < -1 || s.rank_var > 2 {
                        anyhow::bail!("invalid rank_var {}", s.rank_var);
                    }
                    if s.suit_mode > 2 {
                        anyhow::bail!("invalid suit_mode {}", s.suit_mode);
                    }
                    if s.suit_mode > 0 && (s.suit_value < 0 || s.suit_value > 3) {
                        anyhow::bail!("invalid suit_value {}", s.suit_value);
                    }
                    specs.push(Spec {
                        ranks_mask: s.ranks_mask & 0x1fff,
                        rank_var: s.rank_var,
                        suit_mode: s.suit_mode,
                        suit_value: s.suit_value,
                    });
                }
                out.push(specs);
            }
            if out.is_empty() {
                anyhow::bail!("spec plan has no entries");
            }
            Ok(PlanNode::Specs { entries: out })
        }
        PlanNodeReq::PctBits { bits_b64, bits } => {
            let bits = if let Some(raw) = bits {
                raw.clone()
            } else if let Some(b64) = bits_b64 {
                B64_STANDARD
                    .decode(b64.as_bytes())
                    .context("failed to decode pct_bits")?
            } else {
                anyhow::bail!("pct_bits payload is missing");
            };
            if bits.is_empty() {
                anyhow::bail!("pct_bits payload is empty");
            }
            Ok(PlanNode::PctBits { bits })
        }
        PlanNodeReq::PctExactTop {
            variant,
            profile,
            pct,
        } => {
            let table = exact_percentile_table(variant, profile).with_context(|| {
                format!("exact percentile table is unavailable for {profile}/{variant}")
            })?;
            Ok(PlanNode::PctExactTop {
                boundary: percent_boundary_for(&table, *pct),
                table,
            })
        }
        PlanNodeReq::PctExactRange {
            variant,
            profile,
            low_pct,
            high_pct,
        } => {
            let table = exact_percentile_table(variant, profile).with_context(|| {
                format!("exact percentile table is unavailable for {profile}/{variant}")
            })?;
            Ok(PlanNode::PctExactRange {
                low_boundary: percent_boundary_for(&table, *low_pct),
                high_boundary: percent_boundary_for(&table, *high_pct),
                table,
            })
        }
        PlanNodeReq::HeuristicTop { threshold } => Ok(PlanNode::HeuristicTop {
            threshold: *threshold,
        }),
        PlanNodeReq::HeuristicRange {
            low_threshold,
            high_threshold,
        } => Ok(PlanNode::HeuristicRange {
            low_threshold: *low_threshold,
            high_threshold: *high_threshold,
        }),
        PlanNodeReq::Tag { tag } => Ok(PlanNode::Tag(match tag.kind {
            PlanTagKind::TopPair => TagAtom::TopPair { plus: tag.plus },
            PlanTagKind::Overpair => TagAtom::Overpair { plus: tag.plus },
            PlanTagKind::TwoPair => TagAtom::TwoPair { plus: tag.plus },
            PlanTagKind::Set => TagAtom::Set { plus: tag.plus },
            PlanTagKind::FlushDraw => TagAtom::FlushDraw,
            PlanTagKind::Flush => TagAtom::Flush { plus: tag.plus },
            PlanTagKind::StraightDraw => TagAtom::StraightDraw {
                min_outs: tag.min_outs.max(1),
            },
            PlanTagKind::Straight => TagAtom::Straight { plus: tag.plus },
        })),
    }
}

fn enumerate_pool_with_plan(
    start: usize,
    depth: usize,
    base_deck: &[u8],
    hand_size: usize,
    hand: &mut [u8],
    plan: &PlanNode,
    choose: &ChooseTable,
    board: &[u8],
    is_holdem: bool,
    cap: usize,
    rng: &mut SmallRng,
    pool: &mut Vec<Vec<u8>>,
    matched: &mut usize,
) {
    if depth == hand_size {
        if !eval_plan(plan, hand, choose, board, is_holdem) {
            return;
        }
        *matched += 1;
        let copy = hand.to_vec();
        if pool.len() < cap {
            pool.push(copy);
        } else {
            let j = rng.gen_range(0..*matched);
            if j < cap {
                pool[j] = copy;
            }
        }
        return;
    }
    for i in start..=base_deck.len() - (hand_size - depth) {
        hand[depth] = base_deck[i];
        enumerate_pool_with_plan(
            i + 1,
            depth + 1,
            base_deck,
            hand_size,
            hand,
            plan,
            choose,
            board,
            is_holdem,
            cap,
            rng,
            pool,
            matched,
        );
    }
}

fn eval_plan(
    node: &PlanNode,
    hand: &[u8],
    choose: &ChooseTable,
    board: &[u8],
    is_holdem: bool,
) -> bool {
    match node {
        PlanNode::Or(left, right) => {
            eval_plan(left, hand, choose, board, is_holdem)
                || eval_plan(right, hand, choose, board, is_holdem)
        }
        PlanNode::And(left, right) => {
            eval_plan(left, hand, choose, board, is_holdem)
                && eval_plan(right, hand, choose, board, is_holdem)
        }
        PlanNode::Not(left, right) => {
            eval_plan(left, hand, choose, board, is_holdem)
                && !eval_plan(right, hand, choose, board, is_holdem)
        }
        PlanNode::Specs { entries } => entries.iter().any(|specs| match_specs(specs, hand)),
        PlanNode::PctBits { bits } => {
            let idx = combo_rank_52(hand, choose);
            bit_is_set(bits, idx)
        }
        PlanNode::PctExactTop { table, boundary } => {
            in_top_exact_boundary(table, *boundary, hand, choose)
        }
        PlanNode::PctExactRange {
            table,
            low_boundary,
            high_boundary,
        } => {
            in_top_exact_boundary(table, *high_boundary, hand, choose)
                && !in_top_exact_boundary(table, *low_boundary, hand, choose)
        }
        PlanNode::HeuristicTop { threshold } => evaluate_heuristic(hand) >= *threshold,
        PlanNode::HeuristicRange {
            low_threshold,
            high_threshold,
        } => {
            let s = evaluate_heuristic(hand);
            s <= *low_threshold && s >= *high_threshold
        }
        PlanNode::Tag(tag) => full_tag_match(*tag, hand, board, is_holdem),
    }
}

fn exact_percentile_table(variant: &str, profile: &str) -> Option<Arc<ExactPercentileTable>> {
    let variant_norm = variant.trim().to_lowercase();
    let profile_norm = normalize_exact_profile(&variant_norm, profile);
    match (profile_norm.as_str(), variant_norm.as_str()) {
        (_, "holdem") => load_included_percentile_table(
            &EXACT_OURS_HOLDEM,
            include_bytes!(concat!(env!("OUT_DIR"), "/percentile-ours-holdem.bin")),
        ),
        ("ppt6max", "plo4") => load_included_percentile_table(
            &EXACT_PPT6MAX_PLO4,
            include_bytes!(concat!(env!("OUT_DIR"), "/percentile-ppt6max-plo4.bin")),
        ),
        ("ppt6max", "plo5") => load_included_percentile_table(
            &EXACT_PPT6MAX_PLO5,
            include_bytes!(concat!(env!("OUT_DIR"), "/percentile-ppt6max-plo5.bin")),
        ),
        (_, "plo4") => load_included_percentile_table(
            &EXACT_OURS_PLO4,
            include_bytes!(concat!(env!("OUT_DIR"), "/percentile-ours-plo4.bin")),
        ),
        (_, "plo5") => load_included_percentile_table(
            &EXACT_OURS_PLO5,
            include_bytes!(concat!(env!("OUT_DIR"), "/percentile-ours-plo5.bin")),
        ),
        (_, "plo6") => load_included_percentile_table(
            &EXACT_OURS_PLO6,
            include_bytes!(concat!(env!("OUT_DIR"), "/percentile-ours-plo6.bin")),
        ),
        _ => None,
    }
}

pub fn exact_percentile_table_ref(variant: &str, profile: &str) -> Option<ExactPercentileTableRef> {
    exact_percentile_table(variant, profile).map(|table| ExactPercentileTableRef { table })
}

pub fn exact_percent_boundary_for_ref(
    table: &ExactPercentileTableRef,
    pct: f64,
) -> ExactPercentBoundary {
    percent_boundary_for(&table.table, pct)
}

pub fn exact_percent_count_for_ref(table: &ExactPercentileTableRef, pct: f64) -> usize {
    percent_count_for(&table.table, pct)
}

pub fn exact_percent_sample_size(table: &ExactPercentileTableRef) -> usize {
    table.table.sample_size
}

pub fn in_top_exact_percentile_ref(
    table: &ExactPercentileTableRef,
    boundary: ExactPercentBoundary,
    hand: &[u8],
) -> bool {
    let choose = EXACT_CHOOSE.get_or_init(build_choose_table);
    in_top_exact_boundary(&table.table, boundary, hand, choose)
}

fn normalize_exact_profile(variant: &str, profile: &str) -> String {
    let wanted = profile.trim().to_lowercase();
    match variant {
        "plo4" | "plo5" if wanted == "ppt6max" => "ppt6max".to_string(),
        "holdem" | "plo4" | "plo5" | "plo6" => "ours".to_string(),
        _ => "ours".to_string(),
    }
}

fn load_included_percentile_table(
    cache: &'static OnceLock<Option<Arc<ExactPercentileTable>>>,
    bytes: &'static [u8],
) -> Option<Arc<ExactPercentileTable>> {
    cache
        .get_or_init(|| decode_exact_percentile_table(bytes).ok().map(Arc::new))
        .clone()
}

fn decode_exact_percentile_table(bytes: &[u8]) -> Result<ExactPercentileTable> {
    const HEADER_LEN: usize = 28;
    if bytes.len() < HEADER_LEN || &bytes[..8] != b"EVPTBL1\0" {
        anyhow::bail!("invalid exact percentile table header");
    }
    let mut offset = 8usize;
    let basis = read_u32(bytes, &mut offset)? as usize;
    let sample_size = read_u32(bytes, &mut offset)? as usize;
    let top_score_len = read_u32(bytes, &mut offset)? as usize;
    let top_rank_len = read_u32(bytes, &mut offset)? as usize;
    let score_by_rank_len = read_u32(bytes, &mut offset)? as usize;

    let top_score_keys = read_u16_vec(bytes, &mut offset, top_score_len)?;
    let top_ranks = read_u32_vec(bytes, &mut offset, top_rank_len)?;
    let score_keys_by_combo_rank = read_u16_vec(bytes, &mut offset, score_by_rank_len)?;

    let steps = 100usize.saturating_mul(basis.max(1));
    if sample_size == 0
        || top_score_keys.len() < steps + 1
        || top_ranks.len() < steps + 1
        || score_keys_by_combo_rank.len() < sample_size
    {
        anyhow::bail!("invalid exact percentile table lengths");
    }

    Ok(ExactPercentileTable {
        basis,
        sample_size,
        top_score_keys,
        top_ranks,
        score_keys_by_combo_rank,
    })
}

fn read_u16_vec(bytes: &[u8], offset: &mut usize, len: usize) -> Result<Vec<u16>> {
    let end = offset
        .checked_add(len.saturating_mul(2))
        .context("exact percentile table offset overflow")?;
    if end > bytes.len() {
        anyhow::bail!("truncated exact percentile table");
    }
    let mut out = Vec::with_capacity(len);
    while *offset < end {
        out.push(read_u16(bytes, offset)?);
    }
    Ok(out)
}

fn read_u32_vec(bytes: &[u8], offset: &mut usize, len: usize) -> Result<Vec<u32>> {
    let end = offset
        .checked_add(len.saturating_mul(4))
        .context("exact percentile table offset overflow")?;
    if end > bytes.len() {
        anyhow::bail!("truncated exact percentile table");
    }
    let mut out = Vec::with_capacity(len);
    while *offset < end {
        out.push(read_u32(bytes, offset)?);
    }
    Ok(out)
}

fn read_u16(bytes: &[u8], offset: &mut usize) -> Result<u16> {
    if *offset + 2 > bytes.len() {
        anyhow::bail!("truncated exact percentile table");
    }
    let value = u16::from_le_bytes([bytes[*offset], bytes[*offset + 1]]);
    *offset += 2;
    Ok(value)
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Result<u32> {
    if *offset + 4 > bytes.len() {
        anyhow::bail!("truncated exact percentile table");
    }
    let value = u32::from_le_bytes([
        bytes[*offset],
        bytes[*offset + 1],
        bytes[*offset + 2],
        bytes[*offset + 3],
    ]);
    *offset += 4;
    Ok(value)
}

fn percent_boundary_for(table: &ExactPercentileTable, pct: f64) -> ExactPercentBoundary {
    let count = percent_count_for(table, pct);
    if count == 0 {
        return ExactPercentBoundary::None;
    }
    if count >= table.sample_size {
        return ExactPercentBoundary::All;
    }

    let idx = percent_step_index_for(table, pct);
    if table.top_score_keys.len() <= idx || table.top_ranks.len() <= idx {
        return ExactPercentBoundary::None;
    }
    ExactPercentBoundary::Partial {
        boundary_score: table.top_score_keys[idx],
        boundary_rank: table.top_ranks[idx] as usize,
    }
}

fn percent_step_index_for(table: &ExactPercentileTable, pct: f64) -> usize {
    let clamped = pct.clamp(0.0, 100.0);
    let basis = table.basis.max(1);
    let steps = 100usize.saturating_mul(basis);
    ((clamped * basis as f64).round() as usize).min(steps)
}

fn percent_count_for(table: &ExactPercentileTable, pct: f64) -> usize {
    if table.sample_size == 0 {
        return 0;
    }
    let basis = table.basis.max(1);
    let steps = 100usize.saturating_mul(basis);
    let idx = percent_step_index_for(table, pct);
    ((idx as f64 / steps as f64) * table.sample_size as f64).floor() as usize
}

fn in_top_exact_boundary(
    table: &ExactPercentileTable,
    boundary: ExactPercentBoundary,
    hand: &[u8],
    choose: &ChooseTable,
) -> bool {
    if hand.is_empty() {
        return false;
    }
    match boundary {
        ExactPercentBoundary::None => return false,
        ExactPercentBoundary::All => return true,
        ExactPercentBoundary::Partial { .. } => {}
    }
    let hand_rank = combo_rank_52(hand, choose);
    if hand_rank >= table.sample_size || hand_rank >= table.score_keys_by_combo_rank.len() {
        return false;
    }
    let score_key = table.score_keys_by_combo_rank[hand_rank];
    match boundary {
        ExactPercentBoundary::Partial {
            boundary_score,
            boundary_rank,
        } => {
            score_key > boundary_score
                || (score_key == boundary_score && hand_rank <= boundary_rank)
        }
        ExactPercentBoundary::None => false,
        ExactPercentBoundary::All => true,
    }
}

fn exact_preflop_count_for_plan(
    plan: &PlanNodeReq,
    request_variant: &str,
    hand_size: usize,
) -> Option<usize> {
    match plan {
        PlanNodeReq::PctExactTop {
            variant,
            profile,
            pct,
        } if variant == request_variant => {
            let table = exact_percentile_table(variant, profile)?;
            if table.sample_size != n_choose_k(52, hand_size) {
                return None;
            }
            Some(percent_count_for(&table, *pct))
        }
        PlanNodeReq::PctExactRange {
            variant,
            profile,
            low_pct,
            high_pct,
        } if variant == request_variant => {
            let table = exact_percentile_table(variant, profile)?;
            if table.sample_size != n_choose_k(52, hand_size) {
                return None;
            }
            let high = percent_count_for(&table, *high_pct);
            let low = percent_count_for(&table, *low_pct);
            Some(high.saturating_sub(low))
        }
        _ => None,
    }
}

fn count_plan_matches(
    base_deck: &[u8],
    hand_size: usize,
    plan: &PlanNode,
    choose: &ChooseTable,
    board: &[u8],
    is_holdem: bool,
) -> usize {
    if hand_size == 0 || base_deck.len() < hand_size {
        return 0;
    }
    let first_limit = base_deck.len() - hand_size;
    if n_choose_k(base_deck.len(), hand_size) >= 100_000 && rayon::current_num_threads() > 1 {
        (0..=first_limit)
            .into_par_iter()
            .map(|i| {
                let mut hand = vec![0u8; hand_size];
                hand[0] = base_deck[i];
                count_plan_matches_rec(
                    i + 1,
                    1,
                    base_deck,
                    hand_size,
                    &mut hand,
                    plan,
                    choose,
                    board,
                    is_holdem,
                )
            })
            .sum()
    } else {
        let mut hand = vec![0u8; hand_size];
        count_plan_matches_rec(
            0, 0, base_deck, hand_size, &mut hand, plan, choose, board, is_holdem,
        )
    }
}

fn count_plan_matches_rec(
    start: usize,
    depth: usize,
    base_deck: &[u8],
    hand_size: usize,
    hand: &mut [u8],
    plan: &PlanNode,
    choose: &ChooseTable,
    board: &[u8],
    is_holdem: bool,
) -> usize {
    if depth == hand_size {
        return usize::from(eval_plan(plan, hand, choose, board, is_holdem));
    }
    let mut matched = 0usize;
    for i in start..=base_deck.len() - (hand_size - depth) {
        hand[depth] = base_deck[i];
        matched += count_plan_matches_rec(
            i + 1,
            depth + 1,
            base_deck,
            hand_size,
            hand,
            plan,
            choose,
            board,
            is_holdem,
        );
    }
    matched
}

fn bit_is_set(bits: &[u8], idx: usize) -> bool {
    let byte = idx >> 3;
    if byte >= bits.len() {
        return false;
    }
    ((bits[byte] >> (idx & 7)) & 1) != 0
}

fn card_rank_idx(c: u8) -> usize {
    (c as usize) / 4
}

fn card_suit_idx(c: u8) -> i8 {
    (c % 4) as i8
}

fn rank_mask_has(mask: u16, rank_idx: usize) -> bool {
    if rank_idx >= 13 {
        return false;
    }
    (mask & (1u16 << rank_idx)) != 0
}

fn match_specs(specs_input: &[Spec], hand: &[u8]) -> bool {
    if specs_input.len() > hand.len() {
        return false;
    }

    const ALL_RANKS_MASK: u16 = 0x1fff;
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
        let rank_idx = card_rank_idx(c);
        if !rank_mask_has(spec.ranks_mask, rank_idx) {
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

        let suit = card_suit_idx(c);
        let mut bound_suit_key: Option<usize> = None;
        let suit_ok = match spec.suit_mode {
            0 => true,
            1 => suit == spec.suit_value,
            2 => {
                let key = spec.suit_value as usize;
                let cur = suit_bindings[key];
                if cur >= 0 {
                    cur == suit
                } else {
                    if suit_bindings.iter().any(|&v| v == suit) {
                        false
                    } else {
                        suit_bindings[key] = suit;
                        bound_suit_key = Some(key);
                        true
                    }
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

fn validate_equity_rank_request(req: &Request) -> Result<()> {
    let hand_size = variant_hand_size(&req.variant);
    if hand_size == 0 {
        anyhow::bail!("unsupported variant '{}'", req.variant);
    }
    if req.iteration_cap == 0 {
        anyhow::bail!("iteration_cap must be > 0");
    }
    Ok(())
}

fn new_equity_rank_partial(combo_space: usize) -> EquityRankPartial {
    EquityRankPartial {
        counts: vec![0u32; combo_space],
        shares: vec![0.0f32; combo_space],
    }
}

fn merge_equity_rank_in_place(out: &mut EquityRankPartial, p: EquityRankPartial) {
    for i in 0..out.counts.len() {
        out.counts[i] = out.counts[i].saturating_add(p.counts[i]);
        out.shares[i] += p.shares[i];
    }
}

fn simulate_equity_rank_partition(
    variant: &str,
    hand_size: usize,
    iter_cap: usize,
    seed: u64,
    choose: &ChooseTable,
    combo_space: usize,
) -> EquityRankPartial {
    let mut out = new_equity_rank_partial(combo_space);
    let mut rng = SmallRng::seed_from_u64(seed);
    let is_holdem = variant == "holdem";

    let mut used = [false; 52];
    let mut hero = vec![0u8; hand_size];
    let mut villain = vec![0u8; hand_size];
    let mut board5 = [0u8; 5];

    for _ in 0..iter_cap {
        used.fill(false);

        if !sample_random_hand(hand_size, &used, &mut rng, &mut hero) {
            continue;
        }
        for &c in &hero {
            used[c as usize] = true;
        }

        if !sample_random_hand(hand_size, &used, &mut rng, &mut villain) {
            continue;
        }
        for &c in &villain {
            used[c as usize] = true;
        }

        if !complete_board_runout(&mut board5, 0, &used, &mut rng) {
            continue;
        }

        let (hero_score, villain_score) = if is_holdem {
            let (hs, _) = eval_holdem(&hero, &board5);
            let (vs, _) = eval_holdem(&villain, &board5);
            (hs, vs)
        } else {
            let mut board_hand = Hand::new();
            for &c in &board5 {
                board_hand.insert_unchecked(&CARDS[c as usize]);
            }
            let (hs, _) = eval_omaha_with_board(&hero, &board_hand);
            let (vs, _) = eval_omaha_with_board(&villain, &board_hand);
            (hs, vs)
        };

        let (hero_share, villain_share) = if hero_score > villain_score {
            (1.0f32, 0.0f32)
        } else if hero_score < villain_score {
            (0.0f32, 1.0f32)
        } else {
            (0.5f32, 0.5f32)
        };

        let hero_idx = combo_rank_52(&hero, choose);
        let villain_idx = combo_rank_52(&villain, choose);
        out.counts[hero_idx] = out.counts[hero_idx].saturating_add(1);
        out.shares[hero_idx] += hero_share;
        out.counts[villain_idx] = out.counts[villain_idx].saturating_add(1);
        out.shares[villain_idx] += villain_share;
    }
    out
}

struct EquityRankStats {
    observations: usize,
    zero_sample_combos: usize,
    min_samples: u32,
    max_samples: u32,
    mean_samples_per_combo: f64,
    score_keys_by_combo_rank: Vec<u16>,
    top_score_keys: Vec<u16>,
    top_ranks: Vec<u32>,
}

fn build_equity_rank_stats(total: &EquityRankPartial, combo_space: usize) -> EquityRankStats {
    let mut score_keys = vec![0u16; combo_space];
    let mut score_counts = vec![0usize; EQUITY_SCORE_SCALE + 1];

    let mut observations = 0usize;
    let mut zero_sample_combos = 0usize;
    let mut min_samples = u32::MAX;
    let mut max_samples = 0u32;

    for i in 0..combo_space {
        let c = total.counts[i];
        observations += c as usize;
        if c == 0 {
            zero_sample_combos += 1;
        } else {
            if c < min_samples {
                min_samples = c;
            }
            if c > max_samples {
                max_samples = c;
            }
        }
        let eq = if c > 0 {
            total.shares[i] as f64 / c as f64
        } else {
            0.5
        };
        let scaled = (eq * EQUITY_SCORE_SCALE as f64).round();
        let clamped = scaled.max(0.0).min(EQUITY_SCORE_SCALE as f64) as u16;
        score_keys[i] = clamped;
        score_counts[clamped as usize] += 1;
    }

    if min_samples == u32::MAX {
        min_samples = 0;
    }

    let mut starts = vec![0usize; EQUITY_SCORE_SCALE + 1];
    let mut cursor = 0usize;
    for key in (0..=EQUITY_SCORE_SCALE).rev() {
        starts[key] = cursor;
        cursor += score_counts[key];
    }

    let mut write_pos = starts.clone();
    let mut sorted_ranks = vec![0u32; combo_space];
    for rank in 0..combo_space {
        let key = score_keys[rank] as usize;
        let pos = write_pos[key];
        sorted_ranks[pos] = rank as u32;
        write_pos[key] += 1;
    }

    let steps = 100 * EQUITY_PERCENT_BASIS;
    let mut top_score_keys = vec![0u16; steps + 1];
    let mut top_ranks = vec![0u32; steps + 1];
    for i in 0..=steps {
        let count = (i * combo_space) / steps;
        if count == 0 {
            top_score_keys[i] = 0;
            top_ranks[i] = u32::MAX;
            continue;
        }
        let boundary = count - 1;
        let rank = sorted_ranks[boundary] as usize;
        top_score_keys[i] = score_keys[rank];
        top_ranks[i] = rank as u32;
    }

    EquityRankStats {
        observations,
        zero_sample_combos,
        min_samples,
        max_samples,
        mean_samples_per_combo: observations as f64 / combo_space as f64,
        score_keys_by_combo_rank: score_keys,
        top_score_keys,
        top_ranks,
    }
}

fn n_choose_k(n: usize, k: usize) -> usize {
    if k > n {
        return 0;
    }
    let kk = k.min(n - k);
    let mut out = 1usize;
    for i in 1..=kk {
        out = (out * (n - kk + i)) / i;
    }
    out
}

fn validate_request(req: &Request) -> Result<()> {
    if req.players.len() < 2 || req.players.len() > 6 {
        anyhow::bail!("players must be 2..6");
    }
    validate_board_and_dead(&req.board, &req.dead)?;
    match req.variant.as_str() {
        "holdem" | "plo4" | "plo5" | "plo6" => {}
        _ => anyhow::bail!("unsupported variant '{}'", req.variant),
    }
    if req.iteration_cap == 0 {
        anyhow::bail!("iteration_cap must be > 0");
    }
    Ok(())
}

fn validate_board_and_dead(board: &[u8], dead: &[u8]) -> Result<()> {
    if board.len() > 5 {
        anyhow::bail!("board must have at most 5 cards");
    }
    for &c in board {
        if c > 51 {
            anyhow::bail!("invalid board card id {}", c);
        }
    }
    for &c in dead {
        if c > 51 {
            anyhow::bail!("invalid dead card id {}", c);
        }
    }
    let mut seen = [false; 52];
    for &c in board.iter().chain(dead.iter()) {
        let idx = c as usize;
        if seen[idx] {
            anyhow::bail!("duplicate board/dead card {}", c);
        }
        seen[idx] = true;
    }
    Ok(())
}

fn variant_hand_size(variant: &str) -> usize {
    match variant {
        "holdem" => 2,
        "plo4" => 4,
        "plo5" => 5,
        "plo6" => 6,
        _ => 0,
    }
}

fn choose_workers(requested: Option<usize>, _iteration_cap: usize) -> usize {
    let mut workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    if let Some(r) = requested {
        if r > 0 {
            workers = workers.min(r);
        }
    }
    workers.max(1)
}

fn split_iterations(total: usize, workers: usize) -> Vec<usize> {
    let mut out = vec![total / workers; workers];
    for slot in out.iter_mut().take(total % workers) {
        *slot += 1;
    }
    out
}

fn choose_round_iters(iteration_cap: usize, workers: usize, confidence_enabled: bool) -> usize {
    if !confidence_enabled {
        return iteration_cap;
    }
    let base = workers.saturating_mul(25_000).max(workers);
    base.min(iteration_cap)
}

fn confidence_cfg(req: &Request) -> ConfidenceCfg {
    let target = req.confidence_target_pct.unwrap_or(0.0);
    let enabled = target > 0.0;
    let level = req.confidence_level.unwrap_or(0.95).clamp(0.80, 0.999);
    let z = z_for_level(level);
    let min_iters = req.confidence_min_iters.unwrap_or(25_000).max(1);

    ConfidenceCfg {
        enabled,
        target_pct: target,
        min_iters,
        level,
        z,
    }
}

fn z_for_level(level: f64) -> f64 {
    if level >= 0.995 {
        2.807_034
    } else if level >= 0.99 {
        2.575_829
    } else if level >= 0.98 {
        2.326_348
    } else if level >= 0.95 {
        1.959_964
    } else if level >= 0.90 {
        1.644_854
    } else {
        1.281_552
    }
}

fn build_samplers(req: &Request) -> Result<Vec<Sampler>> {
    let expected = variant_hand_size(&req.variant);
    if expected == 0 {
        anyhow::bail!("unsupported variant {}", req.variant);
    }
    let choose = build_choose_table();
    let is_holdem = req.variant == "holdem";
    req.players
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if p.hand_size != expected {
                anyhow::bail!(
                    "player {} hand_size {} does not match variant {} ({})",
                    i + 1,
                    p.hand_size,
                    req.variant,
                    expected
                );
            }
            let mut weight_pct = p.weight_pct.unwrap_or(100);
            if p.mode == "range" && p.weight_pct.is_none() {
                if let Some(raw) = p.range_text.as_deref() {
                    if let Some(w) = strip_range_weight(raw).1 {
                        weight_pct = w;
                    }
                }
            }
            if weight_pct == 0 || weight_pct > 100 {
                anyhow::bail!(
                    "player {} weight_pct {} is invalid (must be 1..=100)",
                    i + 1,
                    weight_pct
                );
            }
            if p.mode == "all" {
                Ok(Sampler::All {
                    hand_size: p.hand_size,
                    weight_pct,
                })
            } else if p.mode == "range" {
                let raw = p
                    .range_text
                    .as_deref()
                    .with_context(|| format!("player {} range_text is missing", i + 1))?;
                let range_text = strip_range_weight(raw).0;
                let plan_req = compile_range_text_to_plan(
                    range_text,
                    &req.variant,
                    req.percentile_profile.as_deref().unwrap_or_default(),
                )
                .with_context(|| format!("player {} range is invalid", i + 1))?;
                let Some(plan_req) = plan_req else {
                    return Ok(Sampler::All {
                        hand_size: p.hand_size,
                        weight_pct,
                    });
                };
                let plan = compile_plan_node(&plan_req)
                    .with_context(|| format!("player {} range is invalid", i + 1))?;
                let has_pct = plan_has_pct_bits(&plan);
                let try_small_pool = !has_pct;
                if try_small_pool {
                    let limit = small_plan_pool_limit(p.hand_size);
                    match collect_small_plan_pool(
                        req,
                        p.hand_size,
                        &plan,
                        &choose,
                        is_holdem,
                        limit,
                    )? {
                        SmallPlanPool::Empty => anyhow::bail!(
                            "player {} range appears empty on this board/dead setup",
                            i + 1
                        ),
                        SmallPlanPool::Small(mut pool) => {
                            pool.sort_unstable();
                            pool.dedup();
                            pool.shrink_to_fit();
                            let pool = pool
                                .into_iter()
                                .map(|cards| PoolEntry::new(&cards))
                                .collect();
                            Ok(Sampler::Pool {
                                hand_size: p.hand_size,
                                pool,
                                weight_pct,
                            })
                        }
                        SmallPlanPool::Large => Ok(Sampler::Plan {
                            hand_size: p.hand_size,
                            plan,
                            weight_pct,
                        }),
                    }
                } else {
                    Ok(Sampler::Plan {
                        hand_size: p.hand_size,
                        plan,
                        weight_pct,
                    })
                }
            } else if p.mode == "pool" {
                let mut pool = p.pool.clone().unwrap_or_default();
                if pool.is_empty() {
                    anyhow::bail!("player {} pool is empty", i + 1);
                }
                for hand in &mut pool {
                    if hand.len() != p.hand_size {
                        anyhow::bail!("player {} pool hand has wrong size", i + 1);
                    }
                    hand.sort_unstable();
                    let mut prev = None;
                    for &c in hand.iter() {
                        if c > 51 {
                            anyhow::bail!("player {} pool hand has invalid card", i + 1);
                        }
                        if prev == Some(c) {
                            anyhow::bail!("player {} pool hand has duplicate card", i + 1);
                        }
                        prev = Some(c);
                    }
                }
                pool.sort_unstable();
                pool.dedup();
                pool.shrink_to_fit();
                let pool = pool
                    .into_iter()
                    .map(|cards| PoolEntry::new(&cards))
                    .collect();
                Ok(Sampler::Pool {
                    hand_size: p.hand_size,
                    pool,
                    weight_pct,
                })
            } else if p.mode == "plan" {
                let plan_req = p
                    .plan
                    .as_ref()
                    .with_context(|| format!("player {} plan is missing", i + 1))?;
                let plan = compile_plan_node(plan_req)
                    .with_context(|| format!("player {} plan is invalid", i + 1))?;
                let has_pct = plan_has_pct_bits(&plan);
                let try_small_pool = !has_pct;
                if try_small_pool {
                    let limit = small_plan_pool_limit(p.hand_size);
                    match collect_small_plan_pool(
                        req,
                        p.hand_size,
                        &plan,
                        &choose,
                        is_holdem,
                        limit,
                    )? {
                        SmallPlanPool::Empty => anyhow::bail!(
                            "player {} range appears empty on this board/dead setup",
                            i + 1
                        ),
                        SmallPlanPool::Small(mut pool) => {
                            pool.sort_unstable();
                            pool.dedup();
                            pool.shrink_to_fit();
                            let pool = pool
                                .into_iter()
                                .map(|cards| PoolEntry::new(&cards))
                                .collect();
                            Ok(Sampler::Pool {
                                hand_size: p.hand_size,
                                pool,
                                weight_pct,
                            })
                        }
                        SmallPlanPool::Large => Ok(Sampler::Plan {
                            hand_size: p.hand_size,
                            plan,
                            weight_pct,
                        }),
                    }
                } else {
                    Ok(Sampler::Plan {
                        hand_size: p.hand_size,
                        plan,
                        weight_pct,
                    })
                }
            } else {
                anyhow::bail!("unsupported player mode '{}'", p.mode);
            }
        })
        .collect()
}

fn plan_has_pct_bits(plan: &PlanNode) -> bool {
    match plan {
        PlanNode::PctBits { .. }
        | PlanNode::PctExactTop { .. }
        | PlanNode::PctExactRange { .. } => true,
        PlanNode::Specs { .. }
        | PlanNode::HeuristicTop { .. }
        | PlanNode::HeuristicRange { .. }
        | PlanNode::Tag(_) => false,
        PlanNode::Or(left, right) | PlanNode::And(left, right) | PlanNode::Not(left, right) => {
            plan_has_pct_bits(left) || plan_has_pct_bits(right)
        }
    }
}

enum SmallPlanPool {
    Empty,
    Small(Vec<Vec<u8>>),
    Large,
}

fn small_plan_pool_limit(hand_size: usize) -> usize {
    match hand_size {
        2 => 10_000,
        4 => 60_000,
        5 => 80_000,
        6 => 60_000,
        _ => 40_000,
    }
}

fn collect_small_plan_pool(
    req: &Request,
    hand_size: usize,
    plan: &PlanNode,
    choose: &ChooseTable,
    is_holdem: bool,
    limit: usize,
) -> Result<SmallPlanPool> {
    let mut blocked = [false; 52];
    for &c in req.board.iter().chain(req.dead.iter()) {
        blocked[c as usize] = true;
    }
    let mut base = Vec::<u8>::with_capacity(52 - req.board.len() - req.dead.len());
    for c in 0u8..52u8 {
        if !blocked[c as usize] {
            base.push(c);
        }
    }
    if base.len() < hand_size {
        return Ok(SmallPlanPool::Empty);
    }

    let mut hand = vec![0u8; hand_size];
    let mut pool = Vec::<Vec<u8>>::new();
    let mut overflow = false;
    collect_small_plan_pool_rec(
        0,
        0,
        &base,
        hand_size,
        &mut hand,
        plan,
        choose,
        &req.board,
        is_holdem,
        limit.max(1),
        &mut pool,
        &mut overflow,
    );
    if pool.is_empty() {
        return Ok(SmallPlanPool::Empty);
    }
    if overflow {
        return Ok(SmallPlanPool::Large);
    }
    Ok(SmallPlanPool::Small(pool))
}

#[allow(clippy::too_many_arguments)]
fn collect_small_plan_pool_rec(
    start: usize,
    depth: usize,
    base: &[u8],
    hand_size: usize,
    hand: &mut [u8],
    plan: &PlanNode,
    choose: &ChooseTable,
    board: &[u8],
    is_holdem: bool,
    limit: usize,
    pool: &mut Vec<Vec<u8>>,
    overflow: &mut bool,
) {
    if *overflow {
        return;
    }
    if depth == hand_size {
        if eval_plan(plan, hand, choose, board, is_holdem) {
            if pool.len() >= limit {
                *overflow = true;
                return;
            }
            pool.push(hand.to_vec());
        }
        return;
    }

    let need = hand_size - depth;
    if base.len() < need || start > base.len() - need {
        return;
    }

    for i in start..=base.len() - need {
        hand[depth] = base[i];
        collect_small_plan_pool_rec(
            i + 1,
            depth + 1,
            base,
            hand_size,
            hand,
            plan,
            choose,
            board,
            is_holdem,
            limit,
            pool,
            overflow,
        );
        if *overflow {
            return;
        }
    }
}

fn new_partial(pcount: usize, combo_space: usize) -> Partial {
    Partial {
        iterations: 0,
        wins: vec![0; pcount],
        ties: vec![0; pcount],
        losses: vec![0; pcount],
        equity_shares: vec![0.0; pcount],
        equity_squares: vec![0.0; pcount],
        combo_sets: (0..pcount).map(|_| ComboSet::new(combo_space)).collect(),
        class_counts: (0..pcount).map(|_| vec![0; 9]).collect(),
    }
}

fn simulate_partition(
    req: &Request,
    samplers: &[Sampler],
    iter_cap: usize,
    seed: u64,
    choose: &ChooseTable,
    combo_space: usize,
    deadline: Option<Instant>,
) -> Partial {
    let pcount = req.players.len();
    let mut out = new_partial(pcount, combo_space);

    let mut rng = SmallRng::seed_from_u64(seed);
    let mut blocked = [false; 52];
    let mut blocked_mask = 0u64;
    for &c in req.board.iter().chain(req.dead.iter()) {
        blocked[c as usize] = true;
        blocked_mask |= 1u64 << c;
    }

    let is_holdem = req.variant == "holdem";

    let mut used = [false; 52];
    let mut board5 = [0u8; 5];
    let known_len = req.board.len();
    for (i, &c) in req.board.iter().enumerate() {
        board5[i] = c;
    }
    let mut hand_buf: Vec<Vec<u8>> = samplers
        .iter()
        .map(|s| vec![0u8; sampler_hand_size(s)])
        .collect();
    let mut score_buf = vec![0u16; pcount];
    let mut winners = vec![false; pcount];
    for iter in 0..iter_cap {
        if (iter & 0xFF) == 0 && deadline_reached(deadline) {
            break;
        }
        let mut failed = false;
        for pi in 0..pcount {
            let sampler = &samplers[pi];
            let hand = &mut hand_buf[pi];
            let ok = match sampler {
                Sampler::All {
                    hand_size,
                    weight_pct,
                } => sample_random_hand_weighted(*hand_size, *weight_pct, &blocked, &mut rng, hand),
                Sampler::Pool {
                    pool,
                    hand_size,
                    weight_pct,
                } => sample_from_pool_weighted(
                    pool,
                    *hand_size,
                    *weight_pct,
                    blocked_mask,
                    &mut rng,
                    hand,
                ),
                Sampler::Plan {
                    hand_size,
                    plan,
                    weight_pct,
                } => sample_from_plan(
                    *hand_size,
                    plan,
                    *weight_pct,
                    &blocked,
                    &mut rng,
                    hand,
                    choose,
                    &req.board,
                    is_holdem,
                ),
            };
            if !ok {
                failed = true;
                break;
            }
        }
        if failed {
            continue;
        }

        let mut used_mask = blocked_mask;
        let mut overlap = false;
        for hand in &hand_buf {
            let hand_mask = cards_mask(hand);
            if (hand_mask & used_mask) != 0 {
                overlap = true;
                break;
            }
            used_mask |= hand_mask;
        }
        if overlap {
            continue;
        }

        used.copy_from_slice(&blocked);
        for (pi, hand) in hand_buf.iter().enumerate() {
            for &c in hand {
                used[c as usize] = true;
            }
            out.combo_sets[pi].insert_index(combo_rank_52(hand, choose));
        }

        if !complete_board_runout(&mut board5, known_len, &used, &mut rng) {
            continue;
        }

        let mut board_hand = Hand::new();
        if !is_holdem {
            for &c in &board5 {
                board_hand.insert_unchecked(&CARDS[c as usize]);
            }
        }

        for pi in 0..pcount {
            let hand = &hand_buf[pi];
            let (score, class_id) = if is_holdem {
                eval_holdem(hand, &board5)
            } else {
                eval_omaha_with_board(hand, &board_hand)
            };
            score_buf[pi] = score;
            out.class_counts[pi][class_id] += 1;
        }

        let max_score = *score_buf.iter().max().unwrap_or(&0);
        let mut winner_count = 0usize;
        for i in 0..pcount {
            let won = score_buf[i] == max_score;
            winners[i] = won;
            if won {
                winner_count += 1;
            }
        }
        if winner_count == 0 {
            continue;
        }

        for i in 0..pcount {
            let share = if winners[i] {
                if winner_count == 1 {
                    out.wins[i] += 1;
                } else {
                    out.ties[i] += 1;
                }
                1.0 / winner_count as f64
            } else {
                out.losses[i] += 1;
                0.0
            };
            out.equity_shares[i] += share;
            out.equity_squares[i] += share * share;
        }
        out.iterations += 1;
    }

    out
}

fn simulation_deadline(start: Instant, max_runtime_ms: Option<u64>) -> Option<Instant> {
    let ms = max_runtime_ms?;
    if ms == 0 {
        return None;
    }
    start.checked_add(Duration::from_millis(ms))
}

fn deadline_reached(deadline: Option<Instant>) -> bool {
    deadline.map(|d| Instant::now() >= d).unwrap_or(false)
}

fn merge_in_place(out: &mut Partial, p: Partial) {
    out.iterations += p.iterations;
    for i in 0..out.wins.len() {
        out.wins[i] += p.wins[i];
        out.ties[i] += p.ties[i];
        out.losses[i] += p.losses[i];
        out.equity_shares[i] += p.equity_shares[i];
        out.equity_squares[i] += p.equity_squares[i];
        for c in 0..9 {
            out.class_counts[i][c] += p.class_counts[i][c];
        }
        out.combo_sets[i].merge_from(&p.combo_sets[i]);
    }
}

fn confidence_reached(total: &Partial, cfg: ConfidenceCfg) -> (bool, f64) {
    if !cfg.enabled {
        return (false, f64::INFINITY);
    }
    if total.iterations < cfg.min_iters || total.iterations < 2 {
        return (false, f64::INFINITY);
    }

    let n = total.iterations as f64;
    let mut max_half = 0.0f64;

    for i in 0..total.equity_shares.len() {
        let sum = total.equity_shares[i];
        let sq = total.equity_squares[i];
        let mean = sum / n;
        let var_num = sq - (n * mean * mean);
        let sample_var = (var_num / (n - 1.0)).max(0.0);
        let se = (sample_var / n).sqrt();
        let half = cfg.z * se * 100.0;
        if half > max_half {
            max_half = half;
        }
    }

    (max_half <= cfg.target_pct, max_half)
}

fn sampler_hand_size(s: &Sampler) -> usize {
    match s {
        Sampler::All { hand_size, .. } => *hand_size,
        Sampler::Pool { hand_size, .. } => *hand_size,
        Sampler::Plan { hand_size, .. } => *hand_size,
    }
}

const PLAN_RANDOM_TRIES: usize = 384;

fn accept_weight(weight_pct: u8, rng: &mut SmallRng) -> bool {
    weight_pct >= 100 || rng.gen_range(0u8..100u8) < weight_pct
}

fn weight_try_budget(weight_pct: u8) -> usize {
    if weight_pct >= 100 {
        1
    } else {
        (400usize / weight_pct.max(1) as usize).clamp(8, 2_000)
    }
}

fn sample_random_hand_weighted(
    hand_size: usize,
    weight_pct: u8,
    used: &[bool; 52],
    rng: &mut SmallRng,
    out: &mut Vec<u8>,
) -> bool {
    for _ in 0..weight_try_budget(weight_pct) {
        if !sample_random_hand(hand_size, used, rng, out) {
            return false;
        }
        if accept_weight(weight_pct, rng) {
            return true;
        }
    }
    false
}

fn sample_from_pool_weighted(
    pool: &[PoolEntry],
    hand_size: usize,
    weight_pct: u8,
    used_mask: u64,
    rng: &mut SmallRng,
    out: &mut Vec<u8>,
) -> bool {
    for _ in 0..weight_try_budget(weight_pct) {
        if !sample_from_pool(pool, hand_size, used_mask, rng, out) {
            return false;
        }
        if accept_weight(weight_pct, rng) {
            return true;
        }
    }
    false
}

fn sample_from_plan(
    hand_size: usize,
    plan: &PlanNode,
    weight_pct: u8,
    used: &[bool; 52],
    rng: &mut SmallRng,
    out: &mut Vec<u8>,
    choose: &ChooseTable,
    board: &[u8],
    is_holdem: bool,
) -> bool {
    let mut avail = Vec::with_capacity(52);
    for c in 0u8..52u8 {
        if !used[c as usize] {
            avail.push(c);
        }
    }
    if avail.len() < hand_size {
        return false;
    }

    for _ in 0..PLAN_RANDOM_TRIES {
        if !sample_random_hand_from_avail(&avail, hand_size, rng, out) {
            return false;
        }
        if eval_plan(plan, out, choose, board, is_holdem) && accept_weight(weight_pct, rng) {
            return true;
        }
    }
    sample_from_plan_exhaustive_from_avail(
        &avail, hand_size, plan, weight_pct, rng, out, choose, board, is_holdem,
    )
}

fn sample_from_plan_exhaustive_from_avail(
    avail: &[u8],
    hand_size: usize,
    plan: &PlanNode,
    weight_pct: u8,
    rng: &mut SmallRng,
    out: &mut Vec<u8>,
    choose: &ChooseTable,
    board: &[u8],
    is_holdem: bool,
) -> bool {
    if avail.len() < hand_size {
        return false;
    }

    let mut hand = vec![0u8; hand_size];
    let mut matched = 0usize;
    let mut chosen = Vec::<u8>::new();
    reservoir_plan_combos_rec(
        0,
        0,
        avail,
        hand_size,
        &mut hand,
        plan,
        choose,
        board,
        is_holdem,
        rng,
        &mut matched,
        &mut chosen,
    );

    if matched == 0 || chosen.is_empty() || !accept_weight(weight_pct, rng) {
        return false;
    }
    out.clear();
    out.extend_from_slice(&chosen);
    true
}

#[allow(clippy::too_many_arguments)]
fn reservoir_plan_combos_rec(
    start: usize,
    depth: usize,
    avail: &[u8],
    hand_size: usize,
    hand: &mut [u8],
    plan: &PlanNode,
    choose: &ChooseTable,
    board: &[u8],
    is_holdem: bool,
    rng: &mut SmallRng,
    matched: &mut usize,
    chosen: &mut Vec<u8>,
) {
    if depth == hand_size {
        if eval_plan(plan, hand, choose, board, is_holdem) {
            *matched += 1;
            if *matched == 1 || rng.gen_range(0..*matched) == 0 {
                chosen.clear();
                chosen.extend_from_slice(hand);
            }
        }
        return;
    }

    let need = hand_size - depth;
    if avail.len() < need || start > avail.len() - need {
        return;
    }

    for i in start..=avail.len() - need {
        hand[depth] = avail[i];
        reservoir_plan_combos_rec(
            i + 1,
            depth + 1,
            avail,
            hand_size,
            hand,
            plan,
            choose,
            board,
            is_holdem,
            rng,
            matched,
            chosen,
        );
    }
}

fn sample_random_hand(
    hand_size: usize,
    used: &[bool; 52],
    rng: &mut SmallRng,
    out: &mut Vec<u8>,
) -> bool {
    let mut avail = [0u8; 52];
    let mut n = 0usize;
    for c in 0u8..52u8 {
        if !used[c as usize] {
            avail[n] = c;
            n += 1;
        }
    }
    if n < hand_size {
        return false;
    }
    out.clear();
    for i in 0..hand_size {
        let j = i + rng.gen_range(0..(n - i));
        avail.swap(i, j);
        out.push(avail[i]);
    }
    out.sort_unstable();
    true
}

fn sample_random_hand_from_avail(
    avail: &[u8],
    hand_size: usize,
    rng: &mut SmallRng,
    out: &mut Vec<u8>,
) -> bool {
    if avail.len() < hand_size {
        return false;
    }
    let mut shuffled = [0u8; 52];
    let n = avail.len();
    shuffled[..n].copy_from_slice(avail);
    out.clear();
    for i in 0..hand_size {
        let j = i + rng.gen_range(0..(n - i));
        shuffled.swap(i, j);
        out.push(shuffled[i]);
    }
    out.sort_unstable();
    true
}

fn sample_from_pool(
    pool: &[PoolEntry],
    hand_size: usize,
    used_mask: u64,
    rng: &mut SmallRng,
    out: &mut Vec<u8>,
) -> bool {
    if pool.is_empty() {
        return false;
    }
    // Fast path: repeated random probing remains uniform among valid entries.
    for _ in 0..64 {
        let idx = rng.gen_range(0..pool.len());
        let hand = &pool[idx];
        if (hand.mask & used_mask) == 0 {
            out.clear();
            out.extend_from_slice(&hand.cards[..hand_size]);
            return true;
        }
    }
    // Slow path: exact reservoir sample over valid entries (uniform, no index bias).
    let mut matched = 0usize;
    let mut chosen: Option<&PoolEntry> = None;
    for hand in pool {
        if (hand.mask & used_mask) != 0 {
            continue;
        }
        matched += 1;
        if matched == 1 || rng.gen_range(0..matched) == 0 {
            chosen = Some(hand);
        }
    }
    let Some(hand) = chosen else {
        return false;
    };
    out.clear();
    out.extend_from_slice(&hand.cards[..hand_size]);
    true
}

fn cards_mask(cards: &[u8]) -> u64 {
    let mut mask = 0u64;
    for &c in cards {
        mask |= 1u64 << c;
    }
    mask
}

fn card_rank_value(card: u8) -> u8 {
    card / 4 + 2
}

fn card_suit(card: u8) -> u8 {
    card % 4
}

fn full_tag_match(tag: TagAtom, hand: &[u8], board: &[u8], is_holdem: bool) -> bool {
    if board.len() < 3 {
        return false;
    }

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
            eval.class_id == 1 && eval.pair_rank == eval.top_board
        }
        TagAtom::Overpair { plus } => {
            let eval = evaluate_core_ready_state(core, board, is_holdem);
            if plus {
                return eval.is_overpair || eval.class_id >= 2;
            }
            eval.is_overpair
        }
        TagAtom::TwoPair { plus } => {
            let eval = evaluate_core_ready_state(core, board, is_holdem);
            if plus {
                eval.class_id >= 2
            } else {
                eval.class_id == 2
            }
        }
        TagAtom::Set { plus } => {
            let eval = evaluate_core_ready_state(core, board, is_holdem);
            if plus {
                eval.class_id >= 3
            } else {
                eval.class_id == 3
            }
        }
        TagAtom::FlushDraw => flush_draw,
        TagAtom::Flush { plus } => {
            if !plus {
                return made_flush;
            }
            let eval = evaluate_core_ready_state(core, board, is_holdem);
            eval.class_id >= 5
        }
        TagAtom::Straight { plus } => {
            if plus {
                let eval = evaluate_core_ready_state(core, board, is_holdem);
                return eval.class_id >= 4;
            }
            if is_holdem {
                has_holdem_straight_by_ranks(&core, board)
            } else {
                has_omaha_core_straight(core, board)
            }
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
            core_straight_outs(core, board, is_holdem) >= min_outs
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

fn variant_from_hand_size(hand_size: usize) -> &'static str {
    match hand_size {
        2 => "holdem",
        4 => "plo4",
        5 => "plo5",
        6 => "plo6",
        _ => "",
    }
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

fn complete_board_runout(
    board5: &mut [u8; 5],
    known_len: usize,
    used: &[bool; 52],
    rng: &mut SmallRng,
) -> bool {
    if known_len >= 5 {
        return true;
    }
    let mut avail = [0u8; 52];
    let mut n = 0usize;
    for c in 0u8..52u8 {
        if !used[c as usize] {
            avail[n] = c;
            n += 1;
        }
    }
    let need = 5 - known_len;
    if n < need {
        return false;
    }
    for i in 0..need {
        let j = i + rng.gen_range(0..(n - i));
        avail.swap(i, j);
        board5[known_len + i] = avail[i];
    }
    true
}

fn eval_holdem(hole: &[u8], board5: &[u8; 5]) -> (u16, usize) {
    let mut hand = Hand::new();
    for &c in hole.iter().chain(board5.iter()) {
        hand.insert_unchecked(&CARDS[c as usize]);
    }
    let rank = poker_rank(&hand);
    (rank.0, class_id(rank.rank_category()))
}

fn eval_omaha_with_board(hole: &[u8], board_hand: &Hand) -> (u16, usize) {
    let mut hole_hand = Hand::new();
    for &c in hole {
        hole_hand.insert_unchecked(&CARDS[c as usize]);
    }
    let rank = omaha_rank(&hole_hand, board_hand);
    (rank.0, class_id(rank.rank_category()))
}

fn class_id(cat: PokerRankCategory) -> usize {
    match cat {
        PokerRankCategory::HighCard => 0,
        PokerRankCategory::Pair => 1,
        PokerRankCategory::TwoPair => 2,
        PokerRankCategory::ThreeOfAKind => 3,
        PokerRankCategory::Straight => 4,
        PokerRankCategory::Flush => 5,
        PokerRankCategory::FullHouse => 6,
        PokerRankCategory::FourOfAKind => 7,
        PokerRankCategory::StraightFlush | PokerRankCategory::RoyalFlush => 8,
        PokerRankCategory::Ineligible => 0,
    }
}

fn build_choose_table() -> ChooseTable {
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

fn build_combo_rank_prefix() -> [[usize; 53]; 7] {
    let choose = build_choose_table();
    let mut prefix = [[0usize; 53]; 7];
    for rem in 0..=6 {
        for x in 1..=52 {
            let v = x - 1;
            prefix[rem][x] = prefix[rem][x - 1] + choose[52 - (v + 1)][rem];
        }
    }
    prefix
}

fn combo_rank_52(cards: &[u8], _choose: &ChooseTable) -> usize {
    let prefix = COMBO_RANK_PREFIX.get_or_init(build_combo_rank_prefix);
    let k = cards.len();
    let mut rank = 0usize;
    let mut start = 0usize;
    for i in 0..k {
        let ci = cards[i] as usize;
        let rem = k - i - 1;
        rank += prefix[rem][ci].saturating_sub(prefix[rem][start]);
        start = ci + 1;
    }
    rank
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preview_range_exact_preflop_percent_is_exact_count() {
        let out = run_request_value(json!({
            "mode": "preview-range",
            "variant": "plo6",
            "hand_size": 6,
            "board": [],
            "dead": [],
            "percentile_profile": "ours",
            "range_text": "30%"
        }));

        assert_eq!(out["ok"], true);
        assert_eq!(out["coverage"]["approx"], false);
        assert_eq!(out["coverage"]["matched"], 6_107_556);
        assert_eq!(out["coverage"]["total"], 20_358_520);
    }

    #[test]
    fn preview_range_exact_compound_plan_counts_in_rust() {
        let out = run_request_value(json!({
            "mode": "preview-range",
            "variant": "plo6",
            "hand_size": 6,
            "board": [],
            "dead": [],
            "percentile_profile": "ours",
            "range_text": "30%:(AA)"
        }));

        assert_eq!(out["ok"], true);
        assert_eq!(out["coverage"]["approx"], false);
        assert_eq!(out["coverage"]["matched"], 1_094_644);
        assert_eq!(out["coverage"]["total"], 20_358_520);
    }

    #[test]
    fn preview_range_tag_plan_counts_in_rust() {
        let out = run_request_value(json!({
            "mode": "preview-range",
            "variant": "plo5",
            "hand_size": 5,
            "board": [0, 5, 10],
            "dead": [],
            "range_text": "@fd"
        }));

        assert_eq!(out["ok"], true);
        assert_eq!(out["coverage"]["approx"], false);
        assert!(out["coverage"]["total"].as_u64().unwrap_or(0) > 0);
    }

    #[test]
    fn tag_shortcuts_return_two_pair_labels_in_rust() {
        let out = run_request_value(json!({
            "mode": "tag-shortcuts",
            "variant": "plo5",
            "board": [8, 16, 20],
            "dead": [],
            "tags": ["@2p"]
        }));

        assert_eq!(out["ok"], true);
        let combos = out["tag_shortcuts"]["combos_by_tag"]["@2p"]
            .as_array()
            .expect("two-pair labels");
        assert!(combos.iter().any(|v| v.as_str() == Some("46")));
        assert!(combos.iter().any(|v| v.as_str() == Some("47")));
        assert!(combos.iter().any(|v| v.as_str() == Some("67")));
    }

    #[test]
    fn sim_mode_accepts_raw_range_text() {
        let out = run_request_value(json!({
            "mode": "sim",
            "variant": "plo5",
            "iteration_cap": 128,
            "board": [],
            "dead": [],
            "percentile_profile": "ours",
            "players": [
                { "mode": "range", "hand_size": 5, "range_text": "30%:(AA)" },
                { "mode": "range", "hand_size": 5, "range_text": "30%:(KK)" }
            ],
            "seed": 12345
        }));

        assert_eq!(out["ok"], true);
        assert!(out["raw"]["iterations"].as_u64().unwrap_or(0) > 0);
    }
}
