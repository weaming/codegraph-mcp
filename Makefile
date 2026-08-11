IMAGE_NAME ?= codegraph-mcp:latest
CODEGRAPH_VERSION ?= v1.5.0
TARGET_PLATFORM ?= linux/arm64

.PHONY: image image-force up up-force

image:
	@if docker image inspect "$(IMAGE_NAME)" >/dev/null 2>&1; then \
		echo "image $(IMAGE_NAME) already exists"; \
	else \
		CODEGRAPH_VERSION=$(CODEGRAPH_VERSION) TARGET_PLATFORM=$(TARGET_PLATFORM) IMAGE_NAME=$(IMAGE_NAME) ./build.fish; \
	fi

image-force:
	CODEGRAPH_VERSION=$(CODEGRAPH_VERSION) TARGET_PLATFORM=$(TARGET_PLATFORM) IMAGE_NAME=$(IMAGE_NAME) ./build.fish

up: image
	CODEGRAPH_MCP_IMAGE=$(IMAGE_NAME) docker compose up -d

up-force: image-force
	CODEGRAPH_MCP_IMAGE=$(IMAGE_NAME) docker compose up -d --force-recreate
