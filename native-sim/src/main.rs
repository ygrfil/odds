use std::io::{self, Read};

use anyhow::{Context, Result};
use aya_poker::base::{Hand, CARDS};
use aya_poker::{omaha_rank, poker_rank, PokerRankCategory};
use base64::engine::general_purpose::STANDARD as B64_STANDARD;
use base64::Engine as _;
use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use serde::{Deserialize, Serialize};

type ChooseTable = [[usize; 7]; 53];

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    mode: String,
    variant: String,
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
    #[serde(default)]
    hand_size: usize,
    pool_cap: Option<usize>,
    plan: Option<PlanNodeReq>,
}

#[derive(Debug, Deserialize)]
struct PlayerReq {
    mode: String,
    hand_size: usize,
    pool: Option<Vec<Vec<u8>>>,
}

#[derive(Debug, Serialize)]
struct Response {
    ok: bool,
    error: Option<String>,
    raw: Option<RawOut>,
    equity_rank: Option<EquityRankOut>,
    pool_build: Option<PoolBuildOut>,
}

#[derive(Debug, Serialize)]
struct RawOut {
    iterations: usize,
    elapsed_ms: f64,
    wins: Vec<usize>,
    ties: Vec<usize>,
    losses: Vec<usize>,
    equity_shares: Vec<f64>,
    combo_counts: Vec<usize>,
    combo_lists: Vec<Vec<String>>,
    class_counts: Vec<Vec<usize>>,
    confidence_reached: bool,
    confidence_half_width_pct: f64,
    confidence_level: f64,
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

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum PlanNodeReq {
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
    Specs {
        entries: Vec<Vec<SpecReq>>,
    },
    #[serde(rename = "pct_bits")]
    PctBits {
        bits_b64: String,
    },
}

#[derive(Debug, Deserialize)]
struct SpecReq {
    ranks_mask: u16,
    rank_var: i8,
    suit_mode: u8,
    suit_value: i8,
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
    All { hand_size: usize },
    Pool { hand_size: usize, pool: Vec<Vec<u8>> },
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

fn main() {
    if let Err(err) = real_main() {
        let out = Response {
            ok: false,
            error: Some(err.to_string()),
            raw: None,
            equity_rank: None,
            pool_build: None,
        };
        let _ = serde_json::to_writer(io::stdout(), &out);
    }
}

fn real_main() -> Result<()> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .context("failed to read stdin")?;
    let req: Request = serde_json::from_str(&input).context("invalid input json")?;

    let mode = request_mode(&req);
    match mode {
        "sim" => run_sim_mode(&req),
        "equity-rank" => run_equity_rank_mode(&req),
        "build-pool" => run_build_pool_mode(&req),
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

fn run_sim_mode(req: &Request) -> Result<()> {
    validate_request(req)?;

    let samplers = build_samplers(req)?;
    let workers = choose_workers(req.workers, req.iteration_cap);
    let seed = req.seed.unwrap_or(0x9E37_79B9_A5A5_1234);
    let conf = confidence_cfg(req);
    let choose = build_choose_table();
    let combo_space = choose[52][variant_hand_size(&req.variant)];
    let start = std::time::Instant::now();

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
                        .wrapping_add(((idx as u64) + 1) * 0x9E37_79B9_7F4A_7C15)
                        .wrapping_add((round as u64) * 0xBF58_476D_1CE4_E5B9);
                    simulate_partition(req, &samplers, iters, worker_seed, &choose, combo_space)
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
    };
    serde_json::to_writer(io::stdout(), &out).context("failed to write output json")?;
    Ok(())
}

const EQUITY_PERCENT_BASIS: usize = 1000;
const EQUITY_SCORE_SCALE: usize = 10_000;

fn run_equity_rank_mode(req: &Request) -> Result<()> {
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
                    .wrapping_add(((idx as u64) + 1) * 0x9E37_79B9_7F4A_7C15)
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
    };
    serde_json::to_writer(io::stdout(), &out).context("failed to write output json")?;
    Ok(())
}

fn run_build_pool_mode(req: &Request) -> Result<()> {
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
    let plan_req = req.plan.as_ref().context("missing plan for build-pool mode")?;
    let plan = compile_plan_node(plan_req)?;
    let choose = build_choose_table();
    let seed = req.seed.unwrap_or(0xC0DE_F00D_9E37_79B9);
    let mut rng = StdRng::seed_from_u64(seed);

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
    };
    serde_json::to_writer(io::stdout(), &out).context("failed to write output json")?;
    Ok(())
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
                if entry.is_empty() {
                    continue;
                }
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
        PlanNodeReq::PctBits { bits_b64 } => {
            let bits = B64_STANDARD
                .decode(bits_b64.as_bytes())
                .context("failed to decode pct_bits")?;
            if bits.is_empty() {
                anyhow::bail!("pct_bits payload is empty");
            }
            Ok(PlanNode::PctBits { bits })
        }
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
    cap: usize,
    rng: &mut StdRng,
    pool: &mut Vec<Vec<u8>>,
    matched: &mut usize,
) {
    if depth == hand_size {
        if !eval_plan(plan, hand, choose) {
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
            cap,
            rng,
            pool,
            matched,
        );
    }
}

