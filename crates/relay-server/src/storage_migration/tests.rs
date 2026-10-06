use std::path::{Path, PathBuf};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use rusqlite::Connection;

use super::*;

const CONTROL: &str = "https://cloud.example";
const IDENTITY_SEED: [u8; 32] = [3; 32];
const VAPID_SCALAR: [u8; 32] = [1; 32];

/// An older build's state directory: session.json, the identity files, the push key and
/// a schema-16 database holding history only the database had.
struct OldRelay {
    _dir: tempfile::TempDir,
    paths: MigrationPaths,
}

impl OldRelay {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".agent-relay");
        std::fs::create_dir_all(&root).unwrap();
        let paths = MigrationPaths {
            session: root.join("session.json"),
            broker: crate::broker::LegacyBrokerFiles {
                registration: root.join("public-broker-registration.json"),
                identity: root.join("public-broker-identity.json"),
                content_identity: root.join("relay-content-identity.json"),
            },
            vapid: root.join("vapid.key"),
            db: root.join("sealwire.db"),
            move_from: None,
        };

        let mut session: serde_json::Value = serde_json::from_str(include_str!(
            "../state/fixtures/team_run_legacy_session.json"
        ))
        .unwrap();
        session["paired_devices"] = serde_json::json!({
            "phone-1": {
                "device_id": "phone-1",
                "label": "Phone",
                "payload_secret": "payload-secret-phone-1",
                "device_verify_key": "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
                "created_at": 7,
                "last_seen_at": 9,
                "last_peer_id": "surface-1",
            }
        });
        session["projects"] = serde_json::json!({ "p1": { "id": "p1", "name": "Kept project" } });
        session["thread_project_id"] = serde_json::json!({ "thread-legacy": "p1" });
        session["transcript_clock"] = serde_json::json!(123_456);
        std::fs::write(&paths.session, serde_json::to_vec_pretty(&session).unwrap()).unwrap();

        std::fs::write(
            &paths.broker.identity,
            serde_json::json!({
                "schema_version": 1,
                "control_url": CONTROL,
                "relay_signing_seed": STANDARD.encode(IDENTITY_SEED),
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            &paths.broker.registration,
            serde_json::json!({
                "schema_version": 1,
                "control_url": CONTROL,
                "relay_id": "relay-1",
                "broker_room_id": "room-1",
                "relay_refresh_token": "refresh-secret",
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(&paths.vapid, URL_SAFE_NO_PAD.encode(VAPID_SCALAR)).unwrap();

        // A schema-16 database: the history tables, with rows only it has.
        let store = crate::usage::store::UsageStore::open(&paths.db);
        store.record(&crate::usage::store::TokenEvent {
            at: 1,
            provider: "codex".to_string(),
            thread_id: "thread-legacy".to_string(),
            ..Default::default()
        });
        drop(store);
        let conn = Connection::open(&paths.db).unwrap();
        let mut drop_v17 = String::from("DROP TABLE meta; DROP TABLE credential;");
        for table in crate::state::CORE_ENTITY_TABLES {
            drop_v17.push_str(&format!("DROP TABLE {table};"));
        }
        drop_v17.push_str(
            "INSERT INTO fork_mark (id, body, created_at) VALUES ('fork-1', '{}', 1);
             PRAGMA user_version = 16;",
        );
        conn.execute_batch(&drop_v17).unwrap();
        drop(conn);

        Self { _dir: dir, paths }
    }

    fn old_files(&self) -> Vec<(PathBuf, Vec<u8>)> {
        self.paths
            .sources()
            .iter()
            .filter(|path| path.exists())
            .map(|path| (path.to_path_buf(), std::fs::read(path).unwrap()))
            .collect()
    }

    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.paths.db.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".importing-") || name.contains(".pre-import-"))
            .collect()
    }
}

