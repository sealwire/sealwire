use super::*;

#[test]
fn trims_and_drops_empty_values() {
    assert_eq!(
        trimmed_option_string(Some("  hello  ".to_string())).as_deref(),
        Some("hello")
    );
    assert_eq!(trimmed_option_string(Some("   ".to_string())), None);
    assert_eq!(
        trimmed_string("  world  ".to_string()).as_deref(),
        Some("world")
    );
}
