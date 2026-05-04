/**
 * qa-pi extension — bundles QA-specialized features:
 *
 *  1. /qa-plan, /qa-full, /qa-smoke, /qa-regress slash commands
 *  2. `subagent` tool (delegates to specialized QA agents — planner/web/api/visual/perf/security/redteam)
 *  3. `qa_mcp_call` tool (bridge to MCP servers configured in ~/.qapi/agent/qa-mcp.json)
 *
 * The subagent implementation is adapted from the upstream pi `subagent` example;
 * the MCP bridge spawns MCP servers over stdio and proxies their tools.
 *
 * Auto-loaded when copied to ~/.qapi/agent/extensions/qa-pi/index.ts (postinstall does this).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@tak-uukti/qa-pi";
import { Type } from "typebox";

// ---------- agent discovery (lifted from upstream subagent example, simplified) ----------

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "bundled";
	filePath: string;
}

function parseFM(content: string): { fm: Record<string, string>; body: string } {
	if (!content.startsWith("---")) return { fm: {}, body: content };
	const end = content.indexOf("\n---", 3);
	if (end < 0) return { fm: {}, body: content };
	const head = content.slice(3, end).trim();
	const body = content.slice(end + 4).trimStart();
	const fm: Record<string, string> = {};
	for (const line of head.split("\n")) {
		const m = line.match(/^([\w-]+):\s*(.*)$/);
		if (m) fm[m[1]] = m[2].trim();
	}
	return { fm, body };
}

function loadAgentsFrom(dir: string, source: "user" | "bundled"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	const out: AgentConfig[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		// skip docs that aren't agent definitions
		if (entry.name === "ARCHITECTURE.md" || entry.name === "MCP-SETUP.md" || entry.name === "README.md") continue;
		const filePath = path.join(dir, entry.name);
		try {
			const { fm, body } = parseFM(fs.readFileSync(filePath, "utf-8"));
			if (!fm.name || !fm.description) continue;
			const tools = fm.tools?.split(",").map((t) => t.trim()).filter(Boolean);
			out.push({
				name: fm.name,
				description: fm.description,
				tools: tools && tools.length > 0 ? tools : undefined,
				model: fm.model,
				systemPrompt: body,
				source,
				filePath,
			});
		} catch {
			/* ignore malformed agent file */
		}
	}
	return out;
}

function discoverQAAgents(): AgentConfig[] {
	const userDir = path.join(os.homedir(), ".qapi", "agent", "agents");
	const bundledDir = path.join(__dirname, "..", "qa-agents");
	const map = new Map<string, AgentConfig>();
	for (const a of loadAgentsFrom(bundledDir, "bundled")) map.set(a.name, a);
	for (const a of loadAgentsFrom(userDir, "user")) map.set(a.name, a); // user wins
	return Array.from(map.values());
}

// ---------- subagent tool ----------

function getQAPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	return { command: "qa-pi", args };
}

async function runSubagent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "qa-pi-sub-"));
	const promptFile = path.join(tmpDir, "task.md");
	await fs.promises.writeFile(promptFile, task, { mode: 0o600 });

	const args = ["-p", "--mode", "json", "--no-session", "--append-system-prompt", agent.systemPrompt];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	args.push(`@${promptFile}`);

	const { command, args: cliArgs } = getQAPiInvocation(args);
	return new Promise((resolve) => {
		const child = spawn(command, cliArgs, { cwd, signal, env: process.env });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => {
			fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}

// ---------- MCP bridge ----------

interface MCPServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	disabled?: boolean;
}
interface MCPConfig {
	servers: Record<string, MCPServerConfig>;
}

function loadMCPConfig(): MCPConfig {
	const userPath = path.join(os.homedir(), ".qapi", "agent", "qa-mcp.json");
	const defaultPath = path.join(__dirname, "..", "qa-agents", "qa-mcp.default.json");
	for (const p of [userPath, defaultPath]) {
		if (fs.existsSync(p)) {
			try {
				return JSON.parse(fs.readFileSync(p, "utf-8")) as MCPConfig;
			} catch {
				/* fall through */
			}
		}
	}
	return { servers: {} };
}

// Lightweight stdio JSON-RPC client for MCP.
class MCPClient {
	private proc: ReturnType<typeof spawn> | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private buffer = "";

	constructor(public readonly name: string, private readonly cfg: MCPServerConfig) {}

	async start(): Promise<void> {
		const env: Record<string, string> = {
			PATH: process.env.PATH || "",
			HOME: process.env.HOME || "",
			USER: process.env.USER || "",
		};
		if (this.cfg.env) Object.assign(env, this.cfg.env);
		this.proc = spawn(this.cfg.command, this.cfg.args || [], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout?.on("data", (d) => this.onData(d.toString()));
		this.proc.on("exit", () => {
			for (const { reject } of this.pending.values()) reject(new Error(`MCP server ${this.name} exited`));
			this.pending.clear();
		});
		// MCP initialize handshake
		await this.send("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "qa-pi", version: "0.1.0" },
		});
		this.notify("notifications/initialized", {});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
				if (msg.id != null && this.pending.has(msg.id)) {
					const { resolve, reject } = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					if (msg.error) reject(new Error(msg.error.message));
					else resolve(msg.result);
				}
			} catch {
				/* non-JSON logging from server, ignore */
			}
		}
	}

	send(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`MCP ${this.name}.${method} timed out after 60s`));
				}
			}, 60_000);
		});
	}

	notify(method: string, params: unknown): void {
		this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	async listTools(): Promise<Array<{ name: string; description?: string }>> {
		const r = (await this.send("tools/list", {})) as { tools?: Array<{ name: string; description?: string }> };
		return r.tools || [];
	}

	async callTool(name: string, args: unknown): Promise<unknown> {
		return this.send("tools/call", { name, arguments: args });
	}

	stop(): void {
		this.proc?.kill();
	}
}

