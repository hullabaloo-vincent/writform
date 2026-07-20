//! Shared wire types between the WritForm server and desktop client.
//!
//! Every request/response/WS-event type lives here, derives `serde` for the
//! JSON wire format and `ts_rs::TS` so TypeScript bindings are generated into
//! `apps/desktop/src/bindings/proto/` (see `just bindings` / CI drift guard).

pub mod api;
pub mod canvas;
pub mod chat;
pub mod documents;
pub mod friends;
pub mod ids;
pub mod sessions;
pub mod voice;
pub mod ws;

pub use ids::*;

/// Bump when the wire protocol changes incompatibly. The client sends it on
/// connect; the server rejects mismatches with a clear error.
pub const PROTOCOL_VERSION: u32 = 1;
