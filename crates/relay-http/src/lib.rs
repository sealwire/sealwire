use axum::http::{header, header::HeaderName, HeaderMap, HeaderValue, Uri};

pub const DEFAULT_CONNECT_SRC: &str = "'self' http: https: ws: wss:";
pub const DEFAULT_HSTS_VALUE: &str = "max-age=31536000; includeSubDomains";
pub const PERMISSIONS_POLICY: &str = "accelerometer=(), ambient-light-sensor=(), autoplay=(), bluetooth=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), usb=(), web-share=(), xr-spatial-tracking=()";
pub const REFERRER_POLICY: &str = "no-referrer";
pub const X_CONTENT_TYPE_OPTIONS: &str = "nosniff";

#[derive(Clone, Debug)]
pub struct SecurityHeadersConfig {
    pub enable_hsts: bool,
    pub content_security_policy: HeaderValue,
    pub strict_transport_security: HeaderValue,
}

impl Default for SecurityHeadersConfig {
    fn default() -> Self {
        Self::from_parts(false, None, None, "CSP_CONNECT_SRC", "HSTS_VALUE")
            .expect("default security headers config should be valid")
    }
}

impl SecurityHeadersConfig {
    pub fn from_parts(
        enable_hsts: bool,
        connect_src: Option<String>,
        hsts_value: Option<String>,
        csp_env_name: &str,
        hsts_env_name: &str,
    ) -> Result<Self, String> {
        let values = validated_security_header_values(
            connect_src.as_deref(),
            hsts_value.as_deref(),
            csp_env_name,
            hsts_env_name,
        )?;

        Ok(Self {
            enable_hsts,
            content_security_policy: values.content_security_policy,
            strict_transport_security: values.strict_transport_security,
        })
    }
}

pub fn request_uses_https(headers: &HeaderMap, uri: Option<&Uri>) -> bool {
    uri.and_then(Uri::scheme_str) == Some("https")
        || forwarded_proto_is_https(headers)
        || header_equals_ignore_ascii_case(headers, "x-forwarded-ssl", "on")
}

pub fn request_origin(headers: &HeaderMap, uri: Option<&Uri>) -> Option<String> {
    let scheme = if request_uses_https(headers, uri) {
        "https"
    } else {
        uri.and_then(Uri::scheme_str).unwrap_or("http")
    };
    let authority = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| uri.and_then(|value| value.authority().map(|authority| authority.as_str())))?;
    Some(format!("{scheme}://{authority}"))
}

pub fn header_origin(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    let raw = headers.get(name)?.to_str().ok()?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("null") {
        return None;
    }

    let parsed = raw.parse::<Uri>().ok()?;
    let scheme = parsed.scheme_str()?;
    let authority = parsed.authority()?;
    Some(format!("{scheme}://{authority}"))
}

pub fn build_content_security_policy(connect_src: &str) -> String {
    format!(
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src {connect_src}; manifest-src 'self'; worker-src 'self' blob:"
    )
}

pub fn validated_security_header_values(
    connect_src: Option<&str>,
    hsts_value: Option<&str>,
    csp_env_name: &str,
    hsts_env_name: &str,
) -> Result<SecurityHeadersConfig, String> {
    let content_security_policy =
        build_content_security_policy(connect_src.unwrap_or(DEFAULT_CONNECT_SRC));
    let content_security_policy = HeaderValue::from_str(&content_security_policy)
        .map_err(|error| format!("{csp_env_name} produces an invalid CSP header: {error}"))?;
    let strict_transport_security = HeaderValue::from_str(hsts_value.unwrap_or(DEFAULT_HSTS_VALUE))
        .map_err(|error| format!("{hsts_env_name} must be a valid HSTS header value: {error}"))?;

    Ok(SecurityHeadersConfig {
        enable_hsts: false,
        content_security_policy,
        strict_transport_security,
    })
}

pub fn parse_optional_string_env(name: &str) -> Result<Option<String>, String> {
    match std::env::var(name) {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid utf-8")),
    }
}

pub fn apply_standard_security_headers(
    headers: &mut HeaderMap,
    content_security_policy: &HeaderValue,
    strict_transport_security: &HeaderValue,
    enable_hsts: bool,
    is_https: bool,
) {
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        content_security_policy.clone(),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static(PERMISSIONS_POLICY),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static(REFERRER_POLICY),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static(X_CONTENT_TYPE_OPTIONS),
    );
    if enable_hsts && is_https {
        headers.insert(
            HeaderName::from_static("strict-transport-security"),
            strict_transport_security.clone(),
        );
    }
}

fn forwarded_proto_is_https(headers: &HeaderMap) -> bool {
    if let Some(value) = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
    {
        return value
            .split(',')
            .any(|entry| entry.trim().eq_ignore_ascii_case("https"));
    }

    headers
        .get("forwarded")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().contains("proto=https"))
        .unwrap_or(false)
}

fn header_equals_ignore_ascii_case(headers: &HeaderMap, name: &str, expected: &str) -> bool {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests;
