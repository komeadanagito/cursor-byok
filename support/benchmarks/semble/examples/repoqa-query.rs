//! Exposes Semble's real indexing and search APIs to the RepoQA benchmark.

use std::{
    collections::HashMap,
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
    time::Instant,
};

use semble_core::{
    cache::{load_snapshot, CacheLayout},
    index::IndexSnapshot,
    ContentType, SearchEngine, SearchRequest, SembleConfig,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Query {
    root: PathBuf,
    query: String,
    audit: Option<Target>,
}

#[derive(Deserialize)]
struct Target {
    path: String,
    line: usize,
    symbol: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let cache = args.next().ok_or("expected index cache directory")?;
    let config = SembleConfig::new(cache);
    let engine = SearchEngine::load_default(config.clone())?;
    let mut indexes = Vec::new();
    for root in args.map(PathBuf::from) {
        let started = Instant::now();
        let stats = engine.prepare(&root, &[ContentType::Code])?;
        indexes.push(json!({
            "root": root,
            "ms": started.elapsed().as_secs_f64() * 1000.0,
            "files": stats.file_count,
            "chunks": stats.chunk_count,
        }));
    }
    let mut out = io::stdout().lock();
    writeln!(out, "{}", json!(indexes))?;
    out.flush()?;

    let mut snapshots: HashMap<PathBuf, IndexSnapshot> = HashMap::new();
    for line in io::stdin().lock().lines() {
        let query: Query = serde_json::from_str(&line?)?;
        let mut report = serde_json::Map::new();
        if let Some(target) = &query.audit {
            let source = query.root.canonicalize()?;
            let snapshot = match snapshots.entry(source) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let layout = CacheLayout::new(
                        &config.cache_dir,
                        &entry.key().to_string_lossy(),
                        "minishlab/potion-code-16M-v2",
                        &[ContentType::Code],
                        config.desired_chunk_bytes,
                    );
                    entry.insert(
                        load_snapshot(&layout.snapshot)?
                            .ok_or("expected a prepared index snapshot")?,
                    )
                }
            };
            let file = snapshot.files.iter().find(|file| file.path == target.path);
            let covering = file
                .into_iter()
                .flat_map(|file| file.chunks.iter().enumerate())
                .filter(|(_, chunk)| (chunk.start_line..=chunk.end_line).contains(&target.line))
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            report.insert("file_indexed".into(), json!(file.is_some()));
            report.insert("covering_chunks".into(), json!(covering.len()));
            report.insert(
                "indexed_symbol".into(),
                json!(file.is_some_and(|file| file.definitions.iter().any(|def| {
                    def.symbol.eq_ignore_ascii_case(&target.symbol) && covering.contains(&def.chunk)
                }))),
            );
        }
        let mut request = SearchRequest::new(query.query, query.root);
        request.top_k = if query.audit.is_some() { 100 } else { 10 };
        request.max_snippet_lines = Some(0);
        let started = Instant::now();
        let result = engine.search(request)?;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let hits = result
            .results
            .into_iter()
            .map(|hit| (hit.file_path, hit.start_line, hit.end_line))
            .collect::<Vec<_>>();
        report.insert("ms".into(), json!(elapsed_ms));
        report.insert("hits".into(), json!(hits));
        writeln!(out, "{}", json!(report))?;
        out.flush()?;
    }
    Ok(())
}
