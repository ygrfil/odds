use serde::Deserialize;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PercentileTable {
    basis: u32,
    sample_size: u32,
    top_score_keys: Vec<u16>,
    top_ranks: Vec<u32>,
    score_keys_by_combo_rank: Vec<u16>,
}

fn main() {
    let tables = [
        (
            "percentile-ours-holdem.bin",
            "../src/percentile-tables-ours-holdem.js",
            "PRECOMPUTED_PERCENTILE_TABLE_HOLDEM",
        ),
        (
            "percentile-ours-plo4.bin",
            "../src/percentile-tables-ours-plo4.js",
            "PRECOMPUTED_PERCENTILE_TABLE_PLO4",
        ),
        (
            "percentile-ours-plo5.bin",
            "../src/percentile-tables-ours-plo5.js",
            "PRECOMPUTED_PERCENTILE_TABLE_PLO5",
        ),
        (
            "percentile-ours-plo6.bin",
            "../src/percentile-tables-ours-plo6.js",
            "PRECOMPUTED_PERCENTILE_TABLE_PLO6",
        ),
        (
            "percentile-ppt6max-plo4.bin",
            "../src/percentile-tables-ppt6max-plo4.js",
            "PPT_6MAX_PERCENTILE_TABLE_PLO4",
        ),
        (
            "percentile-ppt6max-plo5.bin",
            "../src/percentile-tables-ppt6max-plo5.js",
            "PPT_6MAX_PERCENTILE_TABLE_PLO5",
        ),
    ];

    let out_dir = env::var("OUT_DIR").expect("OUT_DIR is set by Cargo");
    for (out_name, source_path, export_name) in tables {
        println!("cargo:rerun-if-changed={source_path}");
        let table = load_percentile_table(source_path, export_name)
            .unwrap_or_else(|err| panic!("failed to build {out_name}: {err}"));
        let out_path = Path::new(&out_dir).join(out_name);
        write_percentile_table(&out_path, &table)
            .unwrap_or_else(|err| panic!("failed to write {}: {err}", out_path.display()));
    }
}

fn load_percentile_table(path: &str, export_name: &str) -> Result<PercentileTable, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    let object_text = extract_exported_object_literal(&text, export_name)
        .ok_or_else(|| format!("failed to parse {export_name} in {path}"))?;
    let table: PercentileTable =
        json5::from_str(&object_text).map_err(|e| format!("parse {path}: {e}"))?;
    validate_percentile_table(&table)?;
    Ok(table)
}

fn validate_percentile_table(table: &PercentileTable) -> Result<(), String> {
    let steps = 100usize.saturating_mul(table.basis.max(1) as usize);
    if table.sample_size == 0 {
        return Err("sampleSize is zero".to_string());
    }
    if table.top_score_keys.len() < steps + 1 {
        return Err("topScoreKeys is shorter than basis steps".to_string());
    }
    if table.top_ranks.len() < steps + 1 {
        return Err("topRanks is shorter than basis steps".to_string());
    }
    if table.score_keys_by_combo_rank.len() < table.sample_size as usize {
        return Err("scoreKeysByComboRank is shorter than sampleSize".to_string());
    }
    Ok(())
}

fn write_percentile_table(path: &Path, table: &PercentileTable) -> io::Result<()> {
    let mut out = Vec::with_capacity(
        28 + table.top_score_keys.len() * 2
            + table.top_ranks.len() * 4
            + table.score_keys_by_combo_rank.len() * 2,
    );
    out.extend_from_slice(b"EVPTBL1\0");
    write_u32(&mut out, table.basis);
    write_u32(&mut out, table.sample_size);
    write_u32(&mut out, table.top_score_keys.len() as u32);
    write_u32(&mut out, table.top_ranks.len() as u32);
    write_u32(&mut out, table.score_keys_by_combo_rank.len() as u32);
    for v in &table.top_score_keys {
        write_u16(&mut out, *v);
    }
    for v in &table.top_ranks {
        write_u32(&mut out, *v);
    }
    for v in &table.score_keys_by_combo_rank {
        write_u16(&mut out, *v);
    }
    let mut file = fs::File::create(path)?;
    file.write_all(&out)
}

fn write_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn write_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
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
