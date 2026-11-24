//! Cached index lifecycle and semantic, lexical, and related-code queries.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};

use parking_lot::Mutex;

use crate::{
    embedding::{Embedder, ModelAssets, StaticEmbedder},
    index::{tokenize, Bm25Match, IndexRepository, LoadedIndex},
    source::{canonical_source_root, RemoteRepository},
    types::snippet,
    ContentType, Error, FindRelatedRequest, IndexStats, Result, SearchRequest, SearchResponse,
    SearchResult, SembleConfig,
};

use super::{
    rerank::{is_symbol_query, path_penalty, rerank},
    rrf,
};

const NATURAL_LANGUAGE_SEMANTIC_WEIGHT: f32 = 0.5;
const SYMBOL_SEMANTIC_WEIGHT: f32 = 0.3;

pub struct SearchEngine {
    config: SembleConfig,
    repository: IndexRepository,
}

static EMBEDDERS: LazyLock<Mutex<HashMap<PathBuf, Arc<StaticEmbedder>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

impl SearchEngine {
    pub fn load_default(config: SembleConfig) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .build()
            .map_err(|error| Error::ModelAsset(error.to_string()))?;
        Self::load_default_with_client(config, &client)
    }

    pub fn load_default_with_client(
        config: SembleConfig,
        client: &reqwest::blocking::Client,
    ) -> Result<Self> {
        let model_path = ModelAssets::model_path(&config.cache_dir);
        let cached = { EMBEDDERS.lock().get(&model_path).cloned() };
        let embedder = if let Some(embedder) = cached {
            embedder
        } else {
            let assets = ModelAssets::ensure_with_client(&config.cache_dir, client)?;
            let embedder = Arc::new(StaticEmbedder::load(&assets.model, &assets.tokenizer)?);
            EMBEDDERS
                .lock()
                .insert(assets.model.clone(), embedder.clone());
            embedder
        };
        Ok(Self::with_embedder(config, embedder))
    }

    pub fn with_embedder(config: SembleConfig, embedder: Arc<dyn Embedder>) -> Self {
        let repository = IndexRepository::new(config.clone(), embedder);
        Self { config, repository }
    }

    /// Opens a prepared index and incrementally refreshes changed source files.
    pub fn prepare(&self, repo: &Path, content: &[ContentType]) -> Result<IndexStats> {
        let (root, identity) = self.resolve_source(repo)?;
        let content = normalize_content(content);
        let index = self.repository.load_or_build(&root, &identity, &content)?;
        Ok(index_stats(&index))
    }

    /// Rescans source stamps and incrementally refreshes a prepared index.
    pub fn refresh(&self, repo: &Path, content: &[ContentType]) -> Result<IndexStats> {
        let (root, identity) = self.resolve_source(repo)?;
        let content = normalize_content(content);
        let index = self.repository.load_or_build(&root, &identity, &content)?;
        Ok(index_stats(&index))
    }

    pub fn search(&self, request: SearchRequest) -> Result<SearchResponse> {
        validate_query(&request.query, request.top_k)?;
        let (root, identity) = self.resolve_source(&request.repo)?;
        let content = normalize_content(&request.content);
        let index = self
            .repository
            .load_for_search(&root, &identity, &content)?;
        if let Some(locations) = index.declarations.get(request.query.trim()) {
            let results = locations
                .iter()
                .take(request.top_k)
                .map(|location| {
                    let file_path = &index.metadata.files[location.file].path;
                    let start = location.span.start;
                    let end = location.span.end;
                    Ok(SearchResult {
                        file_path: file_path.clone(),
                        start_line: start,
                        end_line: end,
                        score: 1.0,
                        content: source_span(
                            &root.join(file_path),
                            start,
                            end,
                            request.max_snippet_lines,
                        )?,
                    })
                })
                .collect::<Result<_>>()?;
            return Ok(SearchResponse {
                query: request.query,
                results,
            });
        }
        if !request.query.contains(char::is_whitespace) {
            let exact = index
                .lexical
                .exact_symbol(&request.query, &index.chunks, request.top_k);
            if !exact.is_empty() {
                return response(
                    &request.query,
                    exact,
                    &index,
                    &root,
                    request.max_snippet_lines,
                );
            }
        }
        let query_vector = quantize_query(self.encode_query(&index, &request.query)?);
        let candidate_count = request.top_k.saturating_mul(5).max(request.top_k);
        let semantic = rank_semantic(
            &query_vector,
            &index.vectors,
            index.metadata.dimensions,
            candidate_count,
        );
        let lexical = index.bm25.search(&request.query, candidate_count);
        let lexical_ranking = lexical
            .iter()
            .map(|matched| matched.document)
            .collect::<Vec<_>>();
        let symbol_query = is_symbol_query(&request.query);
        let semantic_weight = if symbol_query {
            SYMBOL_SEMANTIC_WEIGHT
        } else {
            NATURAL_LANGUAGE_SEMANTIC_WEIGHT
        };
        let mut fused = rrf::fuse(&semantic, &lexical_ranking, semantic_weight);
        let literal_query = is_literal_query(&request.query);
        if !symbol_query && !literal_query {
            let declarations = fused
                .iter()
                .filter_map(|(&chunk, &score)| {
                    index.function_anchors[chunk].map(|declaration| (chunk, declaration, score))
                })
                .collect::<Vec<_>>();
            for (chunk, declaration, score) in declarations {
                // An attached comment describes the implementation; unlike a body chunk,
                // it cannot itself show the implementation in a returned snippet.
                if chunk < declaration {
                    fused.remove(&chunk);
                }
                let current = fused.entry(declaration).or_default();
                *current = current.max(score);
            }
        }
        let definitions = if !symbol_query {
            index
                .lexical
                .inferred_symbols(&request.query, &index.chunks, request.top_k)
        } else {
            Vec::new()
        };
        let strong_lexical = if symbol_query || !literal_query {
            Vec::new()
        } else {
            strong_lexical_matches(
                &lexical,
                &index.chunks,
                &request.query,
                &root,
                request.top_k.min(3),
            )?
        };
        let ranked = prioritize_evidence(
            strong_lexical,
            definitions,
            rerank(
                fused,
                &index.chunks,
                &index.function_anchors,
                &request.query,
                request.top_k,
            ),
            request.top_k,
        );
        response(
            &request.query,
            ranked,
            &index,
            &root,
            request.max_snippet_lines,
        )
    }

    pub fn find_related(&self, request: FindRelatedRequest) -> Result<SearchResponse> {
        if request.line == 0 || request.top_k == 0 {
            return Err(Error::InvalidRequest(
                "line and top_k must be greater than zero".into(),
            ));
        }
        let (root, identity) = self.resolve_source(&request.repo)?;
        let content = normalize_content(&request.content);
        let index = self
            .repository
            .load_for_search(&root, &identity, &content)?;
        let normalized = request.file_path.replace('\\', "/");
        let source = index
            .chunks
            .iter()
            .position(|chunk| {
                chunk.file_path == normalized
                    && chunk.start_line <= request.line
                    && request.line <= chunk.end_line
            })
            .ok_or_else(|| {
                Error::InvalidRequest(format!(
                    "no indexed chunk contains {}:{}",
                    request.file_path, request.line
                ))
            })?;
        let dimensions = index.metadata.dimensions;
        let source_start = source * dimensions;
        let source_vector = &index.vectors[source_start..source_start + dimensions];
        let mut ranked =
            rank_semantic(source_vector, &index.vectors, dimensions, request.top_k + 1)
                .into_iter()
                .filter(|position| *position != source)
                .take(request.top_k)
                .map(|position| {
                    (
                        position,
                        quantized_cosine(
                            source_vector,
                            &index.vectors[position * dimensions..(position + 1) * dimensions],
                        ),
                    )
                })
                .collect::<Vec<_>>();
        ranked.sort_by(|left, right| right.1.total_cmp(&left.1));
        response(
            &format!("Chunks related to {}:{}", request.file_path, request.line),
            ranked,
            &index,
            &root,
            request.max_snippet_lines,
        )
    }

    fn resolve_source(&self, source: &Path) -> Result<(PathBuf, String)> {
        let value = source.to_string_lossy();
        if value.starts_with("https://") || value.starts_with("http://") {
            let remote = RemoteRepository::acquire(&value, &self.config.cache_dir)?;
            Ok((remote.path, remote.identity))
        } else {
            let root = canonical_source_root(source)?;
            let identity = root.to_string_lossy().into_owned();
            Ok((root, identity))
        }
    }

    fn encode_query(&self, _index: &LoadedIndex, query: &str) -> Result<Vec<f32>> {
        self.repository
            .encode(&[query.to_owned()])
            .map(|mut values| values.remove(0))
    }
}

