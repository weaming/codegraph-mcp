FROM debian:bookworm-slim AS runtime-files

COPY --from=codegraph / /opt/codegraph

RUN set -eux; \
    find /opt/codegraph/lib/node_modules/tree-sitter-wasms/out \
      -type f -name '*.wasm' \
      ! -name 'tree-sitter-objc.wasm' \
      ! -name 'tree-sitter-solidity.wasm' \
      -delete; \
    rm -f \
      /opt/codegraph/lib/node_modules/web-tree-sitter/lib/tree-sitter.wasm \
      /opt/codegraph/lib/node_modules/web-tree-sitter/debug/tree-sitter.wasm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*; \
    set -eux; \
    mkdir -p /git-runtime/usr/bin /git-runtime/usr/lib/git-core /git-runtime/usr/share/git-core; \
    cp -a /usr/bin/git /git-runtime/usr/bin/git; \
    cp -a /usr/lib/git-core/git-remote-http /git-runtime/usr/lib/git-core/git-remote-http; \
    cp -a /usr/lib/git-core/git-remote-https /git-runtime/usr/lib/git-core/git-remote-https; \
    cp -a /usr/share/git-core/templates /git-runtime/usr/share/git-core/templates; \
    for executable in /usr/bin/git /usr/lib/git-core/git-remote-http /usr/lib/git-core/git-remote-https; do \
      ldd "$executable" \
        | sed -nE 's/.*=> (\/[^ ]+) .*/\1/p; s#^(\/[^ ]+) \(0x.*#\1#p' \
        | while read -r dependency; do \
            target="/git-runtime$dependency"; \
            mkdir -p "$(dirname "$target")"; \
            cp -L "$dependency" "$target"; \
          done; \
    done

FROM gcr.io/distroless/cc-debian12:latest

ENV HOME=/tmp \
    CODEGRAPH_NO_DAEMON=1 \
    CODEGRAPH_NO_WATCH=1 \
    CODEGRAPH_REPO_ROOT=/repos \
    NODE_ENV=production \
    GIT_EXEC_PATH=/usr/lib/git-core

WORKDIR /app

COPY --from=runtime-files /opt/codegraph /opt/codegraph
COPY --from=runtime-files /git-runtime/ /
COPY dist/index.js /app/index.js

EXPOSE 8080

CMD ["/opt/codegraph/node", "--liftoff-only", "--disable-warning=ExperimentalWarning", "/app/index.js"]
