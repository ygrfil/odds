use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use crate::config::sampler_cache_budget_bytes;
use crate::{NativePlayerReq, PoolHand};

static SAMPLER_CACHE: OnceLock<Mutex<ByteBudgetCache<NativePlayerReq>>> = OnceLock::new();

#[derive(Debug)]
struct CacheEntry<T> {
    value: T,
    bytes: usize,
}

#[derive(Debug)]
pub(crate) struct ByteBudgetCache<T> {
    map: HashMap<String, CacheEntry<T>>,
    lru: VecDeque<String>,
    byte_budget: usize,
    current_bytes: usize,
}

impl<T> ByteBudgetCache<T> {
    pub(crate) fn new(byte_budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            lru: VecDeque::new(),
            byte_budget,
            current_bytes: 0,
        }
    }

    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.lru.iter().position(|k| k == key) {
            self.lru.remove(pos);
        }
        self.lru.push_back(key.to_string());
    }

    pub(crate) fn get(&mut self, key: &str) -> Option<T>
    where
        T: Clone,
    {
        let out = self.map.get(key).map(|entry| entry.value.clone());
        if out.is_some() {
            self.touch(key);
        }
        out
    }

    pub(crate) fn insert(&mut self, key: String, value: T, bytes: usize) {
        let bytes = bytes.max(1);
        if let Some(entry) = self.map.get_mut(&key) {
            self.current_bytes = self.current_bytes.saturating_sub(entry.bytes);
            entry.value = value;
            entry.bytes = bytes;
            self.current_bytes = self.current_bytes.saturating_add(bytes);
            self.touch(&key);
            self.evict_to_budget();
            return;
        }

        self.current_bytes = self.current_bytes.saturating_add(bytes);
        self.touch(&key);
        self.map.insert(key, CacheEntry { value, bytes });
        self.evict_to_budget();
    }

    fn evict_to_budget(&mut self) {
        while self.current_bytes > self.byte_budget && self.map.len() > 1 {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            if let Some(entry) = self.map.remove(&oldest) {
                self.current_bytes = self.current_bytes.saturating_sub(entry.bytes);
            }
        }
    }
}

pub(crate) fn sampler_cache_get(key: &str) -> Option<NativePlayerReq> {
    let cache = SAMPLER_CACHE
        .get_or_init(|| Mutex::new(ByteBudgetCache::new(sampler_cache_budget_bytes())));
    let mut guard = cache.lock().ok()?;
    guard.get(key)
}

pub(crate) fn sampler_cache_put(key: String, sampler: &NativePlayerReq) {
    let cache = SAMPLER_CACHE
        .get_or_init(|| Mutex::new(ByteBudgetCache::new(sampler_cache_budget_bytes())));
    let mut guard = match cache.lock() {
        Ok(v) => v,
        Err(_) => return,
    };
    let bytes = sampler_cache_entry_bytes(&key, sampler);
    guard.insert(key, sampler.clone(), bytes);
}

fn sampler_cache_entry_bytes(key: &str, sampler: &NativePlayerReq) -> usize {
    let pool_bytes = sampler
        .pool
        .as_ref()
        .map(|pool| {
            std::mem::size_of::<Vec<PoolHand>>() + pool.len() * std::mem::size_of::<PoolHand>()
        })
        .unwrap_or(0);
    let plan_bytes = sampler
        .plan
        .as_ref()
        .map(plan_node_cache_bytes)
        .unwrap_or(0);
    key.len()
        + sampler.mode.len()
        + std::mem::size_of::<NativePlayerReq>()
        + pool_bytes
        + plan_bytes
}

fn plan_node_cache_bytes(plan: &native_sim::PlanNodeReq) -> usize {
    use native_sim::PlanNodeReq;

    match plan {
        PlanNodeReq::Or { left, right }
        | PlanNodeReq::And { left, right }
        | PlanNodeReq::Not { left, right } => {
            std::mem::size_of::<PlanNodeReq>()
                + plan_node_cache_bytes(left)
                + plan_node_cache_bytes(right)
        }
        PlanNodeReq::Specs { entries } => {
            std::mem::size_of::<PlanNodeReq>()
                + std::mem::size_of::<Vec<Vec<native_sim::SpecReq>>>()
                + entries
                    .iter()
                    .map(|entry| {
                        std::mem::size_of::<Vec<native_sim::SpecReq>>()
                            + entry.len() * std::mem::size_of::<native_sim::SpecReq>()
                    })
                    .sum::<usize>()
        }
        PlanNodeReq::PctBits { bits_b64, bits } => {
            std::mem::size_of::<PlanNodeReq>()
                + bits_b64.as_ref().map(|v| v.len()).unwrap_or(0)
                + bits.as_ref().map(|v| v.len()).unwrap_or(0)
        }
        PlanNodeReq::PctExactTop {
            variant, profile, ..
        }
        | PlanNodeReq::PctExactRange {
            variant, profile, ..
        } => std::mem::size_of::<PlanNodeReq>() + variant.len() + profile.len(),
        PlanNodeReq::HeuristicTop { .. }
        | PlanNodeReq::HeuristicRange { .. }
        | PlanNodeReq::Tag { .. } => std::mem::size_of::<PlanNodeReq>(),
    }
}
