//! Exposes provider-independent search capabilities.
mod cache;
mod exa;
mod fetch;

pub use cache::{WebCache, WebCacheEntry};
pub use exa::{SearchError, SearchHit, WebSearch};
pub use fetch::{FetchError, FetchedPage, WebFetch};
