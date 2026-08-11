#!/usr/bin/env fish

set -l project_root (cd (dirname (status --current-filename)); and pwd)
set -q CODEGRAPH_VERSION; or set CODEGRAPH_VERSION v1.5.0
set -q TARGET_PLATFORM; or set TARGET_PLATFORM linux/arm64
set -q IMAGE_NAME; or set IMAGE_NAME codegraph-mcp:latest

set -l platform_parts (string split / "$TARGET_PLATFORM")
set -l target_os $platform_parts[1]
set -l target_arch $platform_parts[2]
if test "$target_os" != linux
    echo "Only Linux container platforms are supported: $TARGET_PLATFORM" >&2
    exit 1
end

switch "$target_arch"
    case arm64
        set asset_arch arm64
    case amd64
        set asset_arch x64
    case '*'
        echo "Unsupported container architecture: $TARGET_PLATFORM" >&2
        exit 1
end

set -l asset_name "codegraph-linux-$asset_arch.tar.gz"
set -l release_url "https://github.com/colbymchenry/codegraph/releases/download/$CODEGRAPH_VERSION"
set -l cache_dir "$project_root/cache/codegraph/$CODEGRAPH_VERSION"
set -l archive_path "$cache_dir/$asset_name"
set -l checksum_path "$cache_dir/SHA256SUMS"
set -l work_dir "$project_root/tmp/codegraph-mcp-build"
set -l bundle_dir "$work_dir/codegraph"

function cleanup --on-event fish_exit
    set -l project_root (cd (dirname (status --current-filename)); and pwd)
    rm -rf "$project_root/tmp/codegraph-mcp-build"
end

for required_command in bun curl docker tar awk
    command -q $required_command; or begin
        echo "缺少命令：$required_command" >&2
        exit 1
    end
end

mkdir -p "$cache_dir" "$bundle_dir"

if not test -s "$archive_path"
    curl -fL --retry 3 --retry-delay 2 "$release_url/$asset_name" -o "$archive_path"
end

if not test -s "$checksum_path"
    curl -fL --retry 3 --retry-delay 2 "$release_url/SHA256SUMS" -o "$checksum_path"
end

set -l expected_checksum (awk -v asset="$asset_name" '$2 == asset {print $1}' "$checksum_path")
set -l actual_checksum
if command -q sha256sum
    set actual_checksum (sha256sum "$archive_path" | awk '{print $1}')
else if command -q shasum
    set actual_checksum (shasum -a 256 "$archive_path" | awk '{print $1}')
else
    echo "缺少 SHA-256 校验命令：sha256sum 或 shasum" >&2
    exit 1
end
if test -z "$expected_checksum"; or test "$actual_checksum" != "$expected_checksum"
    echo "CodeGraph bundle 校验失败：$archive_path" >&2
    exit 1
end

tar -xzf "$archive_path" --strip-components=1 -C "$bundle_dir"

cd "$project_root"
or exit 1
bun install --frozen-lockfile
and bun run build
or exit 1

docker buildx build \
    --load \
    --platform "$TARGET_PLATFORM" \
    --build-context "codegraph=$bundle_dir" \
    --tag "$IMAGE_NAME" \
    --file Dockerfile \
    .
or exit 1

docker run --rm \
    --platform "$TARGET_PLATFORM" \
    --tmpfs /repos:rw,mode=1777 \
    --entrypoint /opt/codegraph/node \
    "$IMAGE_NAME" \
    --liftoff-only \
    --disable-warning=ExperimentalWarning \
    /opt/codegraph/lib/dist/bin/codegraph.js version

rm -rf "$work_dir"
echo "$IMAGE_NAME built for $TARGET_PLATFORM."
