// `AppState::usage_report` joins ledger sessions to titles the relay holds, through the
// same session list and rename a client uses.

use tempfile::TempDir;

use super::tests::path_scope_tests::{build_app, pair_device};
use super::AppState;
use crate::protocol::{RenameThreadInput, StartSessionInput};
use crate::usage::store::{TokenEvent, UsageStore};
use crate::usage::TokenUsage;

async fn start_fake_session(app: &AppState, cwd: &str, prompt: &str) -> String {
    app.start_session(StartSessionInput {
        device_id: Some("device-1".to_string()),
        cwd: Some(cwd.to_string()),
        model: Some("fake-echo".to_string()),
        effort: None,
        approval_policy: None,
        sandbox: None,
        provider: Some("fake".to_string()),
        initial_prompt: Some(prompt.to_string()),
        project_id: None,
    })
    .await
    .expect("start session")
    .active_thread_id
    .expect("thread id")
}

fn spend(at: u64, provider: &str, thread_id: &str, total: u64) -> TokenEvent {
    TokenEvent {
        at,
        provider: provider.to_string(),
        thread_id: thread_id.to_string(),
        usage: TokenUsage {
            total,
            ..TokenUsage::default()
        },
        ..TokenEvent::default()
    }
}

#[tokio::test]
async fn usage_sessions_carry_relay_titles_and_keep_sessions_the_relay_no_longer_lists() {
    let project = TempDir::new().expect("project tempdir");
    let cwd = project.path().to_str().unwrap();
    let (app, _p, _o) = build_app(cwd).await;
    pair_device(&app, "device-1", Vec::new()).await;

    let listed = start_fake_session(&app, cwd, "draft the release notes").await;
    let renamed = start_fake_session(&app, cwd, "first").await;
    app.rename_thread(
        &renamed,
        RenameThreadInput {
            name: Some("Budget work".to_string()),
            device_id: Some("device-1".to_string()),
        },
    )
    .await
    .expect("rename");
    let sidebar = app.list_threads(50, None).await.expect("list threads");
    let listed_row = sidebar
        .threads
        .iter()
        .find(|thread| thread.id == listed)
        .expect("the started session is listed");
    let listed_title = listed_row
        .name
        .clone()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| listed_row.preview.clone());
    assert!(!listed_title.is_empty());

    let ledger = TempDir::new().expect("ledger tempdir");
    let store = UsageStore::open(&ledger.path().join("sealwire.db"));
    let now = crate::state::unix_now();
    store.record(&spend(now, "fake", &listed, 700));
    store.record(&spend(now, "fake", &renamed, 900));
    store.record(&spend(now, "fake", "session-deleted-long-ago", 300));
    store.record(&spend(now, "codex", &listed, 50));
    app.relay.write().await.usage_store = store;

    let report = app
        .usage_report(now - 60, now + 60, "none", None)
        .await
        .expect("usage report");
    let rows: Vec<_> = report.sessions[0]
        .sessions
        .iter()
        .map(|s| {
            (
                s.provider.as_str(),
                s.thread_id.as_str(),
                s.title.as_deref(),
                s.total,
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            ("fake", renamed.as_str(), Some("Budget work"), 900),
            ("fake", listed.as_str(), Some(listed_title.as_str()), 700),
            ("fake", "session-deleted-long-ago", None, 300),
            ("codex", listed.as_str(), None, 50),
        ]
    );
}
