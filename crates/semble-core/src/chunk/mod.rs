//! Code-aware Tree-sitter chunking with a deterministic line-based fallback.

mod boundary;
mod line_fallback;
mod tree_sitter;

pub use boundary::ChunkBoundary;
pub use line_fallback::line_boundaries;
pub(crate) use tree_sitter::chunk_parsed_source;
pub use tree_sitter::chunk_source;
