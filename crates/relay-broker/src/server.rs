use std::{io, net::SocketAddr, time::Duration};

use axum::Router;
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use tokio::net::TcpListener;
use tower::Service;
use tracing::{debug, error};

use crate::ActiveConnectionTracker;

const HEADER_TIMEOUT_ENV: &str = "RELAY_BROKER_HEADER_READ_TIMEOUT_SECS";
const MAX_HTTP_CONNECTIONS_ENV: &str = "RELAY_BROKER_MAX_HTTP_CONNECTIONS";
const HTTP_TIMEOUT_ENV: &str = "RELAY_BROKER_HTTP_CONNECTION_TIMEOUT_SECS";
const MAX_HTTP_CONNECTIONS_PER_IP_ENV: &str = "RELAY_BROKER_MAX_HTTP_CONNECTIONS_PER_IP";

pub struct ServerConfig {
    header_timeout: Duration,
    http_timeout: Duration,
    max_connections: usize,
    max_connections_per_ip: Option<usize>,
}

impl ServerConfig {
    pub fn from_env() -> io::Result<Self> {
        fn bounded(name: &str, default: usize, maximum: usize) -> io::Result<usize> {
            let value = match std::env::var(name) {
                Ok(value) => value.trim().parse().ok(),
                Err(std::env::VarError::NotPresent) => Some(default),
                Err(_) => None,
            };
            value
                .filter(|value| *value > 0 && *value <= maximum)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("{name} must be in 1..={maximum}"),
                    )
                })
        }
        let per_ip = bounded(MAX_HTTP_CONNECTIONS_PER_IP_ENV, 64, 65_536)?;
        let behind_proxy = std::env::var(crate::TRUSTED_CLIENT_IP_HEADER_ENV)
            .ok()
            .and_then(|name| name.trim().parse::<axum::http::HeaderName>().ok())
            .is_some();
        Ok(Self {
            header_timeout: Duration::from_secs(bounded(HEADER_TIMEOUT_ENV, 10, 120)? as u64),
            http_timeout: Duration::from_secs(bounded(HTTP_TIMEOUT_ENV, 30, 300)? as u64),
            max_connections: bounded(MAX_HTTP_CONNECTIONS_ENV, 1_024, 65_536)?,
            // A proxy's socket address groups unrelated clients before headers arrive.
            max_connections_per_ip: (!behind_proxy).then_some(per_ip),
        })
    }
}