fn count(db: &Path, sql: &str) -> i64 {
    Connection::open(db)
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

fn user_version(db: &Path) -> i64 {
    count(db, "PRAGMA user_version")
}

#[tokio::test]
async fn an_import_keeps_state_identity_and_history_and_leaves_the_old_files() {
    let old = OldRelay::new();
    let before = old.old_files();

    let report = import(&old.paths).expect("import");

    assert!(!report.contains("refresh-secret"), "{report}");
    assert!(!report.contains("payload-secret-phone-1"), "{report}");
    let db = &old.paths.db;
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM paired_device WHERE key = 'phone-1'"
        ),
        1
    );
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM credential WHERE kind = 'device_payload' \
             AND secret = 'payload-secret-phone-1'"
        ),
        1
    );
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM job_team_run WHERE body LIKE '%CANARY_TASK_TITLE%'"
        ),
        1
    );
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM project WHERE body LIKE '%Kept project%'"
        ),
        1
    );
    assert_eq!(
        count(db, "SELECT COUNT(*) FROM token_event"),
        1,
        "history kept"
    );
    assert_eq!(count(db, "SELECT COUNT(*) FROM fork_mark"), 1, "cards kept");
    assert!(
        count(
            db,
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'transcript_clock_ceiling'"
        ) >= 123_456,
        "the revision clock must resume above what clients already hold"
    );

    // The relay finds the same identity, registration and push key it had.
    let registration = crate::broker::load_public_relay_registration_raw(db)
        .unwrap()
        .expect("registration");
    assert_eq!(registration.relay_id(), "relay-1");
    let config = crate::broker::BrokerConfig::from_parts(
        Some("wss://broker.example".to_string()),
        None,
        Some(CONTROL.to_string()),
        Some("room-1".to_string()),
        Some("relay-peer".to_string()),
        Some("public".to_string()),
        None,
        Some("relay-1".to_string()),
        Some("refresh-secret".to_string()),
        Some(db.display().to_string()),
        None,
    )
    .await
    .expect("config")
    .expect("enabled");
    assert_eq!(
        config.content_verify_key(),
        STANDARD.encode(
            ed25519_dalek::SigningKey::from_bytes(&IDENTITY_SEED)
                .verifying_key()
                .to_bytes()
        )
    );
    let store = crate::state::open_state_database(db).expect("the relay may start");
    let vapid = crate::state::load_or_generate_vapid(&store).unwrap();
    let expected = p256::ecdsa::SigningKey::from_slice(&VAPID_SCALAR).unwrap();
    assert_eq!(
        vapid.public_b64url(),
        URL_SAFE_NO_PAD.encode(expected.verifying_key().to_encoded_point(false).as_bytes())
    );

    assert_eq!(
        old.old_files(),
        before,
        "the first run leaves the old files as they were"
    );
    assert_eq!(
        old.leftovers().len(),
        1,
        "only the copy from before the import remains"
    );
}

#[test]
fn running_the_import_again_changes_nothing() {
    let old = OldRelay::new();
    import(&old.paths).expect("import");
    let rows = count(&old.paths.db, "SELECT COUNT(*) FROM relay_setting");

    let again = import(&old.paths).expect("a second run is not an error");

    assert!(again.contains("--finish"), "{again}");
    assert_eq!(
        count(&old.paths.db, "SELECT COUNT(*) FROM relay_setting"),
        rows
    );
    assert_eq!(old.leftovers().len(), 1);
}

#[test]
fn finish_removes_the_old_files_and_the_copy_once() {
    let old = OldRelay::new();
    import(&old.paths).expect("import");

    finish_import(&old.paths).expect("finish");

    assert!(old.old_files().is_empty(), "{:?}", old.old_files());
    assert!(old.leftovers().is_empty(), "{:?}", old.leftovers());
    assert_eq!(
        count(
            &old.paths.db,
            "SELECT COUNT(*) FROM credential WHERE kind = 'public_registration'"
        ),
        1,
        "removing the old files leaves the imported state alone"
    );
    assert!(finish_import(&old.paths).unwrap().contains("already"));
}

