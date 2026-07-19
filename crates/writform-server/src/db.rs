use std::path::Path;

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

pub async fn connect(data_dir: &Path) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(data_dir.join("writform.db"))
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .context("opening sqlite database")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("running migrations")?;
    Ok(pool)
}

/// Current time as unix milliseconds — the timestamp format for every table.
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_millis() as i64
}
