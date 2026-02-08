use std::collections::HashSet;
use std::io::{self, Read};

use anyhow::{Context, Result};
use aya_poker::base::{Hand, CARDS};
use aya_poker::{omaha_rank, poker_rank, PokerRankCategory};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct Request {
    variant: String,
    iteration_cap: usize,
    board: Vec<u8>,
    dead: Vec<u8>,
    players: Vec<PlayerReq>,
    workers: Option<usize>,
    seed: Option<u64>,
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
}

#[derive(Clone)]
enum Sampler {
    All { hand_size: usize },
    Pool { hand_size: usize, pool: Vec<Vec<u8>> },
}

struct Partial {
    iterations: usize,
    wins: Vec<usize>,
    ties: Vec<usize>,
    losses: Vec<usize>,
    equity_shares: Vec<f64>,
    combo_lists: Vec<HashSet<u64>>,
    class_counts: Vec<Vec<usize>>,
}

fn main() {
    if let Err(err) = real_main() {
        let out = Response {
            ok: false,
            error: Some(err.to_string()),
            raw: None,
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

    validate_request(&req)?;

    let samplers = build_samplers(&req)?;
    let workers = choose_workers(req.workers, req.iteration_cap);
    let seed = req.seed.unwrap_or(0x9E37_79B9_A5A5_1234);
    let start = std::time::Instant::now();

    let thread_pool = ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()
        .context("failed to build rayon thread pool")?;

    let parts = split_iterations(req.iteration_cap, workers);
    let partials: Vec<Partial> = thread_pool.install(|| {
        parts
            .into_par_iter()
            .enumerate()
            .map(|(idx, iters)| simulate_partition(&req, &samplers, iters, seed.wrapping_add((idx as u64 + 1) * 0x9E37_79B9_7F4A_7C15)))
            .collect()
    });

    let merged = merge_partials(partials);
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;

    let out = Response {
        ok: true,
        error: None,
        raw: Some(RawOut {
            iterations: merged.iterations,
            elapsed_ms,
            wins: merged.wins,
            ties: merged.ties,
            losses: merged.losses,
            equity_shares: merged.equity_shares,
            combo_counts: merged.combo_lists.iter().map(|s| s.len()).collect(),
            combo_lists: (0..merged.combo_lists.len()).map(|_| Vec::new()).collect(),
            class_counts: merged.class_counts,
        }),
    };
    serde_json::to_writer(io::stdout(), &out).context("failed to write output json")?;
    Ok(())
}

fn validate_request(req: &Request) -> Result<()> {
    if req.players.len() < 2 || req.players.len() > 6 {
        anyhow::bail!("players must be 2..6");
    }
    if req.board.len() > 5 {
        anyhow::bail!("board must have at most 5 cards");
    }
    for &c in &req.board {
        if c > 51 {
            anyhow::bail!("invalid board card id {}", c);
        }
    }
    for &c in &req.dead {
        if c > 51 {
            anyhow::bail!("invalid dead card id {}", c);
        }
    }
    let mut seen = [false; 52];
    for &c in req.board.iter().chain(req.dead.iter()) {
        let idx = c as usize;
        if seen[idx] {
            anyhow::bail!("duplicate board/dead card {}", c);
        }
        seen[idx] = true;
    }
    match req.variant.as_str() {
        "holdem" | "plo4" | "plo5" | "plo6" => {}
        _ => anyhow::bail!("unsupported variant '{}'", req.variant),
    }
    if req.iteration_cap == 0 {
        anyhow::bail!("iteration_cap must be > 0");
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

fn choose_workers(requested: Option<usize>, iteration_cap: usize) -> usize {
    let mut workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    if let Some(r) = requested {
        if r > 0 {
            workers = workers.min(r);
        }
    }
    let _ = iteration_cap;
    workers.max(1)
}

fn split_iterations(total: usize, workers: usize) -> Vec<usize> {
    let mut out = vec![total / workers; workers];
    for slot in out.iter_mut().take(total % workers) {
        *slot += 1;
    }
    out
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
                for hand in &pool {
                    if hand.len() != p.hand_size {
                        anyhow::bail!("player {} pool hand has wrong size", i + 1);
                    }
                    let mut seen = [false; 52];
                    for &c in hand {
                        if c > 51 {
                            anyhow::bail!("player {} pool hand has invalid card", i + 1);
                        }
                        let idx = c as usize;
                        if seen[idx] {
                            anyhow::bail!("player {} pool hand has duplicate card", i + 1);
                        }
                        seen[idx] = true;
                    }
                }
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

fn simulate_partition(req: &Request, samplers: &[Sampler], iter_cap: usize, seed: u64) -> Partial {
    let pcount = req.players.len();
    let mut out = Partial {
        iterations: 0,
        wins: vec![0; pcount],
        ties: vec![0; pcount],
        losses: vec![0; pcount],
        equity_shares: vec![0.0; pcount],
        combo_lists: (0..pcount).map(|_| HashSet::new()).collect(),
        class_counts: (0..pcount).map(|_| vec![0; 9]).collect(),
    };

    let mut rng = StdRng::seed_from_u64(seed);
    let mut blocked = [false; 52];
    for &c in req.board.iter().chain(req.dead.iter()) {
        blocked[c as usize] = true;
    }

    let mut used = [false; 52];
    let mut board5 = [0u8; 5];
    let known_len = req.board.len();
    for (i, &c) in req.board.iter().enumerate() {
        board5[i] = c;
    }
    let mut hand_buf: Vec<Vec<u8>> = samplers.iter().map(|s| vec![0u8; sampler_hand_size(s)]).collect();
    let mut score_buf = vec![0u16; pcount];
    let mut class_buf = vec![0usize; pcount];
    let mut winners = vec![false; pcount];

    for _ in 0..iter_cap {
        used.copy_from_slice(&blocked);
        let mut failed = false;

        for (pi, sampler) in samplers.iter().enumerate() {
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
            out.combo_lists[pi].insert(combo_key(hand));
        }
        if failed {
            continue;
        }

        if !complete_board_runout(&mut board5, known_len, &used, &mut rng) {
            continue;
        }

        for pi in 0..pcount {
            let hand = &hand_buf[pi];
            let (score, class_id) = match req.variant.as_str() {
                "holdem" => eval_holdem(hand, &board5),
                "plo4" | "plo5" | "plo6" => eval_omaha(hand, &board5),
                _ => (0, 0),
            };
            score_buf[pi] = score;
            class_buf[pi] = class_id;
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
            if winners[i] {
                if winner_count == 1 {
                    out.wins[i] += 1;
                } else {
                    out.ties[i] += 1;
                }
                out.equity_shares[i] += 1.0 / winner_count as f64;
            } else {
                out.losses[i] += 1;
            }
        }
        out.iterations += 1;
    }

    out
}

fn merge_partials(parts: Vec<Partial>) -> Partial {
    let mut it = parts.into_iter();
    let Some(mut out) = it.next() else {
        return Partial {
            iterations: 0,
            wins: vec![],
            ties: vec![],
            losses: vec![],
            equity_shares: vec![],
            combo_lists: vec![],
            class_counts: vec![],
        };
    };
    for p in it {
        out.iterations += p.iterations;
        for i in 0..out.wins.len() {
            out.wins[i] += p.wins[i];
            out.ties[i] += p.ties[i];
            out.losses[i] += p.losses[i];
            out.equity_shares[i] += p.equity_shares[i];
            for c in 0..9 {
                out.class_counts[i][c] += p.class_counts[i][c];
            }
            for k in p.combo_lists[i].iter() {
                out.combo_lists[i].insert(*k);
            }
        }
    }
    out
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

fn eval_omaha(hole: &[u8], board5: &[u8; 5]) -> (u16, usize) {
    let mut hole_hand = Hand::new();
    for &c in hole {
        hole_hand.insert_unchecked(&CARDS[c as usize]);
    }
    let mut board_hand = Hand::new();
    for &c in board5 {
        board_hand.insert_unchecked(&CARDS[c as usize]);
    }
    let rank = omaha_rank(&hole_hand, &board_hand);
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

fn combo_key(cards: &[u8]) -> u64 {
    let mut key = (cards.len() as u64) << 60;
    for (i, &c) in cards.iter().enumerate() {
        key |= (c as u64) << (i * 6);
    }
    key
}
