use super::*;

#[test]
fn startup_builds_a_missing_index_and_refuses_an_invalid_one() {
    assert!(matches!(
        superseded_index_step("public_device_grants", Some(true)),
        SupersededIndexStep::Ready
    ));
    assert!(matches!(
        superseded_index_step("public_device_grants", None),
        SupersededIndexStep::Build
    ));
    let SupersededIndexStep::Refuse(message) =
        superseded_index_step("public_device_grants", Some(false))
    else {
        panic!("an invalid index must stop startup, not fall back to scanning");
    };
    assert!(
        message.contains("DROP INDEX CONCURRENTLY IF EXISTS public_device_grants_superseded_idx")
    );
    assert!(message.contains(&superseded_index_sql("public_device_grants")));
}

/// The planner only uses an expression index for the same expression.
#[test]
fn the_probe_filters_on_the_indexed_expression() {
    for table in ["public_device_grants", "public_client_identities"] {
        assert!(
            superseded_index_sql(table).contains(&format!("(({SUPERSEDED_JSONB}) jsonb_path_ops)"))
        );
        assert!(superseded_probe_sql(table).contains(&format!("{SUPERSEDED_JSONB} @> $2::jsonb")));
    }
}
