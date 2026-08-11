import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const execFile = promisify(execFileCallback);

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const REPOSITORY_ROOT = path.resolve(process.env.CODEGRAPH_REPO_ROOT ?? "/repos");
const CODEGRAPH_NODE = process.env.CODEGRAPH_NODE ?? "/opt/codegraph/node";
const CODEGRAPH_CLI = process.env.CODEGRAPH_CLI ?? "/opt/codegraph/lib/dist/bin/codegraph.js";
const GIT_TIMEOUT_MS = 15 * 60 * 1000;
const CODEGRAPH_TIMEOUT_MS = 30 * 60 * 1000;
const REPOSITORY_ID_PATTERN = /^[^/\s.][^/\s]*\/[^/\s.][^/\s]*$/;

type RepoCoordinates = {
    id: string;
    owner: string;
    name: string;
    directory: string;
};

type ToolResult = {
    content: [{ type: "text"; text: string }];
    isError?: boolean;
};

const repositoryLocks = new Map<string, Promise<void>>();

function textResult(value: unknown, isError = false): ToolResult {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseRepositoryId(value: string): RepoCoordinates {
    const id = value.trim();
    if (!REPOSITORY_ID_PATTERN.test(id)) {
        throw new Error(`仓库 id 必须是 owner/name 格式：${value}`);
    }

    const [owner, name] = id.split("/");
    const directory = path.resolve(REPOSITORY_ROOT, owner, name);
    const relativePath = path.relative(REPOSITORY_ROOT, directory);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`非法仓库路径：${value}`);
    }

    return { id, owner, name, directory };
}

function repositoryIdFromUrl(repositoryUrl: string): string {
    const url = new URL(repositoryUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.at(-1)?.endsWith(".git")) {
        segments[segments.length - 1] = segments[segments.length - 1].slice(0, -4);
    }
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
        throw new Error("Git URL 必须能映射为 owner/name 两级 id");
    }
    return parseRepositoryId(`${segments[0]}/${segments[1]}`).id;
}

function normalizeRepositoryUrl(repositoryUrl: string): string {
    const url = new URL(repositoryUrl);
    if (url.protocol !== "https:") {
        throw new Error("只允许使用 HTTPS Git URL");
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error("Git URL 不允许携带账号、密码、查询参数或片段");
    }
    return url.toString();
}

function defaultRepositoryUrl(id: string): string {
    return `https://github.com/${id}.git`;
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function isGitRepository(directory: string): Promise<boolean> {
    return pathExists(path.join(directory, ".git"));
}

async function withRepositoryLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = repositoryLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
        release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    repositoryLocks.set(id, queued);

    await previous.catch(() => undefined);
    try {
        return await action();
    } finally {
        release();
        if (repositoryLocks.get(id) === queued) {
            repositoryLocks.delete(id);
        }
    }
}

function commandEnvironment(): NodeJS.ProcessEnv {
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        CODEGRAPH_NO_DAEMON: "1",
        CODEGRAPH_NO_WATCH: "0",
        CODEGRAPH_TELEMETRY: "0",
        ...(proxy ? { HTTPS_PROXY: proxy, https_proxy: proxy } : {}),
    };
}