fn validate_query(query: &str, top_k: usize) -> Result<()> {
    if query.trim().is_empty() {
        return Err(Error::InvalidRequest("query must not be empty".into()));
    }
    if top_k == 0 || top_k > 100 {
        return Err(Error::InvalidRequest(
            "top_k must be between 1 and 100".into(),
        ));
    }
    Ok(())
}

fn index_stats(index: &LoadedIndex) -> IndexStats {
    IndexStats {
        file_count: index.metadata.files.len(),
        chunk_count: index.chunks.len(),
        source_bytes: index
            .metadata
            .files
            .iter()
            .map(|file| file.stamp.size)
            .sum(),
        dimensions: index.metadata.dimensions,
    }
}

fn strong_lexical_matches(
    lexical: &[Bm25Match],
    chunks: &[crate::Chunk],
    query: &str,
    root: &Path,
    limit: usize,
) -> Result<Vec<(usize, f32)>> {
    let query_terms = tokenize(query).into_iter().collect::<HashSet<_>>();
    if query_terms.len() < 2 || lexical.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let top_score = lexical[0].score.max(f32::EPSILON);
    let mut files = HashMap::<String, String>::new();
    let mut strong = Vec::new();
    for matched in lexical {
        let score_ratio = matched.score / top_score;
        let phrase = if matched.coverage >= 0.5 {
            let content = indexed_chunk_text(&chunks[matched.document], root, &mut files)?;
            if path_penalty(&chunks[matched.document].file_path) < 0.5
                || content.trim_start().starts_with("#[cfg(test)]")
            {
                continue;
            }
            contains_normalized_phrase(query, &content)
        } else {
            false
        };
        if !phrase && (matched.coverage < 0.8 || score_ratio < 0.7) {
            continue;
        }
        let strength = (score_ratio + matched.coverage + if phrase { 2.0 } else { 0.0 })
            * path_penalty(&chunks[matched.document].file_path);
        strong.push((matched.document, strength));
    }
    strong.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| chunks[left.0].file_path.cmp(&chunks[right.0].file_path))
            .then_with(|| chunks[left.0].start_line.cmp(&chunks[right.0].start_line))
    });
    strong.truncate(limit);
    Ok(strong)
}

