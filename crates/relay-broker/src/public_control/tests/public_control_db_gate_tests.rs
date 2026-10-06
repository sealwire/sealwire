use super::*;

#[test]
fn public_db_config_rejects_unbounded_values() {
    let invalid_connections = PublicControlDbConfig {
        max_connections: 0,
        ..PublicControlDbConfig::default()
    };
    assert!(invalid_connections.validate().is_err());

    let invalid_concurrency = PublicControlDbConfig {
        concurrency: 129,
        ..PublicControlDbConfig::default()
    };
    assert!(invalid_concurrency.validate().is_err());

    let invalid_timeout = PublicControlDbConfig {
        query_timeout: Duration::ZERO,
        ..PublicControlDbConfig::default()
    };
    assert!(invalid_timeout.validate().is_err());
}

#[tokio::test]
async fn public_db_gate_refuses_when_full_without_queueing() {
    let gate = PublicControlDbGate::new(1, Duration::from_secs(1)).expect("valid gate");
    let _held = gate
        .permits
        .clone()
        .try_acquire_owned()
        .expect("first permit");
    let result = gate.run(async { Ok::<_, String>(()) }).await;
    assert!(matches!(result, Err(PublicControlDbGateError::Busy)));
}

#[tokio::test]
async fn concurrent_spare_work_never_holds_more_than_a_quarter_of_the_gate() {
    let gate = PublicControlDbGate::new(8, Duration::from_secs(5)).expect("valid gate");
    let release = Arc::new(tokio::sync::Notify::new());
    let probes = (0..8)
        .map(|_| {
            let gate = gate.clone();
            let release = release.clone();
            tokio::spawn(async move {
                gate.run_spare(async move {
                    release.notified().await;
                    Ok::<_, String>(())
                })
                .await
            })
        })
        .collect::<Vec<_>>();
    tokio::time::sleep(Duration::from_millis(20)).await;
    let free = gate.permits.available_permits();
    release.notify_waiters();
    for probe in probes {
        let _ = probe.await;
    }
    assert!(
        free >= 6,
        "concurrent spare work left {free} of 8 permits for writes and reloads"
    );
}

#[tokio::test]
async fn public_db_gate_bounds_operation_time() {
    let gate = PublicControlDbGate::new(1, Duration::from_millis(5)).expect("valid gate");
    let result = gate
        .run(async {
            std::future::pending::<()>().await;
            Ok::<_, String>(())
        })
        .await;
    assert!(matches!(result, Err(PublicControlDbGateError::Timeout)));
}
