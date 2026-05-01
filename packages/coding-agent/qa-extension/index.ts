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

	pi.on?.("session_end", async () => {
		for (const c of mcpClients.values()) c.stop();
		mcpClients.clear();
	});
}