fn eval_plan(node: &PlanNode, hand: &[u8], choose: &ChooseTable) -> bool {
    match node {
        PlanNode::Or(left, right) => eval_plan(left, hand, choose) || eval_plan(right, hand, choose),
        PlanNode::And(left, right) => eval_plan(left, hand, choose) && eval_plan(right, hand, choose),
        PlanNode::Not(left, right) => eval_plan(left, hand, choose) && !eval_plan(right, hand, choose),
        PlanNode::Specs { entries } => entries.iter().any(|specs| match_specs(specs, hand)),
        PlanNode::PctBits { bits } => {
            let idx = combo_rank_52(hand, choose);
            bit_is_set(bits, idx)
        }
    }
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
    let mut rng = StdRng::seed_from_u64(seed);
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
            if p.mode == "all" {
                Ok(Sampler::All {
                    hand_size: p.hand_size,
                })
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
                Ok(Sampler::Pool {
                    hand_size: p.hand_size,
                    pool,
                })
            } else {
                anyhow::bail!("unsupported player mode '{}'", p.mode);
            }
        })
        .collect()
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
) -> Partial {
    let pcount = req.players.len();
    let mut out = new_partial(pcount, combo_space);

    let mut rng = StdRng::seed_from_u64(seed);
    let mut blocked = [false; 52];
    for &c in req.board.iter().chain(req.dead.iter()) {
        blocked[c as usize] = true;
    }

    let is_holdem = req.variant == "holdem";

    let mut used = [false; 52];
    let mut board5 = [0u8; 5];
    let known_len = req.board.len();
    for (i, &c) in req.board.iter().enumerate() {
        board5[i] = c;
    }
    let mut hand_buf: Vec<Vec<u8>> = samplers.iter().map(|s| vec![0u8; sampler_hand_size(s)]).collect();
    let mut score_buf = vec![0u16; pcount];
    let mut winners = vec![false; pcount];
    let mut player_order: Vec<usize> = (0..pcount).collect();

    for _ in 0..iter_cap {
        used.copy_from_slice(&blocked);
        let mut failed = false;

        player_order.shuffle(&mut rng);

        for &pi in &player_order {
            let sampler = &samplers[pi];
            let hand = &mut hand_buf[pi];
            let ok = match sampler {
                Sampler::All { hand_size } => sample_random_hand(*hand_size, &used, &mut rng, hand),
                Sampler::Pool { pool, .. } => sample_from_pool(pool, &used, &mut rng, hand),
            };
            if !ok {
                failed = true;
                break;
            }
            for &c in hand.iter() {
                used[c as usize] = true;
            }
            out.combo_sets[pi].insert_index(combo_rank_52(hand, choose));
        }
        if failed {
            continue;
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
        Sampler::All { hand_size } => *hand_size,
        Sampler::Pool { hand_size, .. } => *hand_size,
    }
}

fn sample_random_hand(hand_size: usize, used: &[bool; 52], rng: &mut StdRng, out: &mut Vec<u8>) -> bool {
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

fn sample_from_pool(pool: &[Vec<u8>], used: &[bool; 52], rng: &mut StdRng, out: &mut Vec<u8>) -> bool {
    if pool.is_empty() {
        return false;
    }
    for _ in 0..64 {
        let idx = rng.gen_range(0..pool.len());
        let hand = &pool[idx];
        if disjoint(hand, used) {
            out.clear();
            out.extend_from_slice(hand);
            return true;
        }
    }
    let start = rng.gen_range(0..pool.len());
    for step in 0..pool.len() {
        let idx = (start + step) % pool.len();
        let hand = &pool[idx];
        if disjoint(hand, used) {
            out.clear();
            out.extend_from_slice(hand);
            return true;
        }
    }
    false
}

fn disjoint(hand: &[u8], used: &[bool; 52]) -> bool {
    for &c in hand {
        if used[c as usize] {
            return false;
        }
    }
    true
}

fn complete_board_runout(board5: &mut [u8; 5], known_len: usize, used: &[bool; 52], rng: &mut StdRng) -> bool {
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

fn combo_rank_52(cards: &[u8], choose: &ChooseTable) -> usize {
    let k = cards.len();
    let mut rank = 0usize;
    let mut start = 0usize;
    for i in 0..k {
        let ci = cards[i] as usize;
        for v in start..ci {
            rank += choose[52 - (v + 1)][k - i - 1];
        }
        start = ci + 1;
    }
    rank
}
