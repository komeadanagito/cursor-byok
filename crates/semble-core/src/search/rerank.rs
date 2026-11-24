//! Definition boosts, path priors, file coherence, and result saturation.

use std::collections::HashMap;

use regex::Regex;

use crate::Chunk;

pub fn is_symbol_query(query: &str) -> bool {
    let value = query.trim();
    !value.contains(char::is_whitespace)
        && (value.contains("::")
            || value.contains("->")
            || value.contains('.')
            || value.starts_with('_')
            || value
                .chars()
                .any(|character| character == '_' || character.is_ascii_uppercase()))
}

pub fn rerank(
    scores: HashMap<usize, f32>,
    chunks: &[Chunk],
    anchors: &[Option<usize>],
    query: &str,
    top_k: usize,
) -> Vec<(usize, f32)> {
    if scores.is_empty() {
        return Vec::new();
    }
    let mut scores = scores;
    let max = scores.values().copied().fold(0.0_f32, f32::max);
    let mut file_sum = HashMap::<&str, f32>::new();
    let mut best = HashMap::<&str, usize>::new();
    // Stable accumulation and tie breaking keep repeated searches consistent across processes.
    let mut candidates = scores.keys().copied().collect::<Vec<_>>();
    candidates.sort_unstable();
    for index in candidates {
        let score = scores[&index];
        *file_sum.entry(&chunks[index].file_path).or_default() += score;
        best.entry(&chunks[index].file_path)
            .and_modify(|current| {
                if score > scores[current]
                    || (score == scores[current]
                        && chunks[index].start_line < chunks[*current].start_line)
                {
                    *current = index;
                }
            })
            .or_insert(index);
    }
    let max_sum = file_sum
        .values()
        .copied()
        .fold(0.0_f32, f32::max)
        .max(f32::EPSILON);
    for (path, index) in best {
        *scores.entry(index).or_default() += max * 0.2 * file_sum[path] / max_sum;
    }

    if is_symbol_query(query) {
        let symbol = query
            .rsplit([':', '.', '>'])
            .find(|part| !part.is_empty())
            .unwrap_or(query)
            .trim();
        let pattern = Regex::new(&format!(r"(?m)(?:^|\s)(?:class|def|fn|func|function|struct|enum|trait|interface|type|record|module|namespace|protocol)\s+{}(?:\s|[<({{:\[;]|$)", regex::escape(symbol))).ok();
        if let Some(pattern) = pattern {
            for (&index, score) in &mut scores {
                if pattern.is_match(&chunks[index].content) {
                    *score += max * 3.0;
                }
            }
        }
    }

    let mut ranked = scores
        .into_iter()
        .map(|(index, score)| (index, score * path_penalty(&chunks[index].file_path)))
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| chunks[left.0].file_path.cmp(&chunks[right.0].file_path))
            .then_with(|| chunks[left.0].start_line.cmp(&chunks[right.0].start_line))
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut selected = Vec::new();
    let mut per_location = HashMap::<usize, usize>::new();
    for (index, mut score) in ranked {
        let count = per_location
            .entry(anchors[index].unwrap_or(index))
            .or_default();
        if *count > 0 {
            score *= 0.5_f32.powi(*count as i32);
        }
        *count += 1;
        selected.push((index, score));
    }
    selected.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| chunks[left.0].file_path.cmp(&chunks[right.0].file_path))
            .then_with(|| chunks[left.0].start_line.cmp(&chunks[right.0].start_line))
            .then_with(|| left.0.cmp(&right.0))
    });
    selected.truncate(top_k);
    selected
}

pub(super) fn path_penalty(path: &str) -> f32 {
    let value = path.replace('\\', "/").to_ascii_lowercase();
    let mut penalty = 1.0;
    if value
        .split('/')
        .any(|part| matches!(part, "test" | "tests" | "__tests__" | "spec" | "testing"))
        || value.contains(".test.")
        || value.contains(".spec.")
        || value.ends_with("_test.rs")
        || value.ends_with("_test.go")
    {
        penalty *= 0.3;
    }
    if value.split('/').any(|part| {
        matches!(
            part,
            "compat" | "_compat" | "legacy" | "example" | "examples"
        )
    }) {
        penalty *= 0.3;
    }
    if value.ends_with(".d.ts") {
        penalty *= 0.7;
    }
    if value.ends_with("/__init__.py") || value.ends_with("/package-info.java") {
        penalty *= 0.5;
    }
    penalty
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_evidence_returns_the_earlier_location_every_time() {
        let chunks = [1, 10, 20].map(|line| Chunk {
            file_path: "src/detail.rs".into(),
            start_line: line,
            end_line: line,
            language: Some("rust".into()),
            content: String::new(),
        });
        for _ in 0..32 {
            let scores = [(0, 1.0), (1, 1.0), (2, 1.0)].into_iter().collect();
            let ranked = rerank(scores, &chunks, &[None; 3], "format the receipt", 3);
            assert_eq!(
                ranked
                    .into_iter()
                    .map(|(index, _)| index)
                    .collect::<Vec<_>>(),
                [0, 1, 2]
            );
        }
    }

    #[test]
    fn a_separate_implementation_is_not_a_duplicate_just_because_it_shares_a_file() {
        let chunks = [
            ("src/queue.rs", 1, 12),
            ("src/queue.rs", 150, 170),
            ("src/layout.rs", 1, 12),
        ]
        .map(|(path, start, end)| Chunk {
            file_path: path.into(),
            start_line: start,
            end_line: end,
            language: Some("rust".into()),
            content: String::new(),
        });
        let scores = [(0, 1.0), (1, 0.95), (2, 0.65)].into_iter().collect();
        let ranked = rerank(
            scores,
            &chunks,
            &[None; 3],
            "where are expired records evicted",
            2,
        );
        assert_eq!(ranked.iter().map(|r| r.0).collect::<Vec<_>>(), [0, 1]);
    }

    #[test]
    fn recognizes_symbols_and_penalizes_tests() {
        assert!(is_symbol_query("SearchEngine"));
        assert!(!is_symbol_query("find the search engine"));
        assert!(path_penalty("tests/search_test.rs") < path_penalty("src/search.rs"));
    }
}