// An older relay started between the two runs would have written state the database
// does not have; deleting its files would lose it.
#[test]
fn finish_refuses_when_an_old_file_changed_after_the_import() {
    let old = OldRelay::new();
    import(&old.paths).expect("import");
    std::fs::write(
        &old.old_files()[0].0,
        b"{\"written\":\"by an older relay\"}",
    )
    .unwrap();
    let before = old.old_files();

    let error = finish_import(&old.paths).expect_err("a changed file must stop the removal");

    assert!(error.contains("changed after it was imported"), "{error}");
    assert_eq!(old.old_files(), before, "nothing was removed");
    assert_eq!(
        old.leftovers().len(),
        1,
        "the copy from before the import is kept"
    );
}

#[test]
fn a_session_file_that_cannot_be_read_changes_nothing() {
    let old = OldRelay::new();
    std::fs::write(&old.paths.session, b"not json").unwrap();
    let database_before = std::fs::read(&old.paths.db).unwrap();

    let error = import(&old.paths).expect_err("an unreadable session must stop the import");

    assert!(error.contains("Nothing was changed"), "{error}");
    assert_eq!(user_version(&old.paths.db), 16);
    assert_eq!(std::fs::read(&old.paths.db).unwrap(), database_before);
    assert!(old.leftovers().is_empty(), "{:?}", old.leftovers());
}

#[test]
fn an_enrolled_relay_without_its_identity_is_not_imported() {
    let old = OldRelay::new();
    std::fs::remove_file(&old.paths.broker.identity).unwrap();

    let error = import(&old.paths).expect_err("a registration without its identity");

    assert!(error.contains("identity is missing"), "{error}");
    assert_eq!(user_version(&old.paths.db), 16);
    assert!(old.leftovers().is_empty(), "{:?}", old.leftovers());
}

#[test]
fn a_relay_without_a_database_yet_is_imported_into_a_new_one() {
    let old = OldRelay::new();
    std::fs::remove_file(&old.paths.db).unwrap();

    import(&old.paths).expect("import");

    assert_eq!(user_version(&old.paths.db), 17);
    assert_eq!(
        count(&old.paths.db, "SELECT COUNT(*) FROM paired_device"),
        1
    );
    assert!(old.leftovers().is_empty(), "{:?}", old.leftovers());
}

/// The default relay: `~/.agent-relay` moves whole to `~/.sealwire`, so the provider
/// data kept beside the state comes along, and the import then happens there.
#[test]
fn the_default_relay_moves_its_directory_to_sealwire_first() {
    let old = OldRelay::new();
    let old_dir = old.paths.db.parent().unwrap().to_path_buf();
    let new_dir = old_dir.with_file_name(".sealwire");
    std::fs::create_dir_all(old_dir.join("cursor-data")).unwrap();
    std::fs::write(
        old_dir.join("cursor-data").join("agent.json"),
        b"provider data",
    )
    .unwrap();
    let paths = MigrationPaths {
        session: new_dir.join("session.json"),
        broker: crate::broker::LegacyBrokerFiles {
            registration: new_dir.join("public-broker-registration.json"),
            identity: new_dir.join("public-broker-identity.json"),
            content_identity: new_dir.join("relay-content-identity.json"),
        },
        vapid: new_dir.join("vapid.key"),
        db: new_dir.join("sealwire.db"),
        move_from: Some(old_dir.clone()),
    };

    let report = import(&paths).expect("import");

    assert!(report.contains("Moved"), "{report}");
    assert!(!old_dir.exists(), "the old directory is moved, not copied");
    assert_eq!(
        std::fs::read(new_dir.join("cursor-data").join("agent.json")).unwrap(),
        b"provider data"
    );
    assert_eq!(count(&paths.db, "SELECT COUNT(*) FROM paired_device"), 1);
    assert_eq!(
        count(&paths.db, "SELECT COUNT(*) FROM token_event"),
        1,
        "history kept"
    );
    assert!(
        paths.session.exists(),
        "the old files stay, in the new directory"
    );
    crate::state::open_state_database(&paths.db).expect("the relay may start");

    finish_import(&paths).expect("finish");
    assert!(!paths.session.exists());
    assert!(
        new_dir.join("cursor-data").exists(),
        "--finish leaves provider data alone"
    );
}

