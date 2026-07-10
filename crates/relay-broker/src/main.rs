use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "relay_broker=debug,tower_http=info".into()),
        )
        .init();

    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8788);
    let host = std::env::var("BIND_HOST")
        .ok()
        .and_then(|value| value.parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
    let address = SocketAddr::from((host, port));
    let listener = TcpListener::bind(address)
        .await
        .expect("failed to bind broker tcp listener");

    info!(
        "relay-broker listening on http://{}:{} and ws://{}:{}/ws/:channel_id",
        host, port, host, port
    );
    let app = relay_broker::app(relay_broker::BrokerState::from_env()).await;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("relay-broker exited unexpectedly");
}
