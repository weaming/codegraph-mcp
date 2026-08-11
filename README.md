# CodeGraph MCP

A small Streamable HTTP MCP server that manages shallow Git clones and analyzes them with [CodeGraph](https://github.com/colbymchenry/codegraph).

The server exposes repository management and analysis tools at `/mcp`:

- `repo_add`
- `repo_list`
- `repo_update`
- `repo_delete`
- `codegraph_status`
- `codegraph_explore`

## Quick start

The published image is available for Linux ARM64 and AMD64:

```bash
docker compose up -d
```

The MCP endpoint is `http://127.0.0.1:8080/mcp`.

Repositories are stored in the named Docker volume `codegraph-repos`.
Git uses HTTPS shallow clones with depth 1. Set `HTTPS_PROXY` when GitHub access requires a proxy:

```bash
HTTPS_PROXY=http://host.docker.internal:7890 docker compose up -d
```

## Build on Apple Silicon

Docker Desktop or OrbStack on a Darwin ARM64 host can build the Linux ARM64 image locally:

```bash
make image
make up
```

To rebuild everything:

```bash
make image-force
```

The build downloads and verifies the matching CodeGraph Linux bundle, builds the MCP server with Bun, and creates a shell-free Distroless image.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CODEGRAPH_MCP_IMAGE` | `ghcr.io/weaming/codegraph-mcp:latest` | Container image |
| `CODEGRAPH_REPO_ROOT` | `/repos` | Repository root inside the container |
| `HTTPS_PROXY` | empty | HTTPS proxy for Git |
| `PORT` | `8080` | HTTP port inside the container |

Repository IDs use the `owner/name` format, for example `octocat/Hello-World`.