// A fresh ~/.sealwire beside an ~/.agent-relay that was never imported would start a new,
// empty relay and enroll a new identity.
#[test]
fn a_fresh_sealwire_directory_is_refused_while_the_old_one_waits() {
    let old = OldRelay::new();
    let new_db = old
        .paths
        .db
        .parent()
        .unwrap()
        .with_file_name(".sealwire")
        .join("sealwire.db");

    let error = crate::state::open_state_database(&new_db)
        .err()
        .expect("must refuse");

    assert!(error.contains("migrate-storage"), "{error}");
    assert!(error.contains(".agent-relay"), "{error}");
    assert!(!new_db.exists());
}

// A start that was refused, or a lock taken by a dev script, can leave ~/.sealwire with
// nothing but lock files. That is not state, and must not stop the move.
#[test]
fn a_sealwire_directory_holding_only_lock_files_does_not_block_the_move() {
    let old = OldRelay::new();
    let old_dir = old.paths.db.parent().unwrap().to_path_buf();
    let new_dir = old_dir.with_file_name(".sealwire");
    std::fs::create_dir_all(&new_dir).unwrap();
    std::fs::write(new_dir.join("sealwire.db.lock"), b"").unwrap();
    std::fs::write(new_dir.join("sealwire.db.owner.json"), b"{}").unwrap();
    let paths = MigrationPaths {
        session: new_dir.join("session.json"),
        broker: crate::broker::LegacyBrokerFiles {
            registration: new_dir.join("public-broker-registration.json"),
            identity: new_dir.join("public-broker-identity.json"),
            content_identity: new_dir.join("relay-content-identity.json"),
        },
        vapid: new_dir.join("vapid.key"),
        db: new_dir.join("sealwire.db"),
        move_from: Some(old_dir.clone()),
    };

    import(&paths).expect("lock files left behind are not state");

    assert!(!old_dir.exists());
    assert_eq!(count(&paths.db, "SELECT COUNT(*) FROM paired_device"), 1);
}

#[test]
fn a_sealwire_directory_holding_anything_else_stops_the_move() {
    let old = OldRelay::new();
    let old_dir = old.paths.db.parent().unwrap().to_path_buf();
    let new_dir = old_dir.with_file_name(".sealwire");
    std::fs::create_dir_all(&new_dir).unwrap();
    std::fs::write(new_dir.join("notes.txt"), b"someone else's").unwrap();
    let paths = MigrationPaths {
        session: new_dir.join("session.json"),
        broker: crate::broker::LegacyBrokerFiles {
            registration: new_dir.join("public-broker-registration.json"),
            identity: new_dir.join("public-broker-identity.json"),
            content_identity: new_dir.join("relay-content-identity.json"),
        },
        vapid: new_dir.join("vapid.key"),
        db: new_dir.join("sealwire.db"),
        move_from: Some(old_dir.clone()),
    };

    let error = import(&paths).expect_err("unknown files are not moved over");

    assert!(error.contains("notes.txt"), "{error}");
    assert!(old_dir.join("session.json").exists(), "nothing was moved");
}

/// Paths for the default relay, moving `old_dir` to `.sealwire` beside it.
fn moving_paths(old_dir: &Path) -> MigrationPaths {
    let new_dir = old_dir.with_file_name(".sealwire");
    MigrationPaths {
        session: new_dir.join("session.json"),
        broker: crate::broker::LegacyBrokerFiles {
            registration: new_dir.join("public-broker-registration.json"),
            identity: new_dir.join("public-broker-identity.json"),
            content_identity: new_dir.join("relay-content-identity.json"),
        },
        vapid: new_dir.join("vapid.key"),
        db: new_dir.join("sealwire.db"),
        move_from: Some(old_dir.to_path_buf()),
    }
}

