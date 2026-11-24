//! Incremental BM25 document data and a compact runtime inverted index.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use super::{IndexedFile, IndexedLexicalDocument, IndexedTermFrequency};
use crate::index::tokenize;

const K1: f32 = 1.5;
const B: f32 = 0.75;

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Posting {
    document: usize,
    frequency: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Bm25Match {
    pub document: usize,
    pub score: f32,
    pub coverage: f32,
}

#[derive(Deserialize, Serialize)]
pub struct Bm25Index {
    document_lengths: Vec<u32>,
    average_document_length: f32,
    postings: HashMap<String, Vec<Posting>>,
}

impl Bm25Index {
    pub fn from_files(files: &mut [IndexedFile]) -> Self {
        let document_count = files
            .iter()
            .map(|file| file.lexical_documents.len())
            .sum::<usize>();
        let mut document_lengths = Vec::with_capacity(document_count);
        let mut postings = HashMap::<String, Vec<Posting>>::new();
        for file in files {
            for document in std::mem::take(&mut file.lexical_documents) {
                let position = document_lengths.len();
                document_lengths.push(document.length);
                for term in document.terms {
                    let posting = Posting {
                        document: position,
                        frequency: term.frequency,
                    };
                    postings.entry(term.term).or_default().push(posting);
                }
            }
        }
        let total_length = document_lengths
            .iter()
            .map(|length| u64::from(*length))
            .sum::<u64>();
        let average_document_length = if document_lengths.is_empty() {
            0.0
        } else {
            total_length as f32 / document_lengths.len() as f32
        };
        Self {
            document_lengths,
            average_document_length,
            postings,
        }
    }

    pub(crate) fn search(&self, query: &str, limit: usize) -> Vec<Bm25Match> {
        if limit == 0 || self.document_lengths.is_empty() {
            return Vec::new();
        }
        // Accumulate floating-point scores in the same term order every time.
        let mut query_terms = BTreeMap::<String, u32>::new();
        for term in tokenize(query) {
            *query_terms.entry(term).or_default() += 1;
        }
        let corpus_size = self.document_lengths.len() as f32;
        let average_length = self.average_document_length.max(f32::EPSILON);
        let mut scores = vec![(0.0_f32, 0.0_f32); self.document_lengths.len()];
        let mut touched = Vec::new();
        let mut query_weight = 0.0;
        for (term, query_frequency) in query_terms {
            let postings = self.postings.get(&term);
            let document_frequency = postings.map_or(0.0, |values| values.len() as f32);
            let inverse_document_frequency =
                (1.0 + (corpus_size - document_frequency + 0.5) / (document_frequency + 0.5)).ln();
            query_weight += inverse_document_frequency;
            let Some(postings) = postings.filter(|_| inverse_document_frequency > 0.0) else {
                continue;
            };
            let weight = query_frequency as f32 * inverse_document_frequency;
            for posting in postings {
                let term_frequency = posting.frequency as f32;
                let document_length = self.document_lengths[posting.document] as f32;
                let normalized_frequency = term_frequency
                    / (K1 * (1.0 - B + B * document_length / average_length) + term_frequency);
                let (score, matched_weight) = &mut scores[posting.document];
                if *matched_weight == 0.0 {
                    touched.push(posting.document);
                }
                *score += weight * normalized_frequency;
                *matched_weight += inverse_document_frequency;
            }
        }
        let order = |left: &usize, right: &usize| {
            scores[*right]
                .0
                .total_cmp(&scores[*left].0)
                .then_with(|| left.cmp(right))
        };
        if limit < touched.len() {
            touched.select_nth_unstable_by(limit, order);
            touched.truncate(limit);
        }
        touched.sort_unstable_by(order);
        let query_weight = query_weight.max(f32::EPSILON);
        touched
            .into_iter()
            .map(|document| {
                let (score, matched_weight) = scores[document];
                Bm25Match {
                    document,
                    score,
                    coverage: matched_weight / query_weight,
                }
            })
            .collect()
    }

    pub(crate) fn validate(&self, chunks: usize) -> bool {
        self.document_lengths.len() == chunks
            && self
                .postings
                .values()
                .flatten()
                .all(|posting| posting.document < chunks && posting.frequency > 0)
    }
}

pub fn lexical_document(content: &str) -> IndexedLexicalDocument {
    let tokens = tokenize(content);
    let length = u32::try_from(tokens.len()).unwrap_or(u32::MAX);
    let mut counts = HashMap::<String, u32>::new();
    for token in tokens {
        *counts.entry(token).or_default() += 1;
    }
    let mut terms = counts
        .into_iter()
        .map(|(term, frequency)| IndexedTermFrequency { term, frequency })
        .collect::<Vec<_>>();
    terms.sort_by(|left, right| left.term.cmp(&right.term));
    IndexedLexicalDocument { length, terms }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{source::FileStamp, Chunk, ContentType};

    fn indexed_file(contents: &[&str]) -> IndexedFile {
        let chunks = contents
            .iter()
            .enumerate()
            .map(|(index, content)| Chunk {
                file_path: "src/lib.rs".into(),
                start_line: index + 1,
                end_line: index + 1,
                language: Some("rust".into()),
                content: (*content).into(),
            })
            .collect::<Vec<_>>();
        IndexedFile {
            path: "src/lib.rs".into(),
            stamp: FileStamp {
                modified_ns: 1,
                size: 1,
            },
            content_type: ContentType::Code,
            lexical_documents: chunks
                .iter()
                .map(|chunk| lexical_document(&chunk.content))
                .collect(),
            chunks,
            definitions: Vec::new(),
            declarations: Vec::new(),
            function_anchors: vec![None; contents.len()],
            vectors: Vec::new(),
        }
    }

    #[test]
    fn ranks_identifier_aware_lexical_matches_and_excludes_zero_scores() {
        let file = indexed_file(&[
            "fn parseConfig() { parse_config(); }",
            "fn authenticate() { verify_token(); }",
            "fn parse_document() {}",
        ]);
        let index = Bm25Index::from_files(&mut [file]);
        let matches = index.search("parse config", 3);
        assert_eq!(
            matches
                .iter()
                .map(|matched| matched.document)
                .collect::<Vec<_>>(),
            vec![0, 2]
        );
        assert_eq!(matches[0].coverage, 1.0);
        assert!(matches[1].coverage < matches[0].coverage);
        assert!(index.search("missing_identifier", 3).is_empty());
    }

    #[test]
    fn a_numeric_literal_distinguishes_otherwise_identical_operations() {
        let mut files = [indexed_file(&["retry_after(15)", "retry_after(90)"])];
        let index = Bm25Index::from_files(&mut files);
        assert_eq!(index.search("retry after 90 seconds", 1)[0].document, 1);
        assert!(index.search("900", 2).is_empty());
    }

    #[test]
    fn repeated_searches_return_identical_bm25_scores_and_coverage() {
        let file = indexed_file(&[
            "package keyed queue start retry throttle backoff",
            "package keyed queue queue start retry",
            "package keyed queue queue",
            "package keyed throttle",
            "package backoff backoff backoff",
            "package",
        ]);
        let index = Bm25Index::from_files(&mut [file]);
        let expected = index.search(
            "retry queue backoff keyed package start throttle queue missing",
            3,
        );
        assert_eq!(expected[0].document, 0);
        for _ in 0..32 {
            assert_eq!(
                index.search(
                    "retry queue backoff keyed package start throttle queue missing",
                    3
                ),
                expected,
            );
        }
    }

    #[test]
    fn lexical_documents_store_sorted_term_frequencies() {
        let document = lexical_document("parseConfig parse_config");
        assert_eq!(document.length, 6);
        assert!(document
            .terms
            .windows(2)
            .all(|terms| terms[0].term < terms[1].term));
        assert_eq!(
            document
                .terms
                .iter()
                .find(|term| term.term == "parse")
                .map(|term| term.frequency),
            Some(2)
        );
    }
}