fn is_literal_query(query: &str) -> bool {
    let lower = query.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if [
        "not found",
        "permission denied",
        "access denied",
        "unauthorized",
        "forbidden",
        "invalid argument",
        "missing ",
        "failed to",
        "panic",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || lower
            .chars()
            .any(|character| matches!(character, '`' | '"' | '\'' | '{' | '}' | '='))
    {
        return true;
    }
    let terms = lower.split_whitespace().collect::<Vec<_>>();
    if !(2..=8).contains(&terms.len()) {
        return false;
    }
    let natural_connectors = [
        "a", "an", "and", "as", "at", "by", "for", "from", "how", "in", "into", "is", "of", "on",
        "the", "to", "using", "when", "where", "while", "with",
    ];
    let behavior_verbs = [
        "build",
        "call",
        "compile",
        "create",
        "define",
        "dispatch",
        "find",
        "handle",
        "hydrate",
        "implement",
        "load",
        "parse",
        "persist",
        "read",
        "record",
        "register",
        "render",
        "save",
        "schedule",
        "search",
        "send",
        "store",
        "update",
        "watch",
        "write",
    ];
    !terms.iter().any(|term| natural_connectors.contains(term))
        && !behavior_verbs.contains(&terms[0])
}

fn indexed_chunk_text(
    chunk: &crate::Chunk,
    root: &Path,
    files: &mut HashMap<String, String>,
) -> Result<String> {
    if !chunk.content.is_empty() {
        return Ok(chunk.content.clone());
    }
    if !files.contains_key(&chunk.file_path) {
        let path = root.join(&chunk.file_path);
        let source = std::fs::read_to_string(&path).map_err(|error| Error::io(&path, error))?;
        files.insert(chunk.file_path.clone(), source);
    }
    Ok(files[&chunk.file_path]
        .lines()
        .skip(chunk.start_line.saturating_sub(1))
        .take(chunk.end_line.saturating_sub(chunk.start_line) + 1)
        .collect::<Vec<_>>()
        .join("\n"))
}

fn contains_normalized_phrase(query: &str, content: &str) -> bool {
    let phrase = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let source = content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    !phrase.is_empty() && source.contains(&phrase)
}

fn prioritize_evidence(
    strong_lexical: Vec<(usize, f32)>,
    definitions: Vec<(usize, f32)>,
    ranked: Vec<(usize, f32)>,
    top_k: usize,
) -> Vec<(usize, f32)> {
    let mut output = strong_lexical;
    for candidate in definitions.into_iter().chain(ranked) {
        if !output.iter().any(|existing| existing.0 == candidate.0) {
            output.push(candidate);
        }
    }
    output.truncate(top_k);
    output
}

fn normalize_content(content: &[ContentType]) -> Vec<ContentType> {
    let mut output = if content.is_empty() {
        vec![ContentType::Code]
    } else {
        content.to_vec()
    };
    output.sort_by_key(|item| *item as u8);
    output.dedup();
    output
}

fn rank_semantic(query: &[i8], vectors: &[i8], dimensions: usize, limit: usize) -> Vec<usize> {
    let scores = vectors
        .chunks_exact(dimensions)
        .map(|vector| quantized_dot(query, vector))
        .collect::<Vec<_>>();
    rank_scores(&scores, limit, false)
}

fn rank_scores(scores: &[f32], limit: usize, exclude_zero: bool) -> Vec<usize> {
    let mut indices = (0..scores.len())
        .filter(|index| !exclude_zero || scores[*index] > 0.0)
        .collect::<Vec<_>>();
    let order = |left: &usize, right: &usize| {
        scores[*right]
            .total_cmp(&scores[*left])
            .then_with(|| left.cmp(right))
    };
    if limit < indices.len() {
        // Rank only the requested prefix; exact ties still use source order.
        indices.select_nth_unstable_by(limit, order);
        indices.truncate(limit);
    }
    indices.sort_unstable_by(order);
    indices
}

fn quantized_dot(left: &[i8], right: &[i8]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| i32::from(*left) * i32::from(*right))
        .sum::<i32>() as f32
}