const mcpClients = new Map<string, MCPClient>();

async function ensureMCP(name: string): Promise<MCPClient> {
	if (mcpClients.has(name)) return mcpClients.get(name)!;
	const cfg = loadMCPConfig();
	const server = cfg.servers[name];
	if (!server || server.disabled) throw new Error(`MCP server '${name}' not configured. See ~/.qapi/agent/qa-mcp.json`);
	const client = new MCPClient(name, server);
	await client.start();
	mcpClients.set(name, client);
	return client;
}

// ---------- extension entry ----------

export default function (pi: ExtensionAPI) {
	pi.on?.("session_start", async (_e: unknown, ctx: { ui?: { notify?: (m: string, l: string) => void } }) => {
		const agents = discoverQAAgents();
		ctx.ui?.notify?.(`qa-pi: ${agents.length} QA subagents loaded`, "info");
	});

	// /qa-plan command — drive the planner
	pi.registerCommand?.("qa-plan", {
		description: "Generate a QA test plan for a spec, PR, or feature description",
		handler: async (args: string, ctx: { sendUserMessage?: (s: string) => void }) => {
			const target = args || "the current changes (use git diff if unsure)";
			ctx.sendUserMessage?.(
				`Use the subagent tool with agent="qa-planner" and task="Produce a QA test plan for: ${target}". Then summarise the plan.`,
			);
		},
	});

	pi.registerCommand?.("qa-full", {
		description: "Run the full QA suite — planner → web/api/visual/perf/security in parallel",
		handler: async (args: string, ctx: { sendUserMessage?: (s: string) => void }) => {
			const target = args || "the current project";
			ctx.sendUserMessage?.(
				[
					"Run a full QA pass against:",
					target,
					"",
					"Step 1: subagent agent=qa-planner task='Plan QA scope for the target above'.",
					"Step 2: subagent in PARALLEL with agents qa-web, qa-api, qa-visual, qa-perf, qa-security — pass the planner's matrix.",
					"Step 3: aggregate findings into a single severity-ranked report.",
				].join("\n"),
			);
		},
	});

	pi.registerCommand?.("qa-smoke", {
		description: "Quick smoke pass — qa-web + qa-api only",
		handler: async (args: string, ctx: { sendUserMessage?: (s: string) => void }) => {
			ctx.sendUserMessage?.(
				`subagent in parallel: qa-web (top user flows) and qa-api (critical endpoints) for: ${args || "the current project"}`,
			);
		},
	});

	pi.registerCommand?.("qa-regress", {
		description: "Regression check — diff vs main, run targeted subagents",
		handler: async (args: string, ctx: { sendUserMessage?: (s: string) => void }) => {
			ctx.sendUserMessage?.(
				`Run qa-planner with task='Map regression risk for git diff main..HEAD: ${args}'. Then dispatch only the affected subagents.`,
			);
		},
	});

	// subagent tool
	const SubagentParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Agent name (qa-planner, qa-web, ...)" })),
		task: Type.Optional(Type.String({ description: "Task for single mode" })),
		tasks: Type.Optional(
			Type.Array(
				Type.Object({ agent: Type.String(), task: Type.String() }),
				{ description: "Parallel mode: array of {agent, task}" },
			),
		),
	});

	pi.registerTool?.({
		name: "subagent",
		label: "QA Subagent",
		description:
			"Delegate to a specialized QA subagent in an isolated qa-pi process. Modes: single ({agent, task}) or parallel ({tasks: [...]}). Available agents: qa-planner, qa-web, qa-api, qa-visual, qa-perf, qa-security, qa-redteam.",
		parameters: SubagentParams,
		async execute(_id: string, params: { agent?: string; task?: string; tasks?: Array<{ agent: string; task: string }> }, signal: AbortSignal | undefined) {
			const agents = discoverQAAgents();
			const cwd = process.cwd();
			const items =
				params.tasks ||
				(params.agent && params.task ? [{ agent: params.agent, task: params.task }] : []);
			if (items.length === 0)
				return { content: [{ type: "text", text: "Error: provide {agent, task} or {tasks: [...]}." }], details: {} };
			const results = await Promise.all(
				items.map(async (it) => {
					const a = agents.find((x) => x.name === it.agent);
					if (!a) return `[${it.agent}] unknown agent. Available: ${agents.map((x) => x.name).join(", ")}`;
					const r = await runSubagent(a, it.task, cwd, signal);
					return `## ${it.agent} (exit=${r.exitCode})\n\n${r.stdout || r.stderr || "(no output)"}`;
				}),
			);
			return { content: [{ type: "text", text: results.join("\n\n---\n\n") }], details: {} };
		},
	});

	// MCP bridge tool
	const MCPParams = Type.Object({
		server: Type.String({ description: "MCP server name (playwright, chrome-devtools, axe, filesystem, git, github, time, nuclei)" }),
		tool: Type.Optional(Type.String({ description: "Tool name to call. Omit to list available tools on the server." })),
		args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Arguments for the tool call" })),
	});

	pi.registerTool?.({
		name: "qa_mcp_call",
		label: "MCP Bridge",
		description:
			"Bridge to MCP servers configured in ~/.qapi/agent/qa-mcp.json. Use {server, tool, args} to call a tool, or {server} alone to list tools. Bundled servers: playwright, chrome-devtools, filesystem, git, github, time. Optional: axe, nuclei.",
		parameters: MCPParams,
		async execute(_id: string, params: { server: string; tool?: string; args?: unknown }) {
			try {
				const client = await ensureMCP(params.server);
				if (!params.tool) {
					const tools = await client.listTools();
					return {
						content: [{ type: "text", text: `Tools on ${params.server}:\n${tools.map((t) => `- ${t.name}: ${t.description || ""}`).join("\n")}` }],
						details: {},
					};
				}
				const result = await client.callTool(params.tool, params.args || {});
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
			} catch (e) {
				return { content: [{ type: "text", text: `MCP error: ${(e as Error).message}` }], details: {} };
			}
		},
	});