async function runGit(args: string[], cwd?: string): Promise<string> {
    const { stdout, stderr } = await execFile("/usr/bin/git", args, {
        cwd,
        env: commandEnvironment(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
    });
    if (stderr.trim()) {
        console.error(`[git] ${stderr.trim()}`);
    }
    return stdout.trim();
}

async function runCodeGraph(args: string[]): Promise<string> {
    const { stdout, stderr } = await execFile(
        CODEGRAPH_NODE,
        ["--liftoff-only", "--disable-warning=ExperimentalWarning", CODEGRAPH_CLI, ...args],
        {
            cwd: REPOSITORY_ROOT,
            env: commandEnvironment(),
            timeout: CODEGRAPH_TIMEOUT_MS,
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    if (stderr.trim()) {
        console.error(`[codegraph] ${stderr.trim()}`);
    }
    return stdout.trim();
}

async function ensureCodeGraphIndex(directory: string): Promise<{ initialized: boolean }> {
    const initialized = await pathExists(path.join(directory, ".codegraph"));
    if (!initialized) {
        await runCodeGraph(["init", directory]);
    }
    return { initialized: !initialized };
}

async function syncCodeGraphIndex(directory: string): Promise<void> {
    if (await pathExists(path.join(directory, ".codegraph"))) {
        await runCodeGraph(["sync", directory]);
        return;
    }
    await runCodeGraph(["init", directory]);
}

async function repositorySummary(repo: RepoCoordinates) {
    const indexed = await pathExists(path.join(repo.directory, ".codegraph"));
    let revision: string | null = null;
    let remote: string | null = null;
    try {
        revision = await runGit(["rev-parse", "--short", "HEAD"], repo.directory);
        remote = await runGit(["remote", "get-url", "origin"], repo.directory);
    } catch {
        // The directory can be observed while a failed clone is being cleaned up.
    }
    return { id: repo.id, path: repo.directory, indexed, revision, remote };
}

async function listRepositories(): Promise<unknown[]> {
    const result: unknown[] = [];
    if (!(await pathExists(REPOSITORY_ROOT))) {
        return result;
    }

    for (const ownerEntry of await fs.readdir(REPOSITORY_ROOT, { withFileTypes: true })) {
        if (!ownerEntry.isDirectory()) continue;
        const ownerDirectory = path.join(REPOSITORY_ROOT, ownerEntry.name);
        for (const repositoryEntry of await fs.readdir(ownerDirectory, { withFileTypes: true })) {
            if (!repositoryEntry.isDirectory()) continue;
            const id = `${ownerEntry.name}/${repositoryEntry.name}`;
            if (!REPOSITORY_ID_PATTERN.test(id)) continue;
            const repo = parseRepositoryId(id);
            if (await isGitRepository(repo.directory)) {
                result.push(await repositorySummary(repo));
            }
        }
    }
    return result;
}

async function createRepository(idInput: string | undefined, urlInput: string | undefined) {
    const repositoryUrl = urlInput ? normalizeRepositoryUrl(urlInput) : undefined;
    const id = idInput ? parseRepositoryId(idInput).id : repositoryIdFromUrl(repositoryUrl!);
    const repo = parseRepositoryId(id);
    const repositoryUrlToClone = repositoryUrl ?? defaultRepositoryUrl(id);

    return withRepositoryLock(id, async () => {
        if (await pathExists(repo.directory)) {
            throw new Error(`仓库目录已存在：${id}`);
        }
        await fs.mkdir(path.dirname(repo.directory), { recursive: true });
        await runGit(["clone", "--depth", "1", "--no-tags", repositoryUrlToClone, repo.directory], REPOSITORY_ROOT);
        await ensureCodeGraphIndex(repo.directory);
        return repositorySummary(repo);
    });
}

async function updateRepository(id: string) {
    const repo = parseRepositoryId(id);
    return withRepositoryLock(repo.id, async () => {
        if (!(await isGitRepository(repo.directory))) {
            throw new Error(`仓库不存在：${repo.id}`);
        }
        await runGit(["fetch", "--depth", "1", "origin"], repo.directory);
        await runGit(["reset", "--hard", "FETCH_HEAD"], repo.directory);
        await syncCodeGraphIndex(repo.directory);
        return repositorySummary(repo);
    });
}

async function deleteRepository(id: string) {
    const repo = parseRepositoryId(id);
    return withRepositoryLock(repo.id, async () => {
        if (!(await pathExists(repo.directory))) {
            throw new Error(`仓库不存在：${repo.id}`);
        }
        await fs.rm(repo.directory, { recursive: true, force: true });
        if ((await fs.readdir(path.dirname(repo.directory))).length === 0) {
            try {
                await fs.rmdir(path.dirname(repo.directory));
            } catch (error) {
                const errorCode = (error as NodeJS.ErrnoException).code;
                if (errorCode !== "ENOENT" && errorCode !== "ENOTEMPTY") {
                    throw error;
                }
            }
        }
        return { id: repo.id, deleted: true };
    });
}

async function analyzeRepository(id: string, query: string, maxFiles: number) {
    const repo = parseRepositoryId(id);
    return withRepositoryLock(repo.id, async () => {
        if (!(await isGitRepository(repo.directory))) {
            throw new Error(`仓库不存在：${repo.id}`);
        }
        await ensureCodeGraphIndex(repo.directory);
        return runCodeGraph(["explore", "--path", repo.directory, "--max-files", String(maxFiles), query]);
    });
}

async function statusRepository(id: string) {
    const repo = parseRepositoryId(id);
    return withRepositoryLock(repo.id, async () => {
        if (!(await isGitRepository(repo.directory))) {
            throw new Error(`仓库不存在：${repo.id}`);
        }
        await ensureCodeGraphIndex(repo.directory);
        const output = await runCodeGraph(["status", repo.directory, "--json"]);
        return JSON.parse(output);
    });
}

async function safely<T>(action: () => Promise<T>): Promise<ToolResult> {
    try {
        return textResult(await action());
    } catch (error) {
        console.error(`[codegraph-mcp] ${errorMessage(error)}`);
        return textResult({ error: errorMessage(error) }, true);
    }
}

function createMcpServer(): McpServer {
    const server = new McpServer(
        { name: "codegraph-mcp", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );

    server.registerTool(
        "repo_create",
        {
            description: "通过 HTTPS shallow clone 创建仓库；id 省略时从 Git URL 的 owner/name 推导。创建后自动执行 codegraph init。",
            inputSchema: {
                id: z.string().regex(REPOSITORY_ID_PATTERN).optional().describe("仓库 id，例如 colbymchenry/codegraph"),
                url: z.string().url().optional().describe("HTTPS Git URL，例如 https://github.com/colbymchenry/codegraph"),
            },
        },
        async args => safely(() => createRepository(args.id, args.url)),
    );

    server.registerTool(
        "repo_list",
        {
            description: "列出固定仓库目录下所有已克隆的 owner/name 仓库及 CodeGraph 状态。",
            inputSchema: {},
        },
        async () => safely(listRepositories),
    );

    server.registerTool(
        "repo_update",
        {
            description: "更新指定 shallow clone 到远端最新提交，并同步或初始化 CodeGraph 索引。",
            inputSchema: {
                id: z.string().regex(REPOSITORY_ID_PATTERN).describe("仓库 id，例如 colbymchenry/codegraph"),
            },
        },
        async args => safely(() => updateRepository(args.id)),
    );

    server.registerTool(
        "repo_delete",
        {
            description: "删除指定仓库及其 CodeGraph 索引。",
            inputSchema: {
                id: z.string().regex(REPOSITORY_ID_PATTERN).describe("仓库 id，例如 colbymchenry/codegraph"),
            },
        },
        async args => safely(() => deleteRepository(args.id)),
    );

    server.registerTool(
        "codegraph_status",
        {
            description: "返回仓库 CodeGraph 索引状态；仓库没有索引时自动执行 codegraph init。",
            inputSchema: {
                id: z.string().regex(REPOSITORY_ID_PATTERN).describe("仓库 id"),
            },
        },
        async args => safely(() => statusRepository(args.id)),
    );

    server.registerTool(
        "codegraph_explore",
        {
            description: "对指定仓库执行 CodeGraph 结构分析；仓库没有索引时自动执行 codegraph init。",
            inputSchema: {
                id: z.string().regex(REPOSITORY_ID_PATTERN).describe("仓库 id"),
                query: z.string().min(1).describe("自然语言问题、文件名或符号名"),
                maxFiles: z.number().int().min(1).max(20).optional().describe("最多返回的文件数，默认 6"),
            },
        },
        async args => safely(() => analyzeRepository(args.id, args.query, args.maxFiles ?? 6)),
    );

    return server;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (requestUrl.pathname === "/healthz" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
    }
    if (requestUrl.pathname !== "/mcp") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
    }

    const handler = toNodeHandler(
        createMcpHandler(() => createMcpServer(), {
            onerror: error => console.error(`[codegraph-mcp] ${errorMessage(error)}`),
        }),
    );
    await handler(request, response);
}

async function main(): Promise<void> {
    await fs.mkdir(REPOSITORY_ROOT, { recursive: true });
    const httpServer = createHttpServer((request, response) => {
        void handleRequest(request, response).catch(error => {
            console.error(`[codegraph-mcp] HTTP error: ${errorMessage(error)}`);
            if (!response.headersSent) {
                response.writeHead(500, { "content-type": "application/json" });
            }
            response.end(JSON.stringify({ error: errorMessage(error) }));
        });
    });

    httpServer.listen(PORT, HOST, () => {
        console.error(`codegraph-mcp listening on http://${HOST}:${PORT}/mcp`);
        console.error(`repository root: ${REPOSITORY_ROOT}`);
    });
}

void main().catch(error => {
    console.error(`[codegraph-mcp] fatal: ${errorMessage(error)}`);
    process.exitCode = 1;
});
