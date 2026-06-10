use std::path::PathBuf;
use std::sync::OnceLock;

const REQUEST_BODY_LIMIT_BYTES_DEFAULT: usize = 256 * 1024;
const RANGE_TEXT_MAX_LEN_DEFAULT: usize = 4096;
const RANGE_EXPR_MAX_TOKENS_DEFAULT: usize = 2048;
const RANGE_EXPR_MAX_NESTING_DEFAULT: usize = 64;
const SIM_ITERATION_CAP_MAX_DEFAULT: usize = 20_000_000;
const SIM_DEFAULT_MAX_RUNTIME_MS: u64 = 300_000;
const SIM_MAX_RUNTIME_CAP_MS: u64 = 3_600_000;
const BOMBPOT_ITERATION_CAP_MAX_DEFAULT: usize = 2_000_000;
const BOMBPOT_MAX_RUNTIME_CAP_MS: u64 = 3_600_000;
const BOMBPOT_PROGRESS_TOKEN_MAX_LEN_DEFAULT: usize = 128;
const PREVIEW_MAX_RUNTIME_MS_DEFAULT: u64 = 45_000;
const SAMPLER_CACHE_BUDGET_BYTES_DEFAULT: usize = 12 * 1024 * 1024;

pub(crate) fn env_flag(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| {
            let t = v.trim().to_ascii_lowercase();
            !(t == "0" || t == "false" || t == "off" || t == "no")
        })
        .unwrap_or(default)
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
}

fn env_usize(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|v| *v > 0)
}

pub(crate) fn request_body_limit_bytes() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_usize("REQUEST_BODY_LIMIT_BYTES")
            .unwrap_or(REQUEST_BODY_LIMIT_BYTES_DEFAULT)
            .clamp(4 * 1024, 8 * 1024 * 1024)
    })
}

pub(crate) fn range_text_max_len() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_usize("RANGE_TEXT_MAX_LEN")
            .unwrap_or(RANGE_TEXT_MAX_LEN_DEFAULT)
            .clamp(256, 64 * 1024)
    })
}

pub(crate) fn range_expr_max_tokens() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_usize("RANGE_EXPR_MAX_TOKENS")
            .unwrap_or(RANGE_EXPR_MAX_TOKENS_DEFAULT)
            .clamp(64, 32 * 1024)
    })
}

pub(crate) fn range_expr_max_nesting() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_usize("RANGE_EXPR_MAX_NESTING")
            .unwrap_or(RANGE_EXPR_MAX_NESTING_DEFAULT)
            .clamp(8, 512)
    })
}

pub(crate) fn sim_iteration_cap_max() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_usize("SIM_ITERATION_CAP_MAX")
            .unwrap_or(SIM_ITERATION_CAP_MAX_DEFAULT)
            .max(1)
    })
}

pub(crate) fn sim_runtime_default_ms() -> u64 {
    static VALUE: OnceLock<u64> = OnceLock::new();
    *VALUE
        .get_or_init(|| env_u64("SIM_DEFAULT_MAX_RUNTIME_MS").unwrap_or(SIM_DEFAULT_MAX_RUNTIME_MS))
}

pub(crate) fn sim_runtime_cap_ms() -> u64 {
    static VALUE: OnceLock<u64> = OnceLock::new();
    *VALUE.get_or_init(|| env_u64("SIM_MAX_RUNTIME_MS_CAP").unwrap_or(SIM_MAX_RUNTIME_CAP_MS))
}

pub(crate) fn sim_max_runtime_ms_env() -> Option<u64> {
    static VALUE: OnceLock<Option<u64>> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_u64("SIM_MAX_RUNTIME_MS")
            .map(|v| v.min(sim_runtime_cap_ms()))
            .filter(|v| *v > 0)
    })
}

pub(crate) fn bombpot_iteration_cap_max() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_usize("BOMBPOT_ITERATION_CAP_MAX")
            .unwrap_or(BOMBPOT_ITERATION_CAP_MAX_DEFAULT)
            .max(1)
    })
}

pub(crate) fn bombpot_runtime_cap_ms() -> u64 {
    static VALUE: OnceLock<u64> = OnceLock::new();
    *VALUE
        .get_or_init(|| env_u64("BOMBPOT_MAX_RUNTIME_MS_CAP").unwrap_or(BOMBPOT_MAX_RUNTIME_CAP_MS))
}

pub(crate) fn bombpot_progress_token_max_len() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_usize("BOMBPOT_PROGRESS_TOKEN_MAX_LEN")
            .unwrap_or(BOMBPOT_PROGRESS_TOKEN_MAX_LEN_DEFAULT)
            .clamp(16, 512)
    })
}

pub(crate) fn preview_max_runtime_ms() -> u64 {
    static VALUE: OnceLock<u64> = OnceLock::new();
    *VALUE
        .get_or_init(|| env_u64("PREVIEW_MAX_RUNTIME_MS").unwrap_or(PREVIEW_MAX_RUNTIME_MS_DEFAULT))
}

pub(crate) fn bombpot_max_runtime_ms_env() -> Option<u64> {
    static VALUE: OnceLock<Option<u64>> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_u64("BOMBPOT_MAX_RUNTIME_MS")
            .map(|v| v.min(bombpot_runtime_cap_ms()))
            .filter(|v| *v > 0)
    })
}

pub(crate) fn sampler_cache_budget_bytes() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_usize("SAMPLER_CACHE_BUDGET_BYTES")
            .unwrap_or(SAMPLER_CACHE_BUDGET_BYTES_DEFAULT)
            .clamp(64 * 1024, 256 * 1024 * 1024)
    })
}

fn max_concurrent_heavy_requests() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(|| {
        env_usize("MAX_CONCURRENT_HEAVY_REQUESTS").unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|v| v.get())
                .unwrap_or(1)
        })
    })
}

fn heavy_request_semaphore() -> &'static tokio::sync::Semaphore {
    static SEM: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SEM.get_or_init(|| tokio::sync::Semaphore::new(max_concurrent_heavy_requests().max(1)))
}

pub(crate) fn try_acquire_heavy_request_permit(
) -> Result<tokio::sync::SemaphorePermit<'static>, &'static str> {
    heavy_request_semaphore()
        .try_acquire()
        .map_err(|_| "server is busy; retry shortly")
}

pub(crate) fn resolve_static_root() -> Result<PathBuf, std::io::Error> {
    match std::env::var("APP_STATIC_ROOT") {
        Ok(value) => Ok(PathBuf::from(value)),
        Err(_) => std::env::current_dir(),
    }
}