fn quantized_cosine(left: &[i8], right: &[i8]) -> f32 {
    quantized_dot(left, right) / (127.0 * 127.0)
}

fn quantize_query(vector: Vec<f32>) -> Vec<i8> {
    vector
        .into_iter()
        .map(|value| (value.clamp(-1.0, 1.0) * 127.0).round() as i8)
        .collect()
}

fn response(
    query: &str,
    ranked: Vec<(usize, f32)>,
    index: &LoadedIndex,
    root: &Path,
    max_lines: Option<usize>,
) -> Result<SearchResponse> {
    Ok(SearchResponse {
        query: query.to_owned(),
        results: ranked
            .into_iter()
            .map(|(position, score)| {
                let chunk = &index.chunks[position];
                Ok(SearchResult {
                    file_path: chunk.file_path.clone(),
                    start_line: chunk.start_line,
                    end_line: chunk.end_line,
                    score,
                    content: chunk_content(root, chunk, max_lines)?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
    })
}

fn chunk_content(
    root: &Path,
    chunk: &crate::Chunk,
    lines: Option<usize>,
) -> Result<Option<String>> {
    if lines == Some(0) {
        return Ok(None);
    }
    if !chunk.content.is_empty() {
        return Ok(snippet(&chunk.content, lines));
    }
    source_span(
        &root.join(&chunk.file_path),
        chunk.start_line,
        chunk.end_line,
        lines,
    )
}

fn source_span(
    path: &Path,
    start: usize,
    end: usize,
    lines: Option<usize>,
) -> Result<Option<String>> {
    if lines == Some(0) {
        return Ok(None);
    }
    let source = std::fs::read_to_string(path).map_err(|error| Error::io(path, error))?;
    let available = end.saturating_sub(start) + 1;
    let limit = lines.unwrap_or(available).min(available);
    Ok(Some(
        source
            .lines()
            .skip(start.saturating_sub(1))
            .take(limit)
            .collect::<Vec<_>>()
            .join("\n"),
    ))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    struct KeywordEmbedder;

    impl Embedder for KeywordEmbedder {
        fn id(&self) -> &str {
            "keyword-v1"
        }
        fn dimensions(&self) -> usize {
            3
        }
        fn encode(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            Ok(texts
                .iter()
                .map(|text| {
                    let text = text.to_ascii_lowercase();
                    let mut vector = vec![
                        usize::from(text.contains("auth")) as f32,
                        usize::from(text.contains("invoice")) as f32,
                        usize::from(text.contains("parse")) as f32,
                    ];
                    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
                    if norm > 0.0 {
                        vector.iter_mut().for_each(|value| *value /= norm);
                    }
                    vector
                })
                .collect())
        }
    }

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, SearchEngine) {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::create_dir_all(source.path().join("src")).unwrap();
        fs::write(
            source.path().join("src/auth.rs"),
            "pub fn authenticate_request() {\n    verify_token();\n}\n",
        )
        .unwrap();
        fs::write(
            source.path().join("src/billing.rs"),
            "pub fn create_invoice() {\n    charge_customer();\n}\n",
        )
        .unwrap();
        let engine =
            SearchEngine::with_embedder(SembleConfig::new(cache.path()), Arc::new(KeywordEmbedder));
        (source, cache, engine)
    }

    #[test]
    fn hybrid_search_returns_locations_and_bounded_snippets() {
        let (source, _cache, engine) = fixture();
        let response = engine
            .search(SearchRequest {
                query: "authenticate request".into(),
                repo: source.path().into(),
                top_k: 1,
                max_snippet_lines: Some(1),
                content: vec![ContentType::Code],
            })
            .unwrap();
        assert_eq!(response.results[0].file_path, "src/auth.rs");
        assert_eq!(
            response.results[0].content.as_deref(),
            Some("pub fn authenticate_request() {")
        );
    }

    #[test]
    fn bm25_recovers_lexical_matches_when_semantic_scores_are_tied() {
        let (source, _cache, engine) = fixture();
        fs::write(
            source.path().join("src/tracing.rs"),
            "pub fn write_record() {\n    let description = \"quasar chronicle telemetry durable\";\n}\n",
        )
        .unwrap();

        let response = engine
            .search(SearchRequest {
                query: "quasar chronicle telemetry durable".into(),
                repo: source.path().into(),
                top_k: 1,
                max_snippet_lines: Some(0),
                content: vec![ContentType::Code],
            })
            .unwrap();

        assert_eq!(response.results[0].file_path, "src/tracing.rs");
    }

    #[test]
    fn complete_multi_term_matches_rank_ahead_of_inferred_definitions() {
        let (source, cache, engine) = fixture();
        fs::write(
            source.path().join("src/definitions.rs"),
            "pub fn quasar_chronicle() {}\npub fn telemetry_durable() {}\n",
        )
        .unwrap();
        fs::write(
            source.path().join("src/literal.rs"),
            "pub fn diagnostic() {\n    let message = \"quasar chronicle telemetry durable\";\n}\n",
        )
        .unwrap();
        engine.prepare(source.path(), &[ContentType::Code]).unwrap();
        drop(engine);
        let engine =
            SearchEngine::with_embedder(SembleConfig::new(cache.path()), Arc::new(KeywordEmbedder));

        let response = engine
            .search(SearchRequest {
                query: "quasar chronicle telemetry durable".into(),
                repo: source.path().into(),
                top_k: 5,
                max_snippet_lines: Some(0),
                content: vec![ContentType::Code],
            })
            .unwrap();

        assert_eq!(response.results[0].file_path, "src/literal.rs");
        assert!(response
            .results
            .iter()
            .any(|result| result.file_path == "src/definitions.rs"));
    }

    #[test]
    fn qualified_methods_resolve_to_their_own_declarations_after_reopening() {
        let (source, cache, engine) = fixture();
        fs::write(
            source.path().join("src/workers.ts"),
            "export class AReporter {\n  run() { return 'report'; }\n}\n\nexport class ZWorker {\n  run() { return 'work'; }\n}\n",
        )
        .unwrap();
        fs::write(
            source.path().join("src/callers.ts"),
            "// ZWorker.run AReporter.run\nexport const description = 'ZWorker.run';\n",
        )
        .unwrap();
        engine.prepare(source.path(), &[ContentType::Code]).unwrap();
        drop(engine);
        let reopened =
            SearchEngine::with_embedder(SembleConfig::new(cache.path()), Arc::new(KeywordEmbedder));

        for (query, line, snippet) in [
            ("ZWorker.run", 6, "  run() { return 'work'; }"),
            ("AReporter.run", 2, "  run() { return 'report'; }"),
        ] {
            let response = reopened
                .search(SearchRequest::new(query, source.path()))
                .unwrap();
            let locations: Vec<_> = response
                .results
                .iter()
                .map(|hit| {
                    (
                        hit.file_path.as_str(),
                        hit.start_line,
                        hit.end_line,
                        hit.content.as_deref(),
                    )
                })
                .collect();
            assert_eq!(locations, [("src/workers.ts", line, line, Some(snippet))]);
        }
    }

    #[test]
    fn qualified_declarations_keep_scope_and_do_not_hide_same_names_in_other_files() {
        let (source, _cache, engine) = fixture();
        fs::write(
            source.path().join("src/first.py"),
            "class Outer:\n    class Runner:\n        @staticmethod\n        def run():\n            return 1\n",
        )
        .unwrap();
        fs::write(
            source.path().join("src/second.py"),
            "class Outer:\n    class Runner:\n        def run(self):\n            return 2\n",
        )
        .unwrap();
        fs::write(
            source.path().join("src/decoy.py"),
            "class Runner:\n    def run(self):\n        return 3\n",
        )
        .unwrap();
        let response = engine
            .search(SearchRequest::new("Outer.Runner.run", source.path()))
            .unwrap();
        let locations: Vec<_> = response
            .results
            .iter()
            .map(|hit| (hit.file_path.as_str(), hit.start_line, hit.end_line))
            .collect();
        assert_eq!(locations, [("src/first.py", 4, 5), ("src/second.py", 3, 4)]);
    }

    #[test]
    fn prepare_reports_the_persisted_index_shape() {
        let (source, _cache, engine) = fixture();
        let stats = engine.prepare(source.path(), &[ContentType::Code]).unwrap();
        assert_eq!(stats.file_count, 2);
        assert_eq!(stats.chunk_count, 2);
        assert!(stats.source_bytes > 0);
        assert_eq!(stats.dimensions, 3);
    }

    #[test]
    fn disk_loaded_indexes_read_result_snippets_from_source() {
        let (source, cache, engine) = fixture();
        engine.prepare(source.path(), &[ContentType::Code]).unwrap();
        drop(engine);
        let reloaded =
            SearchEngine::with_embedder(SembleConfig::new(cache.path()), Arc::new(KeywordEmbedder));
        let response = reloaded
            .search(SearchRequest {
                query: "authenticate request".into(),
                repo: source.path().into(),
                top_k: 1,
                max_snippet_lines: Some(1),
                content: vec![ContentType::Code],
            })
            .unwrap();
        assert_eq!(
            response.results[0].content.as_deref(),
            Some("pub fn authenticate_request() {")
        );
    }

    #[test]
    fn disk_loaded_indexes_retain_bm25_search() {
        let (source, cache, engine) = fixture();
        fs::write(
            source.path().join("src/tracing.rs"),
            "pub fn write_record() {\n    let description = \"quasar chronicle telemetry durable\";\n}\n",
        )
        .unwrap();
        engine.prepare(source.path(), &[ContentType::Code]).unwrap();
        drop(engine);
        let reloaded =
            SearchEngine::with_embedder(SembleConfig::new(cache.path()), Arc::new(KeywordEmbedder));

        let response = reloaded
            .search(SearchRequest {
                query: "quasar chronicle telemetry durable".into(),
                repo: source.path().into(),
                top_k: 1,
                max_snippet_lines: Some(0),
                content: vec![ContentType::Code],
            })
            .unwrap();

        assert_eq!(response.results[0].file_path, "src/tracing.rs");
    }

    #[test]
    fn explicit_refresh_makes_modified_files_searchable_during_the_cache_window() {
        let (source, _cache, engine) = fixture();
        engine.prepare(source.path(), &[ContentType::Code]).unwrap();
        fs::write(
            source.path().join("src/auth.rs"),
            "pub fn parse_request() {\n    parse_payload();\n    validate_fields();\n}\n",
        )
        .unwrap();

        let stale = engine
            .search(SearchRequest {
                query: "parse_request".into(),
                repo: source.path().into(),
                top_k: 1,
                max_snippet_lines: Some(3),
                content: vec![ContentType::Code],
            })
            .unwrap();
        assert!(!stale.results[0]
            .content
            .as_deref()
            .unwrap_or_default()
            .contains("parse_request"));

        engine.refresh(source.path(), &[ContentType::Code]).unwrap();
        let response = engine
            .search(SearchRequest {
                query: "parse_request".into(),
                repo: source.path().into(),
                top_k: 1,
                max_snippet_lines: Some(0),
                content: vec![ContentType::Code],
            })
            .unwrap();

        assert_eq!(response.results[0].file_path, "src/auth.rs");
        assert!(response.results[0].score >= 1.0);
    }

    #[test]
    fn explicit_refresh_makes_new_files_available_to_related_search() {
        let (source, _cache, engine) = fixture();
        engine.prepare(source.path(), &[ContentType::Code]).unwrap();
        fs::write(
            source.path().join("src/parser.rs"),
            "pub fn parse_document() {\n    parse_payload();\n}\n",
        )
        .unwrap();
        engine.refresh(source.path(), &[ContentType::Code]).unwrap();

        let response = engine
            .find_related(FindRelatedRequest {
                repo: source.path().into(),
                file_path: "src/parser.rs".into(),
                line: 1,
                top_k: 1,
                max_snippet_lines: Some(0),
                content: vec![ContentType::Code],
            })
            .unwrap();

        assert_eq!(response.results.len(), 1);
        assert_ne!(response.results[0].file_path, "src/parser.rs");
    }

    #[test]
    fn prepare_removes_deleted_files_from_the_index() {
        let (source, _cache, engine) = fixture();
        engine.prepare(source.path(), &[ContentType::Code]).unwrap();
        fs::remove_file(source.path().join("src/auth.rs")).unwrap();

        let stats = engine.prepare(source.path(), &[ContentType::Code]).unwrap();

        assert_eq!(stats.file_count, 1);
        assert_eq!(stats.chunk_count, 1);
    }

    #[test]
    fn related_search_excludes_the_source_chunk() {
        let (source, _cache, engine) = fixture();
        let response = engine
            .find_related(FindRelatedRequest {
                repo: source.path().into(),
                file_path: "src/auth.rs".into(),
                line: 1,
                top_k: 1,
                max_snippet_lines: Some(2),
                content: vec![ContentType::Code],
            })
            .unwrap();
        assert_eq!(response.results.len(), 1);
        assert_ne!(response.results[0].file_path, "src/auth.rs");
    }

    #[test]
    fn a_documented_behavior_returns_its_implementation_among_the_first_two_snippets() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let prose =
            "/** A dormant lease is renewed before its holder can spend the reserved balance. */";
        fs::write(
            source.path().join("ledger.ts"),
            format!(
                "{prose}\nexport function apply(entry: Entry) {{ return entry.transfer(); }}\n"
            ),
        )
        .unwrap();
        fs::write(source.path().join("notes.ts"), format!("{prose}\n")).unwrap();
        let mut config = SembleConfig::new(cache.path());
        config.desired_chunk_bytes = 60;
        for engine in [
            SearchEngine::with_embedder(config.clone(), Arc::new(KeywordEmbedder)),
            SearchEngine::with_embedder(config, Arc::new(KeywordEmbedder)),
        ] {
            let mut request = SearchRequest::new(
                "where is a dormant lease renewed before spending a reserved balance",
                source.path(),
            );
            request.top_k = 2;
            let hits = engine.search(request).unwrap().results;
            assert!(
                hits.iter().any(|r| r.file_path == "ledger.ts"
                    && r.content.as_deref().unwrap().contains("function apply")),
                "only found {:?}",
                hits.iter()
                    .map(|r| (&r.file_path, r.start_line, r.end_line))
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn natural_language_can_find_a_declaration_from_a_split_function_body() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(
            source.path().join("pipeline.rs"),
            concat!(
                "fn execute_pipeline() {\n",
                "    let state = read_input();\n",
                "    let token = read_token();\n",
                "    let result = enforce_authentication_policy(token);\n",
                "    complete(state, result);\n",
                "}\n",
                "fn unrelated() { publish_metric(); }\n",
            ),
        )
        .unwrap();
        let mut config = SembleConfig::new(cache.path());
        config.desired_chunk_bytes = 65;
        for engine in [
            SearchEngine::with_embedder(config.clone(), Arc::new(KeywordEmbedder)),
            SearchEngine::with_embedder(config, Arc::new(KeywordEmbedder)),
        ] {
            let mut request = SearchRequest::new(
                "where does the authentication policy take effect",
                source.path(),
            );
            request.top_k = 1;
            let results = engine.search(request).unwrap().results;
            assert_eq!(results[0].start_line, 1);
            assert!(results[0]
                .content
                .as_deref()
                .unwrap()
                .contains("fn execute_pipeline"));
        }
    }

    #[test]
    fn exact_lookup_finds_typed_definitions_before_unrelated_mentions() {
        let (source, _cache, engine) = fixture();
        let cases = [
            ("src/reader.h", "extract_frame", "template<typename T>\nT& extract_frame(T& frame) { return frame; }\n"),
            ("src/Decoder.java", "decodeFrame", "class Decoder {\n  public byte[] decodeFrame(byte[] buffer) { return buffer; }\n}\n"),
            ("src/decoder.go", "ReadFrame", "package file\nfunc (d *Decoder) ReadFrame(buffer []byte) []byte { return buffer }\n"),
        ];
        for (path, symbol, contents) in cases {
            fs::write(source.path().join(path), contents).unwrap();
            fs::write(
                source.path().join(format!("src/{symbol}_references.rs")),
                format!("fn references() {{\n    {symbol}();\n}}\n"),
            )
            .unwrap();
        }
        for (path, symbol, _) in cases {
            let mut request = SearchRequest::new(symbol, source.path());
            request.top_k = 1;
            let hits = engine.search(request).unwrap().results;
            assert_eq!(
                hits[0].file_path, path,
                "{symbol} must match its definition, not a mention"
            );
            assert!(
                hits[0].score >= 1.0,
                "{symbol} must be in the definition index"
            );
            assert!(hits[0].start_line <= 2 && hits[0].end_line >= 2);
        }
    }

    #[test]
    fn top_k_preserves_full_ranking_order_at_ties_and_zero_boundaries() {
        let scores = [0.0, 2.0, 1.0, 2.0, -4.0, 2.0, 1.0];
        let positive = [1, 3, 5, 2, 6];
        let all = [1, 3, 5, 2, 6, 0, 4];
        for limit in 0..=scores.len() + 1 {
            assert_eq!(
                rank_scores(&scores, limit, false),
                all[..limit.min(all.len())]
            );
            assert_eq!(
                rank_scores(&scores, limit, true),
                positive[..limit.min(positive.len())]
            );
        }
    }

    #[test]
    fn invalid_queries_fail_before_indexing() {
        let (_source, _cache, engine) = fixture();
        let request = SearchRequest::new("", "/missing");
        assert!(matches!(
            engine.search(request),
            Err(Error::InvalidRequest(_))
        ));
    }

    #[test]
    fn distinguishes_literal_fragments_from_behavior_queries() {
        assert!(is_literal_query("Semble Code Search"));
        assert!(is_literal_query(
            "MCP tool not found server not found permission denied"
        ));
        assert!(!is_literal_query(
            "dispatch built-in MCP tool calls to the registered server implementation"
        ));
        assert!(!is_literal_query("create a concurrent React DOM root"));
    }
}
