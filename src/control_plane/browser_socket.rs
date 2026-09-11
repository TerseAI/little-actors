use std::{collections::VecDeque, time::Duration};

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    response::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{sync::mpsc, task::JoinHandle};

use super::{
    ActorPrincipal,
    socket_ticket::SocketTicket,
    websocket::{OutboundMessage, SocketServerState, dispatch},
};
use crate::actor::{
    ActorSocketConnection, ActorSocketEvent, ActorSocketMessage, MAX_SOCKET_MESSAGE_BYTES,
};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ClientFrame {
    Authorize { key: String },
    Renew { key: String },
    Message { data: Value },
}

type Closed = (u16, &'static str);

pub(super) async fn connect(
    State(state): State<SocketServerState>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade
        .protocols(["little-actors.v1"])
        .max_frame_size(MAX_SOCKET_MESSAGE_BYTES)
        .max_message_size(MAX_SOCKET_MESSAGE_BYTES)
        .on_upgrade(move |socket| authorize(socket, state))
}

async fn authorize(mut socket: WebSocket, state: SocketServerState) {
    let ticket = receive_ticket(&mut socket, &state).await;
    let Some(ticket) = ticket else {
        close(&mut socket, (4401, "socket authorization rejected")).await;
        return;
    };
    let connection = ActorSocketConnection {
        id: uuid::Uuid::new_v4().to_string(),
        metadata: ticket.metadata.clone(),
        tags: vec![],
    };
    let (sender, receiver) = mpsc::unbounded_channel();
    if !state
        .registry
        .insert(&ticket.actor, connection.clone(), sender, None)
        .await
    {
        close(&mut socket, (1013, "actor connection limit reached")).await;
        return;
    }
    let principal = ActorPrincipal::for_application(
        &ticket.actor.namespace_id,
        ticket.region.clone(),
        ticket.authorized_until_ms.div_euclid(1000) + 1,
    );
    let mut session = Session {
        state,
        ticket,
        principal,
        connection,
        outbound: receiver,
        pending: VecDeque::new(),
        handler: None,
        ready: false,
    };
    session.start(ActorSocketEvent::Connect {
        connection: session.connection.clone(),
    });
    let closed = session
        .run(&mut socket)
        .await
        .unwrap_or_else(|closed| closed);
    close(&mut socket, closed).await;
    session.disconnect(closed).await;
}

async fn receive_ticket(socket: &mut WebSocket, state: &SocketServerState) -> Option<SocketTicket> {
    if socket.protocol().map(|value| value.as_bytes()) != Some(b"little-actors.v1".as_slice()) {
        return None;
    }
    let frame = tokio::time::timeout(Duration::from_secs(10), socket.recv())
        .await
        .ok()??
        .ok()?;
    let Message::Text(text) = frame else {
        return None;
    };
    if text.len() > 128 * 1024 + 128 {
        return None;
    }
    let ClientFrame::Authorize { key } = serde_json::from_str(&text).ok()? else {
        return None;
    };
    let ticket = state.admin.verify_socket(&key).ok()?;
    if ticket.connection_id.is_some() {
        return None;
    }
    Some(ticket)
}

struct Session {
    state: SocketServerState,
    ticket: SocketTicket,
    principal: ActorPrincipal,
    connection: ActorSocketConnection,
    outbound: mpsc::UnboundedReceiver<OutboundMessage>,
    pending: VecDeque<Value>,
    handler: Option<JoinHandle<bool>>,
    ready: bool,
}

impl Session {
    async fn run(&mut self, socket: &mut WebSocket) -> Result<Closed, Closed> {
        loop {
            let remaining = self.remaining()?;
            tokio::select! {
                biased;
                _ = tokio::time::sleep(remaining) => return Err((4408, "socket authorization expired")),
                result = async { self.handler.as_mut().unwrap().await }, if self.handler.is_some() => {
                    self.handler.take();
                    if !result.unwrap_or(false) { return Err((4400, "actor socket handler failed")); }
                    if !self.ready {
                        while let Ok(outbound) = self.outbound.try_recv() { self.send_outbound(socket, outbound).await?; }
                        self.send(socket, json!({"type":"ready", "protocol":1, "connectionId":self.connection.id, "expiresInMs":self.remaining()?.as_millis()})).await?;
                        self.ready = true;
                    }
                    if let Some(data) = self.pending.pop_front() { self.start_message(data); }
                }
                inbound = socket.recv() => self.receive(socket, inbound).await?,
                outbound = self.outbound.recv() => self.send_outbound(socket, outbound.ok_or((1006, "socket closed"))?).await?,
            }
        }
    }

    async fn receive(
        &mut self,
        socket: &mut WebSocket,
        inbound: Option<Result<Message, axum::Error>>,
    ) -> Result<(), Closed> {
        match inbound {
            Some(Ok(Message::Text(text))) => {
                let frame: ClientFrame =
                    serde_json::from_str(&text).map_err(|_| (4400, "invalid socket frame"))?;
                match frame {
                    ClientFrame::Renew { key } if self.ready => self.renew(socket, &key).await,
                    ClientFrame::Message { data } if self.ready => {
                        if self.handler.is_none() {
                            self.start_message(data);
                        } else if self.pending.len() < 32 {
                            self.pending.push_back(data);
                        } else {
                            return Err((1013, "socket operation queue is full"));
                        }
                        Ok(())
                    }
                    _ => Err((4400, "unexpected socket frame")),
                }
            }
            Some(Ok(Message::Ping(data))) => self.send_frame(socket, Message::Pong(data)).await,
            Some(Ok(Message::Pong(_))) => Ok(()),
            Some(Ok(Message::Close(_))) => Err((1000, "client closed")),
            Some(Ok(Message::Binary(_))) => Err((4400, "socket messages must be JSON text")),
            Some(Err(_)) | None => Err((1006, "transport closed")),
        }
    }

    async fn renew(&mut self, socket: &mut WebSocket, key: &str) -> Result<(), Closed> {
        let ticket = self
            .state
            .admin
            .verify_socket(key)
            .map_err(|_| (4401, "socket renewal rejected"))?;
        if ticket.actor != self.ticket.actor
            || ticket
                .connection_id
                .as_deref()
                .is_some_and(|id| id != self.connection.id)
        {
            return Err((4403, "socket renewal target mismatch"));
        }
        if ticket.metadata != self.ticket.metadata || ticket.region != self.ticket.region {
            return Err((4409, "socket authorization changed"));
        }
        self.ticket = ticket;
        self.principal.expires_at = self.ticket.authorized_until_ms.div_euclid(1000) + 1;
        self.send(
            socket,
            json!({"type":"renewed", "expiresInMs":self.remaining()?.as_millis()}),
        )
        .await
    }

    fn start_message(&mut self, data: Value) {
        self.start(ActorSocketEvent::Message {
            connection_id: self.connection.id.clone(),
            message: ActorSocketMessage::Text {
                data: data.to_string(),
            },
        });
    }

    fn start(&mut self, event: ActorSocketEvent) {
        let state = self.state.clone();
        let actor = self.ticket.actor.clone();
        let principal = self.principal.clone();
        let deliver = matches!(event, ActorSocketEvent::Message { .. });
        self.handler = Some(tokio::spawn(async move {
            dispatch(&state, &actor, &principal, event, deliver).await
        }));
    }

    async fn send_outbound(
        &self,
        socket: &mut WebSocket,
        outbound: OutboundMessage,
    ) -> Result<(), Closed> {
        match outbound {
            OutboundMessage::Control(value) => self.send(socket, value).await,
            OutboundMessage::Message(ActorSocketMessage::Text { data }) => {
                let value: Value = serde_json::from_str(&data)
                    .map_err(|_| (4400, "actor produced invalid JSON"))?;
                self.send(socket, json!({"type":"message", "data":value}))
                    .await
            }
            OutboundMessage::Message(_) => Err((4400, "actor produced a binary message")),
            OutboundMessage::Close { code, reason } => {
                let _ = self
                    .send_frame(
                        socket,
                        Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })),
                    )
                    .await;
                Err((code, "actor closed connection"))
            }
        }
    }

    async fn send(&self, socket: &mut WebSocket, value: Value) -> Result<(), Closed> {
        let text = value.to_string();
        if text.len() > MAX_SOCKET_MESSAGE_BYTES {
            return Err((4400, "socket frame too large"));
        }
        self.send_frame(socket, Message::Text(text.into())).await
    }

    async fn send_frame(&self, socket: &mut WebSocket, frame: Message) -> Result<(), Closed> {
        tokio::time::timeout(
            self.remaining()?.min(Duration::from_secs(5)),
            socket.send(frame),
        )
        .await
        .map_err(|_| (4408, "socket delivery timed out"))?
        .map_err(|_| (1006, "transport closed"))
    }

    fn remaining(&self) -> Result<Duration, Closed> {
        let millis = self.ticket.authorized_until_ms - now_ms();
        if millis <= 0 {
            return Err((4408, "socket authorization expired"));
        }
        Ok(Duration::from_millis(millis as u64))
    }

    async fn disconnect(mut self, closed: Closed) {
        let connection = self
            .state
            .registry
            .remove(&self.ticket.actor, &self.connection.id)
            .await
            .unwrap_or(self.connection.clone());
        if let Some(handler) = self.handler.take() {
            let _ = handler.await;
        }
        let mut principal = self.principal.clone();
        principal.expires_at = now_ms().div_euclid(1000) + 60;
        let event = ActorSocketEvent::Disconnect {
            connection,
            code: closed.0,
            reason: closed.1.into(),
            was_clean: closed.0 == 1000,
        };
        dispatch(&self.state, &self.ticket.actor, &principal, event, false).await;
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

async fn close(socket: &mut WebSocket, (code, reason): Closed) {
    if code == 1006 {
        return;
    }
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        }))),
    )
    .await;
}
