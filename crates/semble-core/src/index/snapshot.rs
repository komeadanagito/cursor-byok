//! Versioned binary snapshot format and flattened runtime representation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{config::INDEX_FORMAT_VERSION, source::FileStamp, Chunk, ContentType, Error, Result};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IndexedFile {
    pub path: String,
    pub stamp: FileStamp,
    pub content_type: ContentType,
    pub chunks: Vec<Chunk>,
    pub definitions: Vec<IndexedDefinition>,
    pub(crate) declarations: Vec<IndexedDeclaration>,
    pub function_anchors: Vec<Option<usize>>,
    pub lexical_documents: Vec<IndexedLexicalDocument>,
    /// Row-major signed-byte unit vectors, one row per chunk.
    pub vectors: Vec<i8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IndexedLexicalDocument {
    pub length: u32,
    pub terms: Vec<IndexedTermFrequency>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IndexedTermFrequency {
    pub term: String,
    pub frequency: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IndexedDefinition {
    pub symbol: String,
    pub chunk: usize,
    pub implementation: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct IndexedDeclaration {
    pub qualified_name: String,
    pub span: LineSpan,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub(crate) struct LineSpan {
    pub start: usize,
    pub end: usize,
}

impl LineSpan {
    fn is_valid(self) -> bool {
        self.start > 0 && self.start <= self.end
    }
}

#[derive(Deserialize, Serialize)]
pub(crate) struct DeclarationLocation {
    pub file: usize,
    pub span: LineSpan,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IndexSnapshot {
    pub format_version: u32,
    pub source_identity: String,
    pub model_id: String,
    pub dimensions: usize,
    pub desired_chunk_bytes: usize,
    pub content: Vec<ContentType>,
    pub files: Vec<IndexedFile>,
}

impl IndexSnapshot {
    pub fn validate(&self) -> Result<()> {
        if self.format_version != INDEX_FORMAT_VERSION {
            return Err(Error::CorruptIndex("format version mismatch".into()));
        }
        for file in &self.files {
            if file
                .definitions
                .iter()
                .any(|definition| definition.chunk >= file.chunks.len())
            {
                return Err(Error::CorruptIndex(format!(
                    "definition chunk is out of bounds in {}",
                    file.path
                )));
            }
            if file
                .declarations
                .iter()
                .any(|declaration| !declaration.span.is_valid())
            {
                return Err(Error::CorruptIndex(format!(
                    "invalid declaration span in {}",
                    file.path
                )));
            }
            if !valid_anchors(&file.function_anchors, file.chunks.len()) {
                return Err(Error::CorruptIndex(format!(
                    "invalid function anchors in {}",
                    file.path
                )));
            }
            if file.vectors.len() != file.chunks.len() * self.dimensions {
                return Err(Error::CorruptIndex(format!(
                    "chunk/vector count mismatch in {}",
                    file.path
                )));
            }
            if file.lexical_documents.len() != file.chunks.len() {
                return Err(Error::CorruptIndex(format!(
                    "chunk/lexical document count mismatch in {}",
                    file.path
                )));
            }
            for document in &file.lexical_documents {
                let mut previous = None;
                let mut length = 0_u64;
                for term in &document.terms {
                    if term.term.is_empty()
                        || term.frequency == 0
                        || previous.is_some_and(|value| value >= term.term.as_str())
                    {
                        return Err(Error::CorruptIndex(format!(
                            "invalid lexical document in {}",
                            file.path
                        )));
                    }
                    previous = Some(term.term.as_str());
                    length += u64::from(term.frequency);
                }
                if length != u64::from(document.length) {
                    return Err(Error::CorruptIndex(format!(
                        "lexical document length mismatch in {}",
                        file.path
                    )));
                }
            }
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
pub struct LoadedFile {
    pub path: String,
    pub stamp: FileStamp,
    pub content_type: ContentType,
}

#[derive(Deserialize, Serialize)]
pub struct LoadedMetadata {
    pub source_identity: String,
    pub model_id: String,
    pub dimensions: usize,
    pub desired_chunk_bytes: usize,
    pub content: Vec<ContentType>,
    pub files: Vec<LoadedFile>,
}

#[derive(Deserialize, Serialize)]
pub struct LoadedIndex {
    pub metadata: LoadedMetadata,
    pub chunks: Vec<Chunk>,
    pub vectors: Vec<i8>,
    pub function_anchors: Vec<Option<usize>>,
    pub lexical: super::SymbolIndex,
    pub(crate) declarations: BTreeMap<String, Vec<DeclarationLocation>>,
    pub bm25: super::Bm25Index,
}

impl LoadedIndex {
    pub fn from_snapshot(mut snapshot: IndexSnapshot) -> Result<Self> {
        snapshot.validate()?;
        let lexical = super::SymbolIndex::from_files(&mut snapshot.files);
        let bm25 = super::Bm25Index::from_files(&mut snapshot.files);
        let mut declarations = BTreeMap::<_, Vec<_>>::new();
        for (file, indexed) in snapshot.files.iter_mut().enumerate() {
            for declaration in std::mem::take(&mut indexed.declarations) {
                declarations
                    .entry(declaration.qualified_name)
                    .or_default()
                    .push(DeclarationLocation {
                        file,
                        span: declaration.span,
                    });
            }
        }
        let metadata = LoadedMetadata {
            source_identity: std::mem::take(&mut snapshot.source_identity),
            model_id: std::mem::take(&mut snapshot.model_id),
            dimensions: snapshot.dimensions,
            desired_chunk_bytes: snapshot.desired_chunk_bytes,
            content: std::mem::take(&mut snapshot.content),
            files: snapshot
                .files
                .iter_mut()
                .map(|file| LoadedFile {
                    path: std::mem::take(&mut file.path),
                    stamp: file.stamp,
                    content_type: file.content_type,
                })
                .collect(),
        };
        let chunks = snapshot
            .files
            .iter_mut()
            .flat_map(|file| std::mem::take(&mut file.chunks))
            .collect::<Vec<_>>();
        let mut offset = 0;
        let function_anchors = snapshot
            .files
            .iter_mut()
            .flat_map(|file| {
                let start = offset;
                offset += file.function_anchors.len();
                std::mem::take(&mut file.function_anchors)
                    .into_iter()
                    .map(move |anchor| anchor.map(|anchor| start + anchor))
            })
            .collect();
        let vectors = snapshot
            .files
            .iter_mut()
            .flat_map(|file| std::mem::take(&mut file.vectors))
            .collect::<Vec<_>>();
        Ok(Self {
            metadata,
            chunks,
            vectors,
            function_anchors,
            lexical,
            declarations,
            bm25,
        })
    }

    pub fn validate(&self) -> Result<()> {
        if self.metadata.dimensions == 0
            || self.vectors.len() != self.chunks.len() * self.metadata.dimensions
            || !valid_anchors(&self.function_anchors, self.chunks.len())
            || !self.lexical.validate(self.chunks.len())
            || self.declarations.values().flatten().any(|location| {
                location.file >= self.metadata.files.len() || !location.span.is_valid()
            })
            || !self.bm25.validate(self.chunks.len())
        {
            return Err(Error::CorruptIndex("invalid runtime index".into()));
        }
        Ok(())
    }
}

fn valid_anchors(anchors: &[Option<usize>], chunks: usize) -> bool {
    anchors.len() == chunks
        && anchors
            .iter()
            .enumerate()
            .all(|(chunk, anchor)| anchor.is_none_or(|anchor| anchor < chunks && anchor != chunk))
}

#[cfg(test)]
mod tests {
    use crate::source::FileStamp;

    use super::*;

    #[test]
    fn validation_rejects_vector_shape_mismatches() {
        let snapshot = IndexSnapshot {
            format_version: INDEX_FORMAT_VERSION,
            source_identity: "source".into(),
            model_id: "model".into(),
            dimensions: 2,
            desired_chunk_bytes: 100,
            content: vec![ContentType::Code],
            files: vec![IndexedFile {
                path: "lib.rs".into(),
                stamp: FileStamp {
                    modified_ns: 1,
                    size: 1,
                },
                content_type: ContentType::Code,
                chunks: vec![Chunk {
                    file_path: "lib.rs".into(),
                    start_line: 1,
                    end_line: 1,
                    language: Some("rust".into()),
                    content: "x".into(),
                }],
                definitions: Vec::new(),
                declarations: Vec::new(),
                function_anchors: vec![None],
                lexical_documents: vec![super::super::lexical_document("x")],
                vectors: vec![1],
            }],
        };
        assert!(matches!(snapshot.validate(), Err(Error::CorruptIndex(_))));
    }
}