// A credential path set explicitly into the directory being moved follows the move;
// otherwise the identity looks missing and a new one is enrolled.
#[test]
fn credential_paths_named_into_the_moved_directory_follow_it() {
    let old = OldRelay::new();
    let old_dir = old.paths.db.parent().unwrap().to_path_buf();
    let mut paths = moving_paths(&old_dir);
    paths.broker.identity = old_dir.join("public-broker-identity.json");
    paths.broker.registration = old_dir.join("public-broker-registration.json");
    paths.vapid = old_dir.join("vapid.key");

    import(&paths).expect("import");

    for kind in ["public_relay_identity", "public_registration", "vapid"] {
        assert_eq!(
            count(
                &paths.db,
                &format!("SELECT COUNT(*) FROM credential WHERE kind = '{kind}'")
            ),
            1,
            "{kind} must be imported from its new place"
        );
    }
}

// A database named elsewhere starts from the history the old relay kept beside its
// session file, not from nothing.
#[test]
fn a_database_named_elsewhere_keeps_the_history_kept_beside_the_session() {
    let old = OldRelay::new();
    let destination = tempfile::tempdir().unwrap();
    let mut paths = moving_paths(old.paths.db.parent().unwrap());
    paths.session = old.paths.session.clone();
    paths.broker = crate::broker::LegacyBrokerFiles {
        registration: old.paths.broker.registration.clone(),
        identity: old.paths.broker.identity.clone(),
        content_identity: old.paths.broker.content_identity.clone(),
    };
    paths.vapid = old.paths.vapid.clone();
    paths.db = destination.path().join("new.db");
    paths.move_from = None;
    let source_before = std::fs::read(&old.paths.db).unwrap();

    import(&paths).expect("import");

    assert_eq!(count(&paths.db, "SELECT COUNT(*) FROM token_event"), 1);
    assert_eq!(count(&paths.db, "SELECT COUNT(*) FROM fork_mark"), 1);
    assert_eq!(count(&paths.db, "SELECT COUNT(*) FROM paired_device"), 1);
    assert_eq!(
        std::fs::read(&old.paths.db).unwrap(),
        source_before,
        "the history it was copied from is left alone"
    );
}

#[test]
fn history_under_its_first_name_is_kept_when_the_database_is_named_elsewhere() {
    let old = OldRelay::new();
    std::fs::rename(&old.paths.db, old.paths.db.with_file_name("token-usage.db")).unwrap();
    let destination = tempfile::tempdir().unwrap();
    let mut paths = moving_paths(old.paths.db.parent().unwrap());
    paths.session = old.paths.session.clone();
    paths.broker = crate::broker::LegacyBrokerFiles {
        registration: old.paths.broker.registration.clone(),
        identity: old.paths.broker.identity.clone(),
        content_identity: old.paths.broker.content_identity.clone(),
    };
    paths.vapid = old.paths.vapid.clone();
    paths.db = destination.path().join("new.db");
    paths.move_from = None;

    import(&paths).expect("import");

    assert_eq!(count(&paths.db, "SELECT COUNT(*) FROM token_event"), 1);
}

// The same directory reached by two spellings is one lock, taken once.
#[cfg(unix)]
#[test]
fn a_registration_named_through_an_alias_of_the_same_directory_does_not_hang() {
    let old = OldRelay::new();
    let dir = old.paths.db.parent().unwrap().to_path_buf();
    let alias = dir.with_file_name("alias");
    std::os::unix::fs::symlink(&dir, &alias).unwrap();
    let mut paths = moving_paths(&dir);
    paths.session = old.paths.session.clone();
    paths.broker = crate::broker::LegacyBrokerFiles {
        registration: alias.join("public-broker-registration.json"),
        identity: old.paths.broker.identity.clone(),
        content_identity: old.paths.broker.content_identity.clone(),
    };
    paths.vapid = old.paths.vapid.clone();
    paths.db = old.paths.db.clone();
    paths.move_from = None;

    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(import(&paths));
    });
    finished
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the import waited on a lock it already held")
        .expect("import");
}

#[test]
fn an_empty_sealwire_directory_does_not_block_the_move() {
    let old = OldRelay::new();
    let old_dir = old.paths.db.parent().unwrap().to_path_buf();
    let paths = moving_paths(&old_dir);
    std::fs::create_dir_all(paths.db.parent().unwrap()).unwrap();

    import(&paths).expect("an empty directory is not in the way");

    assert!(!old_dir.exists());
}
