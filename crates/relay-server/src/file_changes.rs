use crate::protocol::FileChangeDiffView;

pub(crate) fn merge_file_change_diff(existing: &str, incoming: &str) -> String {
    match (existing.trim(), incoming.trim()) {
        ("", "") => String::new(),
        ("", incoming) => incoming.to_string(),
        (existing, "") => existing.to_string(),
        (existing, incoming) if existing == incoming => existing.to_string(),
        (existing, incoming) if existing.contains(incoming) => existing.to_string(),
        (existing, incoming) if incoming.contains(existing) => incoming.to_string(),
        (existing, incoming) => format!("{existing}\n{incoming}"),
    }
}

pub(crate) fn merge_file_change_view(
    file_changes: &mut Vec<FileChangeDiffView>,
    incoming: FileChangeDiffView,
) {
    if let Some(existing) = file_changes
        .iter_mut()
        .find(|change| change.path == incoming.path)
    {
        let merged_diff = merge_file_change_diff(&existing.diff, &incoming.diff);
        if !merged_diff.is_empty() || existing.diff.is_empty() {
            existing.diff = merged_diff;
        }
        if existing.change_type == "update" && incoming.change_type != "update" {
            existing.change_type = incoming.change_type;
        }
        return;
    }

    file_changes.push(incoming);
}