// ---------- memory tool + auto-injection ----------

	const MEMORY_DIR = path.join(os.homedir(), ".qapi");
	const MEMORY_FILE = path.join(MEMORY_DIR, "memory.md");
	const USER_FILE = path.join(MEMORY_DIR, "user.md");
	const MEMORY_SEP = "\n§\n";
	const MEMORY_MAX_BYTES = 50 * 1024;

	function readMemoryFile(p: string): string {
		try {
			return fs.readFileSync(p, "utf-8");
		} catch {
			return "";
		}
	}

	function writeMemoryFile(p: string, content: string): void {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, content, "utf-8");
	}

	function memoryFilePathFor(target: "memory" | "user"): string {
		return target === "user" ? USER_FILE : MEMORY_FILE;
	}

	const MemoryParams = Type.Object({
		action: Type.Union([
			Type.Literal("add"),
			Type.Literal("replace"),
			Type.Literal("remove"),
		]),
		target: Type.Optional(
			Type.Union([Type.Literal("memory"), Type.Literal("user")]),
		),
		content: Type.Optional(Type.String()),
		old_text: Type.Optional(Type.String()),
	});

	pi.registerTool?.({
		name: "memory",
		label: "Memory",
		description:
			"Persist notes across qa-pi sessions. Targets: 'memory' (your notes) or 'user' (user profile). Actions: add (new entry), replace (update by old_text substring), remove (delete by old_text substring). Auto-injected at the top of every turn.",
		parameters: MemoryParams,
		async execute(
			_id: string,
			params: {
				action: string;
				target?: string;
				content?: string;
				old_text?: string;
			},
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: Record<string, unknown>;
		}> {
			const target = (params.target === "user" ? "user" : "memory") as
				| "memory"
				| "user";
			const fp = memoryFilePathFor(target);
			const current = readMemoryFile(fp);
			let next = current;
			let msg = "";

			if (params.action === "add") {
				if (!params.content) {
					return {
						content: [
							{ type: "text", text: "memory.add: 'content' is required" },
						],
						details: { error: "missing_content" },
					};
				}
				next =
					current.length > 0
						? `${current}${MEMORY_SEP}${params.content}`
						: params.content;
				msg = `Added entry to ${target} (${Buffer.byteLength(next, "utf-8")} bytes total).`;
			} else if (params.action === "replace") {
				if (!params.old_text || !params.content) {
					return {
						content: [
							{
								type: "text",
								text: "memory.replace: 'old_text' and 'content' are required",
							},
						],
						details: { error: "missing_fields" },
					};
				}
				const parts = current.length > 0 ? current.split(MEMORY_SEP) : [];
				const idx = parts.findIndex((p) => p.includes(params.old_text!));
				if (idx < 0) {
					return {
						content: [
							{
								type: "text",
								text: "memory.replace: no entry contains old_text",
							},
						],
						details: { error: "not_found" },
					};
				}
				parts[idx] = params.content;
				next = parts.join(MEMORY_SEP);
				msg = `Replaced entry ${idx} in ${target}.`;
			} else if (params.action === "remove") {
				if (!params.old_text) {
					return {
						content: [
							{ type: "text", text: "memory.remove: 'old_text' is required" },
						],
						details: { error: "missing_old_text" },
					};
				}
				const parts = current.length > 0 ? current.split(MEMORY_SEP) : [];
				const idx = parts.findIndex((p) => p.includes(params.old_text!));
				if (idx < 0) {
					return {
						content: [
							{
								type: "text",
								text: "memory.remove: no entry contains old_text",
							},
						],
						details: { error: "not_found" },
					};
				}
				parts.splice(idx, 1);
				next = parts.join(MEMORY_SEP);
				msg = `Removed entry ${idx} from ${target}.`;
			} else {
				return {
					content: [{ type: "text", text: `unknown action: ${params.action}` }],
					details: { error: "bad_action" },
				};
			}

			const sizeBytes = Buffer.byteLength(next, "utf-8");
			if (sizeBytes > MEMORY_MAX_BYTES) {
				return {
					content: [
						{
							type: "text",
							text: `Refused: ${target} would exceed ${MEMORY_MAX_BYTES} bytes`,
						},
					],
					details: { error: "too_large" },
				};
			}

			writeMemoryFile(fp, next);
			return {
				content: [{ type: "text", text: msg }],
				details: {
					target,
					action: params.action,
					file_path: fp,
					size_bytes: sizeBytes,
				},
			};
		},
	});

	// Auto-inject memory into every turn's context.
	// AgentMessage = UserMessage | AssistantMessage | ToolResultMessage (no system role).
	// UserMessage.content is `string | (TextContent | ImageContent)[]`.
	// Strategy: prepend the banner to the FIRST user message; if none, unshift a synthetic user message.
	pi.on?.("context", async (event) => {
		const memText = readMemoryFile(MEMORY_FILE).trim();
		const userText = readMemoryFile(USER_FILE).trim();
		if (!memText && !userText) return {};

		const lines: string[] = [
			"",
			"════════════════",
			"PERSISTENT MEMORY (qa-pi self-evolution)",
			"════════════════",
			"",
		];
		if (userText) lines.push("USER PROFILE:", userText, "");
		if (memText) lines.push("MEMORY:", memText, "");
		const banner = lines.join("\n");

		const messages = event.messages.slice();
		const firstUserIdx = messages.findIndex(
			(m) => (m as { role?: string }).role === "user",
		);

		if (firstUserIdx >= 0) {
			const original = messages[firstUserIdx] as {
				role: "user";
				content:
					| string
					| Array<
							| { type: "text"; text: string }
							| { type: "image"; data: string; mimeType: string }
						>;
				timestamp: number;
			};
			if (typeof original.content === "string") {
				messages[firstUserIdx] = {
					...original,
					content: `${banner}\n\n${original.content}`,
				} as (typeof messages)[number];
			} else if (Array.isArray(original.content)) {
				messages[firstUserIdx] = {
					...original,
					content: [{ type: "text", text: banner }, ...original.content],
				} as (typeof messages)[number];
			}
		} else {
			messages.unshift({
				role: "user",
				content: banner,
				timestamp: Date.now(),
			} as (typeof messages)[number]);
		}

		return { messages };
	});

	pi.on?.("session_end", async () => {
		for (const c of mcpClients.values()) c.stop();
		mcpClients.clear();
	});
}
