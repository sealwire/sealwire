use super::*;

#[test]
fn relay_proof_messages_preserve_the_wire_encoding() {
    assert_eq!(
        STANDARD.encode(relay_ws_ticket_message("https://broker.test", "challenge:1", "nonce|☀", "relay:α", "room|1", "peer:2", "tokenhash").unwrap()),
        "YWdlbnQtcmVsYXk6cmVsYXktd3MtdGlja2V0LXYxAAAAABNodHRwczovL2Jyb2tlci50ZXN0AAAAC2NoYWxsZW5nZToxAAAACW5vbmNlfOKYgAAAAAhyZWxheTrOsQAAAAZyb29tfDEAAAAGcGVlcjoyAAAACXRva2VuaGFzaA=="
    );
    assert_eq!(
        STANDARD.encode(relay_join_message("https://broker.test", "challenge:1", "nonce|☀", "tickethash", "relay:α", "room|1", "peer:2").unwrap()),
        "YWdlbnQtcmVsYXk6cmVsYXktam9pbi12MQAAAAATaHR0cHM6Ly9icm9rZXIudGVzdAAAAAtjaGFsbGVuZ2U6MQAAAAlub25jZXzimIAAAAAKdGlja2V0aGFzaAAAAAhyZWxheTrOsQAAAAZyb29tfDEAAAAGcGVlcjoy"
    );
    assert_eq!(
        STANDARD.encode(relay_control_message("https://broker.test", "challenge:1", "nonce|☀", "POST /api/public/devices", "relay:α", "room|1", "tokenhash", "bodyhash").unwrap()),
        "YWdlbnQtcmVsYXk6cmVsYXktY29udHJvbC12MQAAAAATaHR0cHM6Ly9icm9rZXIudGVzdAAAAAtjaGFsbGVuZ2U6MQAAAAlub25jZXzimIAAAAAYUE9TVCAvYXBpL3B1YmxpYy9kZXZpY2VzAAAACHJlbGF5Os6xAAAABnJvb218MQAAAAl0b2tlbmhhc2gAAAAIYm9keWhhc2g="
    );
}
