use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    let output = match io::stdin().read_to_string(&mut input) {
        Ok(_) => native_sim::run_request_json(&input),
        Err(err) => serde_json::json!({
            "ok": false,
            "error": format!("failed to read stdin: {err}"),
            "raw": null,
            "equity_rank": null,
            "pool_build": null
        }),
    };

    let _ = serde_json::to_writer(io::stdout(), &output);
}
