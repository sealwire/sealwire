pub fn trimmed_option_string(value: Option<String>) -> Option<String> {
    value.and_then(trimmed_string)
}

pub fn trimmed_string(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests;
