use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use serde_json::{json, Value};
use std::hint::black_box;
use std::time::Duration;

fn bench_request(c: &mut Criterion, name: &str, payload: Value) {
    c.bench_function(name, |b| {
        b.iter_batched(
            || payload.clone(),
            |input| {
                let out = native_sim::run_request_value(black_box(input));
                assert_eq!(out["ok"], true);
                black_box(out);
            },
            BatchSize::SmallInput,
        );
    });
}

fn hot_paths(c: &mut Criterion) {
    bench_request(
        c,
        "preview_plo6_percent_pair",
        json!({
            "mode": "preview-range",
            "variant": "plo6",
            "hand_size": 6,
            "board": [],
            "dead": [],
            "percentile_profile": "ours",
            "range_text": "42%:(AA)"
        }),
    );

    bench_request(
        c,
        "tag_shortcuts_plo5_two_pair",
        json!({
            "mode": "tag-shortcuts",
            "variant": "plo5",
            "board": [8, 16, 20],
            "dead": [],
            "tags": ["@2p", "@set", "@fd"]
        }),
    );

    bench_request(
        c,
        "sim_plo5_scoped_ranges",
        json!({
            "mode": "sim",
            "variant": "plo5",
            "iteration_cap": 2048,
            "board": [2, 6, 34],
            "dead": [],
            "percentile_profile": "ours",
            "players": [
                { "mode": "range", "hand_size": 5, "range_text": "30%:(@2p)" },
                { "mode": "range", "hand_size": 5, "range_text": "30%:(KK)" }
            ],
            "seed": 12345
        }),
    );
}

criterion_group! {
    name = benches;
    config = Criterion::default()
        .sample_size(10)
        .warm_up_time(Duration::from_millis(200))
        .measurement_time(Duration::from_secs(1));
    targets = hot_paths
}
criterion_main!(benches);
