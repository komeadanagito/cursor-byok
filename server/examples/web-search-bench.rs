//! Measures public web retrieval through the production federation code.

use std::{
    io::{self, BufRead, Write},
    time::Instant,
};

use cursor_server::search::WebSearch;
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let search = WebSearch::built_in();
    let mut out = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let query: String = serde_json::from_str(&line?)?;
        let start = Instant::now();
        let result = search.search(&query).await;
        let seconds = start.elapsed().as_secs_f64();
        let row = match result {
            Ok(items) => {
                let hits: Vec<_> = items.into_iter().map(|hit| (hit.url, hit.title)).collect();
                json!({ "seconds": seconds, "hits": hits })
            }
            Err(error) => json!({ "seconds": seconds, "error": error.to_string() }),
        };
        writeln!(out, "{row}")?;
        out.flush()?;
    }
    Ok(())
}
