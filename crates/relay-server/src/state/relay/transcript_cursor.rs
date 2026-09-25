//! The one transcript position a client holds: "rows older than the row keyed K" in one
//! runtime's transcript. Provider continuations stay on the runtime and never leave it.

use std::fmt;

use crate::protocol::TranscriptCursorToken;

/// Bumped when the token layout changes, so an old token is refused, not misread.
const TOKEN_VERSION: &str = "tc1";

/// The order keys of one `ThreadRuntime` instance. A rebuilt runtime or a restarted relay
/// mints a new one, so a cursor into rows keyed before is refused instead of misapplied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TranscriptKeySpace(String);

/// A cursor decoded by the key space it was minted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TranscriptCursor {
    order_key: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TranscriptCursorRejection {
    /// Not a token this relay mints.
    Malformed,
    /// Minted for another thread, or for this one before its transcript was rebuilt or
    /// the relay restarted.
    Expired,
}

impl fmt::Display for TranscriptCursorRejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Malformed => "transcript cursor was not issued by this relay",
            Self::Expired => {
                "transcript cursor has expired: the transcript was rebuilt or the relay restarted"
            }
        })?;
        f.write_str("; reload the latest page")
    }
}

impl TranscriptKeySpace {
    pub(crate) fn mint() -> Self {
        Self(crate::state::new_uuid_v4())
    }

    pub(crate) fn cursor_older_than(&self, order_key: i64) -> TranscriptCursorToken {
        TranscriptCursorToken::new(format!("{TOKEN_VERSION}.{}.{order_key}", self.0))
    }

    pub(crate) fn decode(
        &self,
        token: &TranscriptCursorToken,
    ) -> Result<TranscriptCursor, TranscriptCursorRejection> {
        let mut parts = token.as_str().split('.');
        let (Some(TOKEN_VERSION), Some(space), Some(order_key), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(TranscriptCursorRejection::Malformed);
        };
        let order_key = order_key
            .parse::<i64>()
            .map_err(|_| TranscriptCursorRejection::Malformed)?;
        if space != self.0 {
            return Err(TranscriptCursorRejection::Expired);
        }
        Ok(TranscriptCursor { order_key })
    }
}

impl TranscriptCursor {
    pub(crate) fn order_key(self) -> i64 {
        self.order_key
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_decodes_to_its_key_in_the_space_that_minted_it() {
        let space = TranscriptKeySpace::mint();
        for key in [0, 1 << 20, -(1 << 20), i64::MIN, i64::MAX] {
            let token = space.cursor_older_than(key);
            assert_eq!(
                space.decode(&token).map(TranscriptCursor::order_key),
                Ok(key)
            );
        }
    }

    #[test]
    fn a_cursor_from_another_runtime_is_expired() {
        let token = TranscriptKeySpace::mint().cursor_older_than(7);
        assert_eq!(
            TranscriptKeySpace::mint().decode(&token),
            Err(TranscriptCursorRejection::Expired)
        );
    }

    #[test]
    fn tokens_this_relay_does_not_mint_are_malformed() {
        let space = TranscriptKeySpace::mint();
        let minted = space.cursor_older_than(7);
        let (_, rest) = minted.as_str().split_once('.').unwrap();
        for value in [
            String::new(),
            "123".to_string(),
            format!("tc0.{rest}"),
            format!("{}.x", minted.as_str()),
            minted.as_str().replace(".7", ".seven"),
        ] {
            assert_eq!(
                space.decode(&TranscriptCursorToken::new(value.clone())),
                Err(TranscriptCursorRejection::Malformed),
                "{value}"
            );
        }
    }
}
