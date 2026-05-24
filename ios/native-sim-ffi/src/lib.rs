use std::ffi::{c_char, CString};
use std::ptr;
use std::slice;

#[no_mangle]
pub extern "C" fn odds_native_run_request_json(ptr: *const u8, len: usize) -> *mut c_char {
    if ptr.is_null() {
        return json_error("input pointer is null");
    }

    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    let input = match std::str::from_utf8(bytes) {
        Ok(value) => value,
        Err(err) => return json_error(&format!("input is not valid utf-8: {err}")),
    };

    let output = native_sim::run_request_json(input);
    match serde_json_to_c_string(&output) {
        Some(value) => value,
        None => json_error("failed to encode native response"),
    }
}

#[no_mangle]
pub extern "C" fn odds_native_free_string(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = CString::from_raw(ptr);
    }
}

fn serde_json_to_c_string(value: &serde_json::Value) -> Option<*mut c_char> {
    let json = serde_json::to_string(value).ok()?;
    CString::new(json).ok().map(CString::into_raw)
}

fn json_error(message: &str) -> *mut c_char {
    let payload = serde_json::json!({
        "ok": false,
        "error": message,
        "raw": null,
        "equity_rank": null,
        "pool_build": null
    });
    serde_json_to_c_string(&payload).unwrap_or(ptr::null_mut())
}
