use serde::{Deserialize, Serialize};
use ts_rs::TS;

macro_rules! id_type {
    ($name:ident) => {
        // Note: serde serializes newtype structs as the bare inner value, so
        // these are plain numbers on the wire.
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS,
        )]
        #[ts(export)]
        pub struct $name(#[ts(type = "number")] pub i64);

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

id_type!(UserId);
id_type!(GroupId);
id_type!(ChannelId);
id_type!(MessageId);
id_type!(AttachmentId);
id_type!(WritingSessionId);

/// Unix timestamp in milliseconds.
///
/// NOTE: annotate every `UnixMillis` field with `#[ts(type = "number")]` —
/// ts-rs otherwise emits `bigint`, but these are plain JSON numbers on the
/// wire (ms timestamps fit comfortably in an f64). The bindings export script
/// greps generated files and fails on `bigint`, so a forgotten annotation
/// breaks CI rather than the client.
pub type UnixMillis = i64;