pub async fn serve(listener: TcpListener, app: Router, config: ServerConfig) -> io::Result<()> {
    let capacity = ActiveConnectionTracker::default();
    let mut make_service = app.into_make_service_with_connect_info::<SocketAddr>();
    loop {
        let (stream, remote_addr) = match listener.accept().await {
            Ok(connection) => connection,
            Err(error) => {
                if !matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::ConnectionRefused
                ) {
                    error!(%error, "broker TCP accept failed");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                continue;
            }
        };
        let Ok(permit) = capacity.try_acquire(
            remote_addr.ip(),
            config.max_connections_per_ip.unwrap_or(usize::MAX),
            config.max_connections,
        ) else {
            debug!(remote_ip = %remote_addr.ip(), "broker HTTP connection capacity exceeded");
            continue;
        };
        let service = make_service.call(remote_addr).await.unwrap();
        let header_timeout = config.header_timeout;
        let http_timeout = config.http_timeout;
        tokio::spawn(async move {
            let _permit = permit;
            let mut builder = http1::Builder::new();
            builder
                .timer(TokioTimer::new())
                .header_read_timeout(header_timeout);
            let connection = builder
                .serve_connection(TokioIo::new(stream), TowerToHyperService::new(service))
                .with_upgrades();
            match tokio::time::timeout(http_timeout, connection).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    debug!(remote_ip = %remote_addr.ip(), %error, "broker HTTP connection ended")
                }
                Err(_) => {
                    debug!(remote_ip = %remote_addr.ip(), "broker HTTP connection deadline exceeded")
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{ws::WebSocketUpgrade, ConnectInfo},
        routing::{get, post},
    };
    use futures_util::{SinkExt, StreamExt};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
    };

    async fn spawn(
        max_connections: usize,
        header_timeout: Duration,
    ) -> (SocketAddr, tokio::task::JoinHandle<io::Result<()>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route(
                "/",
                get(|ConnectInfo(address): ConnectInfo<SocketAddr>| async move {
                    address.ip().to_string()
                }),
            )
            .route("/body", post(|body: String| async move { body }))
            .route(
                "/ws",
                get(|ws: WebSocketUpgrade| async move {
                    ws.on_upgrade(|mut socket| async move {
                        while let Some(Ok(message)) = socket.recv().await {
                            if socket.send(message).await.is_err() {
                                break;
                            }
                        }
                    })
                }),
            );
        let server = tokio::spawn(serve(
            listener,
            app,
            ServerConfig {
                header_timeout,
                http_timeout: Duration::from_millis(500),
                max_connections,
                max_connections_per_ip: None,
            },
        ));
        (address, server)
    }

    #[tokio::test]
    async fn silent_partial_and_drip_headers_expire_without_blocking_healthy_requests() {
        let timeout = Duration::from_millis(150);
        let (address, server) = spawn(10, timeout).await;
        for partial in [
            b"".as_slice(),
            b"GET / HTTP/1.1\r\nHost: localhost\r\n".as_slice(),
            b"G".as_slice(),
        ] {
            let mut socket = TcpStream::connect(address).await.unwrap();
            socket.write_all(partial).await.unwrap();
            assert_eq!(
                reqwest::get(format!("http://{address}/"))
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "127.0.0.1"
            );
            if partial == b"G" {
                for byte in b"ET / HTTP/1.1\r\n" {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    if socket.write_all(&[*byte]).await.is_err() {
                        break;
                    }
                }
            }
            let mut response = Vec::new();
            let result =
                tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut response))
                    .await;
            assert!(
                result.is_ok(),
                "incomplete headers must close by the deadline"
            );
        }
        server.abort();
    }

    #[tokio::test]
    async fn pending_http_connections_are_bounded_and_release_capacity() {
        let (address, server) = spawn(1, Duration::from_millis(150)).await;
        let mut first = TcpStream::connect(address).await.unwrap();
        first.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        let mut excess = TcpStream::connect(address).await.unwrap();
        let mut buffer = Vec::new();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), excess.read_to_end(&mut buffer))
                .await
                .is_ok()
        );
        buffer.clear();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), first.read_to_end(&mut buffer))
                .await
                .is_ok()
        );
        assert_eq!(
            reqwest::get(format!("http://{address}/"))
                .await
                .unwrap()
                .status(),
            200
        );
        server.abort();
    }

    #[tokio::test]
    async fn websocket_upgrade_survives_the_header_deadline() {
        let (address, server) = spawn(1, Duration::from_millis(100)).await;
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(700)).await;
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                "alive".into(),
            ))
            .await
            .unwrap();
        let echoed = tokio::time::timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(echoed.into_text().unwrap(), "alive");
        assert_eq!(
            reqwest::get(format!("http://{address}/"))
                .await
                .unwrap()
                .status(),
            200
        );
        server.abort();
    }

    #[tokio::test]
    async fn dripping_request_bodies_expire_even_after_complete_headers() {
        let (address, server) = spawn(1, Duration::from_millis(100)).await;
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket
            .write_all(b"POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\nx")
            .await
            .unwrap();
        for _ in 0..14 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if socket.write_all(b"x").await.is_err() {
                break;
            }
        }
        let mut response = Vec::new();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), socket.read_to_end(&mut response))
                .await
                .is_ok(),
            "slow bodies must release their HTTP slot"
        );
        assert_eq!(
            reqwest::get(format!("http://{address}/"))
                .await
                .unwrap()
                .status(),
            200
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_direct_clients_http_sockets_cannot_take_another_networks_slots() {
        let listener = TcpListener::bind("[::]:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(serve(
            listener,
            Router::new().route("/", get(|| async { "healthy" })),
            ServerConfig {
                header_timeout: Duration::from_secs(2),
                http_timeout: Duration::from_secs(3),
                max_connections: 4,
                max_connections_per_ip: Some(2),
            },
        ));
        let connect = || async { TcpStream::connect(("::1", address.port())).await.unwrap() };
        let mut first = connect().await;
        first.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        let mut second = connect().await;
        second.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        let mut excess = connect().await;
        let mut response = Vec::new();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), excess.read_to_end(&mut response))
                .await
                .is_ok()
        );
        assert_eq!(
            reqwest::get(format!("http://127.0.0.1:{}/", address.port()))
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "healthy"
        );
        server.abort();
    }
}
