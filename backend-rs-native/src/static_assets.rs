use axum::extract::Request;
use axum::http::{header::CACHE_CONTROL, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::Response;

pub(crate) async fn static_cache_headers(req: Request, next: Next) -> Response {
    let is_get_or_head = *req.method() == Method::GET || *req.method() == Method::HEAD;
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let is_api = path.starts_with("/api/");

    let mut res = next.run(req).await;

    if !is_get_or_head || is_api || !res.status().is_success() {
        return res;
    }

    let headers = res.headers_mut();
    if path == "/" || path.ends_with(".html") {
        headers.insert(
            CACHE_CONTROL,
            HeaderValue::from_static("no-cache, must-revalidate, max-age=0"),
        );
        return res;
    }

    if is_percentile_table_asset(&path) {
        if has_version_query(&query) {
            headers.insert(
                CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            );
        } else {
            headers.insert(
                CACHE_CONTROL,
                HeaderValue::from_static("no-cache, must-revalidate, max-age=0"),
            );
        }
        return res;
    }

    if is_static_asset(&path) {
        headers.insert(
            CACHE_CONTROL,
            HeaderValue::from_static("no-cache, must-revalidate, max-age=0"),
        );
    }
    res
}

fn is_percentile_table_asset(path: &str) -> bool {
    path.ends_with("/src/percentile-tables-ours-holdem.js")
        || path.ends_with("/src/percentile-tables-ours-plo4.js")
        || path.ends_with("/src/percentile-tables-ours-plo5.js")
        || path.ends_with("/src/percentile-tables-ours-plo6.js")
        || path.ends_with("/src/percentile-tables-ppt6max-plo4.js")
        || path.ends_with("/src/percentile-tables-ppt6max-plo5.js")
        || path == "/src/percentile-tables-ours-holdem.js"
        || path == "/src/percentile-tables-ours-plo4.js"
        || path == "/src/percentile-tables-ours-plo5.js"
        || path == "/src/percentile-tables-ours-plo6.js"
        || path == "/src/percentile-tables-ppt6max-plo4.js"
        || path == "/src/percentile-tables-ppt6max-plo5.js"
}

fn has_version_query(query: &str) -> bool {
    query.split('&').any(|part| {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        key == "v" && !value.is_empty()
    })
}

fn is_static_asset(path: &str) -> bool {
    const EXTENSIONS: [&str; 17] = [
        ".js", ".json", ".mjs", ".css", ".wasm", ".svg", ".ico", ".png", ".jpg", ".jpeg", ".gif",
        ".webp", ".woff", ".woff2", ".ttf", ".br", ".gz",
    ];
    EXTENSIONS.iter().any(|ext| path.ends_with(ext))
}
