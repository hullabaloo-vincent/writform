# WritForm server — self-hosted, single binary.
# Build:  docker build -t writform-server .
# Run:    docker run -p 7311:7311 -v writform:/data ghcr.io/hullabaloo-vincent/writform-server

FROM rust:1.90-bookworm AS build
WORKDIR /src
COPY Cargo.toml rust-toolchain.toml ./
COPY crates ./crates
# The desktop crate is a workspace member but not needed for the server image.
RUN sed -i 's|"apps/desktop/src-tauri",||' Cargo.toml \
    && cargo build --release -p writform-server

FROM debian:bookworm-slim
# /data must EXIST in the image, owned by the app user, BEFORE `VOLUME` —
# otherwise Docker creates the mountpoint root-owned and the non-root server
# dies with `permission denied (os error 13)` on first write.
RUN useradd --system --home /data writform \
    && mkdir -p /data \
    && chown writform:writform /data
COPY --from=build /src/target/release/writform-server /usr/local/bin/writform-server
USER writform
VOLUME /data
EXPOSE 7311
ENV WRITFORM_DATA_DIR=/data
ENTRYPOINT ["writform-server"]
