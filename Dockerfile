FROM golang:1.27.1-bookworm AS modal-builder

WORKDIR /build
COPY providers/modal-go/go.mod providers/modal-go/go.sum ./
RUN go mod download
COPY providers/modal-go/ ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/lac-modal-go .

FROM rust:1.89.0-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs ./
COPY .cargo ./.cargo
COPY migrations ./migrations
COPY proto ./proto
COPY src ./src
RUN cargo build --locked --release

FROM debian:bookworm-slim

RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/lac /usr/local/bin/lac
COPY --from=modal-builder /out/lac-modal-go /usr/local/bin/lac-modal-go

ENV RUST_LOG=warn,little_actors=info
ENV LAC_SANDBOX_COMMAND=lac-modal-go
ENTRYPOINT ["/usr/local/bin/lac"]
