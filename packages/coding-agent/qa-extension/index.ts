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
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@tak-uukti/qa-pi";
import { getAgentDir, loadSkills } from "@tak-uukti/qa-pi";
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
		const child = spawn(command, cliArgs, { cwd, signal, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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

// ---------- skill_view + skill_manage tools ----------

	const SKILLS_ROOT = path.join(os.homedir(), ".qapi", "agent", "skills");
	const SKILL_LINKED_DIRS = [
		"references",
		"templates",
		"scripts",
		"assets",
	] as const;
	const SKILL_FILE_MAX_BYTES = 256 * 1024;
	const SKILL_STANDARD_LAYOUT = new Set<string>([
		"SKILL.md",
		...SKILL_LINKED_DIRS,
	]);

	function ensureUnderSkillsRoot(p: string): string {
		const root = SKILLS_ROOT;
		const resolved = path.resolve(p);
		if (!resolved.startsWith(root + path.sep) && resolved !== root) {
			throw new Error(`path escapes skills root: ${resolved}`);
		}
		return resolved;
	}

	function ensureUnderDir(parent: string, p: string): string {
		const resolved = path.resolve(p);
		const parentNorm = path.resolve(parent);
		if (
			resolved !== parentNorm &&
			!resolved.startsWith(parentNorm + path.sep)
		) {
			throw new Error(`path escapes ${parentNorm}: ${resolved}`);
		}
		return resolved;
	}

	function rejectTraversal(rel: string): void {
		if (path.isAbsolute(rel))
			throw new Error(`absolute paths not allowed: ${rel}`);
		const parts = rel.split(/[\\/]+/);
		if (parts.includes("..")) throw new Error(`path contains '..': ${rel}`);
	}

	function listSkills(): Array<{
		name: string;
		description: string;
		filePath: string;
		category?: string;
		location: string;
	}> {
		const result = loadSkills({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			skillPaths: [],
			includeDefaults: true,
		});
		const out: Array<{
			name: string;
			description: string;
			filePath: string;
			category?: string;
			location: string;
		}> = [];
		const userSkillsDir = path.join(getAgentDir(), "skills");
		for (const s of result.skills) {
			let category: string | undefined;
			if (s.filePath.startsWith(userSkillsDir + path.sep)) {
				const rel = path.relative(userSkillsDir, path.dirname(s.filePath));
				const segs = rel.split(path.sep);
				if (segs.length > 1) {
					category = segs.slice(0, -1).join("/");
				}
			}
			out.push({
				name: s.name,
				description: s.description,
				filePath: s.filePath,
				category,
				location: s.filePath,
			});
		}
		return out;
	}

	function listLinkedFiles(skillDir: string): Record<string, string[]> {
		const linked: Record<string, string[]> = {};
		for (const sub of SKILL_LINKED_DIRS) {
			const dir = path.join(skillDir, sub);
			if (!fs.existsSync(dir)) continue;
			try {
				const files = fs
					.readdirSync(dir, { withFileTypes: true })
					.filter((e) => e.isFile())
					.map((e) => path.join(sub, e.name));
				if (files.length > 0) linked[sub] = files;
			} catch {
				/* ignore */
			}
		}
		return linked;
	}

	const SkillsListParams = Type.Object({
		category: Type.Optional(
			Type.String({ description: "Filter by category dir prefix" }),
		),
	});

	pi.registerTool?.({
		name: "skills_list",
		label: "List Skills",
		description:
			"List available skills (bundled + user + project). Optionally filter by category prefix. Returns skill names, descriptions, and locations.",
		parameters: SkillsListParams,
		async execute(_id: string, params: { category?: string }) {
			let skills = listSkills();
			if (params.category) {
				const prefix = params.category.replace(/\\/g, "/");
				skills = skills.filter(
					(s) => s.category && s.category.startsWith(prefix),
				);
			}
			const lines: string[] = [];
			lines.push(`Found ${skills.length} skill(s).`);
			lines.push("");
			for (const s of skills) {
				const cat = s.category ? ` [${s.category}]` : "";
				lines.push(`- **${s.name}**${cat}: ${s.description}`);
				lines.push(`  ${s.filePath}`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					count: skills.length,
					skills: skills.map((s) => ({
						name: s.name,
						description: s.description,
						location: s.location,
						category: s.category,
					})),
				},
			};
		},
	});

	const SkillViewParams = Type.Object({
		name: Type.String(),
		file_path: Type.Optional(
			Type.String({
				description:
					"Path to a linked file inside the skill (e.g. references/api.md)",
			}),
		),
	});

	pi.registerTool?.({
		name: "skill_view",
		label: "View Skill",
		description:
			"Read a skill's SKILL.md or a linked file inside the skill directory (references/, templates/, scripts/, assets/). Use skills_list first to discover names.",
		parameters: SkillViewParams,
		async execute(_id: string, params: { name: string; file_path?: string }) {
			const skills = listSkills();
			const skill = skills.find((s) => s.name === params.name);
			if (!skill) {
				return {
					content: [
						{
							type: "text",
							text: `skill not found: ${params.name}. Use skills_list to enumerate.`,
						},
					],
					details: { error: "not_found", name: params.name },
				};
			}
			const skillDir = path.dirname(skill.filePath);

			if (params.file_path) {
				try {
					rejectTraversal(params.file_path);
				} catch (e) {
					return {
						content: [
							{ type: "text", text: `rejected: ${(e as Error).message}` },
						],
						details: { error: "bad_path", file_path: params.file_path },
					};
				}
				const targetUnchecked = path.resolve(skillDir, params.file_path);
				let target: string;
				try {
					target = ensureUnderDir(skillDir, targetUnchecked);
				} catch (e) {
					return {
						content: [
							{ type: "text", text: `rejected: ${(e as Error).message}` },
						],
						details: { error: "out_of_sandbox" },
					};
				}
				if (!fs.existsSync(target)) {
					return {
						content: [{ type: "text", text: `file not found: ${target}` }],
						details: { error: "not_found", path: target },
					};
				}
				const stat = fs.statSync(target);
				if (stat.size > SKILL_FILE_MAX_BYTES) {
					return {
						content: [
							{
								type: "text",
								text: `file too large (${stat.size} bytes > ${SKILL_FILE_MAX_BYTES}). Read it directly with the read tool if needed.`,
							},
						],
						details: {
							error: "too_large",
							path: target,
							size_bytes: stat.size,
						},
					};
				}
				const text = fs.readFileSync(target, "utf-8");
				return {
					content: [{ type: "text", text }],
					details: {
						name: skill.name,
						path: target,
						skill_dir: skillDir,
					},
				};
			}

			const text = fs.readFileSync(skill.filePath, "utf-8");
			const linked = listLinkedFiles(skillDir);
			return {
				content: [{ type: "text", text }],
				details: {
					name: skill.name,
					path: skill.filePath,
					skill_dir: skillDir,
					linked_files: linked,
				},
			};
		},
	});

	const SkillManageParams = Type.Object({
		action: Type.Union([
			Type.Literal("create"),
			Type.Literal("patch"),
			Type.Literal("edit"),
			Type.Literal("delete"),
			Type.Literal("write_file"),
			Type.Literal("remove_file"),
		]),
		name: Type.String(),
		category: Type.Optional(Type.String()),
		content: Type.Optional(Type.String()),
		file_path: Type.Optional(Type.String()),
		file_content: Type.Optional(Type.String()),
		old_string: Type.Optional(Type.String()),
		new_string: Type.Optional(Type.String()),
		replace_all: Type.Optional(Type.Boolean()),
	});

	function findUserSkillDir(name: string): string | null {
		// Search user skills root for a directory whose immediate child SKILL.md
		// belongs to a folder named `name`. Recurse one level for grouping.
		if (!fs.existsSync(SKILLS_ROOT)) return null;
		// First: SKILLS_ROOT/<name>/SKILL.md
		const direct = path.join(SKILLS_ROOT, name);
		if (
			fs.existsSync(path.join(direct, "SKILL.md")) &&
			fs.statSync(direct).isDirectory()
		) {
			return direct;
		}
		// Then: SKILLS_ROOT/<category>/<name>/SKILL.md
		try {
			for (const entry of fs.readdirSync(SKILLS_ROOT, {
				withFileTypes: true,
			})) {
				if (!entry.isDirectory()) continue;
				const candidate = path.join(SKILLS_ROOT, entry.name, name);
				if (
					fs.existsSync(path.join(candidate, "SKILL.md")) &&
					fs.statSync(candidate).isDirectory()
				) {
					return candidate;
				}
			}
		} catch {
			/* ignore */
		}
		return null;
	}

	function rmrf(target: string): void {
		fs.rmSync(target, { recursive: true, force: true });
	}

	function listAllRelEntries(dir: string): string[] {
		const out: string[] = [];
		const walk = (cur: string, rel: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(cur, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const childRel = rel ? path.join(rel, e.name) : e.name;
				out.push(childRel + (e.isDirectory() ? "/" : ""));
				if (e.isDirectory()) walk(path.join(cur, e.name), childRel);
			}
		};
		walk(dir, "");
		return out;
	}

	function isStandardLayoutEntry(rel: string): boolean {
		// rel may end with "/" for dirs
		const trimmed = rel.endsWith("/") ? rel.slice(0, -1) : rel;
		const top = trimmed.split(path.sep)[0];
		if (!top) return false;
		return SKILL_STANDARD_LAYOUT.has(top);
	}

	function isLinkedSubpath(rel: string): boolean {
		const norm = rel.replace(/\\/g, "/");
		for (const sub of SKILL_LINKED_DIRS) {
			if (norm === sub) return false; // bare directory not allowed
			if (norm.startsWith(sub + "/")) return true;
		}
		return false;
	}

	pi.registerTool?.({
		name: "skill_manage",
		label: "Manage Skill",
		description:
			"Create, patch, rewrite, or delete a user skill under ~/.qapi/agent/skills/. Actions: create (new SKILL.md), patch (find/replace inside SKILL.md or a linked file), edit (rewrite SKILL.md), delete (remove skill dir), write_file (add a file under references/templates/scripts/assets), remove_file (delete one). All paths sandboxed under skills root.",
		parameters: SkillManageParams,
		async execute(
			_id: string,
			params: {
				action: string;
				name: string;
				category?: string;
				content?: string;
				file_path?: string;
				file_content?: string;
				old_string?: string;
				new_string?: string;
				replace_all?: boolean;
			},
		) {
			const action = params.action;
			const name = params.name;

			const restartHint = `(Skills are auto-loaded at session start. Restart the session to see ${name} in the available_skills list.)`;

			try {
				if (action === "create") {
					if (!params.content) {
						return {
							content: [
								{
									type: "text",
									text: "create: 'content' (SKILL.md body) is required",
								},
							],
							details: { error: "missing_content", action, name },
						};
					}
					if (params.category) {
						rejectTraversal(params.category);
					}
					rejectTraversal(name);

					const skillDir = params.category
						? path.join(SKILLS_ROOT, params.category, name)
						: path.join(SKILLS_ROOT, name);
					ensureUnderSkillsRoot(skillDir);

					if (fs.existsSync(skillDir)) {
						return {
							content: [
								{ type: "text", text: `skill already exists: ${skillDir}` },
							],
							details: { error: "exists", action, name, path: skillDir },
						};
					}
					fs.mkdirSync(skillDir, { recursive: true });
					const skillFile = path.join(skillDir, "SKILL.md");
					fs.writeFileSync(skillFile, params.content, "utf-8");
					return {
						content: [
							{
								type: "text",
								text: `Created skill ${name} at ${skillFile}\n${restartHint}`,
							},
						],
						details: {
							action,
							name,
							path: skillFile,
							skill_dir: skillDir,
							category: params.category,
						},
					};
				}

				if (action === "edit") {
					if (!params.content) {
						return {
							content: [
								{
									type: "text",
									text: "edit: 'content' (full SKILL.md) is required",
								},
							],
							details: { error: "missing_content", action, name },
						};
					}
					const skillDir = findUserSkillDir(name);
					if (!skillDir) {
						return {
							content: [
								{
									type: "text",
									text: `skill not found under user dir: ${name}. Use 'create' for new skills.`,
								},
							],
							details: { error: "not_found", action, name },
						};
					}
					ensureUnderSkillsRoot(skillDir);
					const skillFile = path.join(skillDir, "SKILL.md");
					if (!fs.existsSync(skillFile)) {
						return {
							content: [
								{
									type: "text",
									text: `SKILL.md missing in ${skillDir}. Use 'create' instead.`,
								},
							],
							details: { error: "missing_skill_md", action, name },
						};
					}
					fs.writeFileSync(skillFile, params.content, "utf-8");
					return {
						content: [{ type: "text", text: `Rewrote ${skillFile}` }],
						details: {
							action,
							name,
							path: skillFile,
							skill_dir: skillDir,
						},
					};
				}

				if (action === "patch") {
					if (params.old_string == null || params.new_string == null) {
						return {
							content: [
								{
									type: "text",
									text: "patch: 'old_string' and 'new_string' are required",
								},
							],
							details: { error: "missing_fields", action, name },
						};
					}
					const skillDir = findUserSkillDir(name);
					if (!skillDir) {
						return {
							content: [
								{
									type: "text",
									text: `skill not found under user dir: ${name}`,
								},
							],
							details: { error: "not_found", action, name },
						};
					}
					ensureUnderSkillsRoot(skillDir);
					const relTarget = params.file_path ?? "SKILL.md";
					rejectTraversal(relTarget);
					const target = ensureUnderDir(
						skillDir,
						path.resolve(skillDir, relTarget),
					);
					if (!fs.existsSync(target)) {
						return {
							content: [{ type: "text", text: `file not found: ${target}` }],
							details: { error: "not_found", action, name, path: target },
						};
					}
					const original = fs.readFileSync(target, "utf-8");
					const occurrences = original.split(params.old_string).length - 1;
					if (occurrences === 0) {
						return {
							content: [
								{
									type: "text",
									text: `patch: old_string not found in ${target}`,
								},
							],
							details: { error: "not_found", action, name, path: target },
						};
					}
					if (occurrences > 1 && params.replace_all !== true) {
						return {
							content: [
								{
									type: "text",
									text: `patch: old_string found ${occurrences}x in ${target}; pass replace_all:true or supply more context.`,
								},
							],
							details: {
								error: "not_unique",
								action,
								name,
								path: target,
								occurrences,
							},
						};
					}
					const updated = params.replace_all
						? original.split(params.old_string).join(params.new_string)
						: original.replace(params.old_string, params.new_string);
					fs.writeFileSync(target, updated, "utf-8");
					return {
						content: [
							{
								type: "text",
								text: `Patched ${target} (${occurrences} occurrence${occurrences === 1 ? "" : "s"}${params.replace_all ? ", replace_all" : ""}).`,
							},
						],
						details: {
							action,
							name,
							path: target,
							occurrences,
							replace_all: !!params.replace_all,
						},
					};
				}

				if (action === "delete") {
					const skillDir = findUserSkillDir(name);
					if (!skillDir) {
						return {
							content: [
								{
									type: "text",
									text: `skill not found under user dir: ${name}`,
								},
							],
							details: { error: "not_found", action, name },
						};
					}
					ensureUnderSkillsRoot(skillDir);
					const entries = listAllRelEntries(skillDir);
					const nonStandard = entries.filter(
						(rel) => !isStandardLayoutEntry(rel),
					);
					if (nonStandard.length > 0) {
						return {
							content: [
								{
									type: "text",
									text: `delete refused: skill contains non-standard files. Move or remove these first:\n${nonStandard.slice(0, 20).join("\n")}`,
								},
							],
							details: {
								error: "non_standard_files",
								action,
								name,
								path: skillDir,
								non_standard: nonStandard,
							},
						};
					}
					rmrf(skillDir);
					return {
						content: [
							{
								type: "text",
								text: `Deleted skill ${name} at ${skillDir}\n${restartHint}`,
							},
						],
						details: { action, name, path: skillDir },
					};
				}

				if (action === "write_file") {
					if (!params.file_path) {
						return {
							content: [
								{ type: "text", text: "write_file: 'file_path' is required" },
							],
							details: { error: "missing_file_path", action, name },
						};
					}
					if (params.file_content == null) {
						return {
							content: [
								{
									type: "text",
									text: "write_file: 'file_content' is required",
								},
							],
							details: { error: "missing_file_content", action, name },
						};
					}
					rejectTraversal(params.file_path);
					if (!isLinkedSubpath(params.file_path)) {
						return {
							content: [
								{
									type: "text",
									text: `write_file: file_path must start with one of references/, templates/, scripts/, assets/`,
								},
							],
							details: {
								error: "bad_subpath",
								action,
								name,
								file_path: params.file_path,
							},
						};
					}
					const skillDir = findUserSkillDir(name);
					if (!skillDir) {
						return {
							content: [
								{
									type: "text",
									text: `skill not found under user dir: ${name}`,
								},
							],
							details: { error: "not_found", action, name },
						};
					}
					ensureUnderSkillsRoot(skillDir);
					const target = ensureUnderDir(
						skillDir,
						path.resolve(skillDir, params.file_path),
					);
					ensureUnderSkillsRoot(target);
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.writeFileSync(target, params.file_content, "utf-8");
					return {
						content: [{ type: "text", text: `Wrote ${target}` }],
						details: {
							action,
							name,
							path: target,
							skill_dir: skillDir,
						},
					};
				}

				if (action === "remove_file") {
					if (!params.file_path) {
						return {
							content: [
								{ type: "text", text: "remove_file: 'file_path' is required" },
							],
							details: { error: "missing_file_path", action, name },
						};
					}
					rejectTraversal(params.file_path);
					if (params.file_path === "SKILL.md") {
						return {
							content: [
								{
									type: "text",
									text: `remove_file: cannot remove SKILL.md. Use 'delete' to remove the entire skill.`,
								},
							],
							details: { error: "protected_file", action, name },
						};
					}
					if (!isLinkedSubpath(params.file_path)) {
						return {
							content: [
								{
									type: "text",
									text: `remove_file: file_path must start with one of references/, templates/, scripts/, assets/`,
								},
							],
							details: {
								error: "bad_subpath",
								action,
								name,
								file_path: params.file_path,
							},
						};
					}
					const skillDir = findUserSkillDir(name);
					if (!skillDir) {
						return {
							content: [
								{
									type: "text",
									text: `skill not found under user dir: ${name}`,
								},
							],
							details: { error: "not_found", action, name },
						};
					}
					ensureUnderSkillsRoot(skillDir);
					const target = ensureUnderDir(
						skillDir,
						path.resolve(skillDir, params.file_path),
					);
					ensureUnderSkillsRoot(target);
					if (!fs.existsSync(target)) {
						return {
							content: [{ type: "text", text: `file not found: ${target}` }],
							details: { error: "not_found", action, name, path: target },
						};
					}
					fs.rmSync(target, { force: true });
					return {
						content: [{ type: "text", text: `Removed ${target}` }],
						details: {
							action,
							name,
							path: target,
							skill_dir: skillDir,
						},
					};
				}

				return {
					content: [{ type: "text", text: `unknown action: ${action}` }],
					details: { error: "bad_action", action, name },
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `skill_manage error: ${(e as Error).message}`,
						},
					],
					details: { error: "exception", action, name },
				};
			}
		},
	});

	// ---------- session_search FTS5 tool ----------

	const SESSIONS_DIR = path.join(os.homedir(), ".qapi", "agent", "sessions");
	const SESSIONS_DB = path.join(os.homedir(), ".qapi", "sessions.db");
	const SESSION_FILE_MIN_BYTES = 100;

	// Optional sqlite driver — discovered at first use via require (createRequire),
	// not via dynamic ES import. AGENTS.md forbids inline ES imports for TYPES;
	// runtime require of an optional native module is the conventional pattern.
	const sessionRequire = createRequire(import.meta.url);

	function loadSqlite(): { kind: "node" | "better"; api: unknown } | null {
		try {
			const m = sessionRequire("node:sqlite");
			return { kind: "node", api: m };
		} catch {}
		try {
			const Database = sessionRequire("better-sqlite3");
			return { kind: "better", api: Database };
		} catch {}
		return null;
	}

	type SqliteDb = {
		exec: (sql: string) => void;
		prepare: (sql: string) => {
			all: (...params: unknown[]) => unknown[];
			run: (...params: unknown[]) => unknown;
			get: (...params: unknown[]) => unknown;
		};
		close: () => void;
	};

	function openDb(driver: { kind: "node" | "better"; api: unknown }): SqliteDb {
		if (driver.kind === "better") {
			const Database = driver.api as new (p: string) => SqliteDb;
			return new Database(SESSIONS_DB);
		}
		// node:sqlite — DatabaseSync API
		const { DatabaseSync } = driver.api as { DatabaseSync: new (p: string) => SqliteDb };
		return new DatabaseSync(SESSIONS_DB);
	}

	function initSchema(db: SqliteDb): void {
		db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS sessions USING fts5(
			session_id UNINDEXED,
			source UNINDEXED,
			when_iso UNINDEXED,
			role UNINDEXED,
			preview UNINDEXED,
			content
		);`);
		db.exec(`CREATE TABLE IF NOT EXISTS index_meta (
			filename TEXT PRIMARY KEY,
			indexed_at_ms INTEGER NOT NULL
		);`);
	}

	function listSessionFiles(): string[] {
		if (!fs.existsSync(SESSIONS_DIR)) return [];
		const out: string[] = [];
		const walk = (d: string, depth: number): void => {
			if (depth > 4) return;
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(d, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const full = path.join(d, e.name);
				if (e.isDirectory()) {
					walk(full, depth + 1);
				} else if (e.isFile() && e.name.endsWith(".jsonl")) {
					out.push(full);
				}
			}
		};
		walk(SESSIONS_DIR, 0);
		return out;
	}

	function extractSessionContent(filePath: string): { content: string; role: string } | null {
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const lines = raw.split(/\r?\n/);
			const pieces: string[] = [];
			let lastRole = "mixed";
			for (const line of lines) {
				if (!line.trim()) continue;
				let ev: Record<string, unknown>;
				try {
					ev = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				const role = typeof ev.role === "string" ? (ev.role as string) : null;
				if (role) lastRole = role;
				const text = typeof ev.text === "string" ? (ev.text as string) : null;
				if (text) pieces.push(text);
				const content = ev.content;
				if (typeof content === "string") {
					pieces.push(content);
				} else if (Array.isArray(content)) {
					for (const part of content as Array<Record<string, unknown>>) {
						if (part && typeof part.text === "string") pieces.push(part.text as string);
					}
				}
			}
			if (pieces.length === 0) return null;
			return { content: pieces.join("\n"), role: lastRole };
		} catch {
			return null;
		}
	}

	function buildOrRefreshIndex(db: SqliteDb): { indexed: number; skipped: number } {
		initSchema(db);
		const metaRows = db.prepare("SELECT filename, indexed_at_ms FROM index_meta").all() as Array<{
			filename: string;
			indexed_at_ms: number;
		}>;
		const metaMap = new Map<string, number>();
		for (const r of metaRows) metaMap.set(r.filename, r.indexed_at_ms);

		const files = listSessionFiles();
		let indexed = 0;
		let skipped = 0;

		const del = db.prepare("DELETE FROM sessions WHERE session_id = ?");
		const ins = db.prepare(
			"INSERT INTO sessions (session_id, source, when_iso, role, preview, content) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const upMeta = db.prepare(
			"INSERT INTO index_meta (filename, indexed_at_ms) VALUES (?, ?) ON CONFLICT(filename) DO UPDATE SET indexed_at_ms = excluded.indexed_at_ms",
		);

		for (const file of files) {
			let stat: fs.Stats;
			try {
				stat = fs.statSync(file);
			} catch {
				skipped++;
				continue;
			}
			if (stat.size < SESSION_FILE_MIN_BYTES) {
				skipped++;
				continue;
			}
			const mtime = stat.mtimeMs;
			const prev = metaMap.get(file);
			if (prev !== undefined && prev >= mtime) continue;

			const extracted = extractSessionContent(file);
			if (!extracted) {
				skipped++;
				continue;
			}
			const sessionId = path.basename(file, ".jsonl");
			const whenIso = new Date(mtime).toISOString();
			const preview = extracted.content.slice(0, 240).replace(/\s+/g, " ");
			del.run(sessionId);
			ins.run(sessionId, "local", whenIso, extracted.role, preview, extracted.content);
			upMeta.run(file, Math.floor(mtime));
			indexed++;
		}

		return { indexed, skipped };
	}

	const SessionSearchParams = Type.Object({
		query: Type.Optional(Type.String({ description: "FTS5 query. Omit to list recent sessions." })),
		limit: Type.Optional(Type.Number({ description: "Max results", default: 3 })),
		role_filter: Type.Optional(Type.String({ description: "Comma-separated role filter (user,assistant,tool)" })),
	});

	pi.registerTool?.({
		name: "session_search",
		label: "Session Search",
		description:
			"Search past qa-pi sessions by keyword (FTS5). Omit query to list recent sessions. Lazy-indexed at ~/.qapi/sessions.db; only changed files re-index. Requires node:sqlite (Node ≥22.5) or better-sqlite3; gracefully no-ops if neither available.",
		parameters: SessionSearchParams,
		async execute(_id, params: { query?: string; limit?: number; role_filter?: string }) {
			const driver = loadSqlite();
			if (!driver) {
				return {
					content: [
						{
							type: "text",
							text:
								"session_search unavailable: no sqlite driver found. Install better-sqlite3 in qa-pi or upgrade to Node ≥22.5 with node:sqlite to enable past-session recall.",
						},
					],
					details: { error: "no_sqlite_driver" },
				};
			}
			let db: SqliteDb;
			try {
				db = openDb(driver);
			} catch (e) {
				return {
					content: [{ type: "text", text: `session_search: failed to open db: ${(e as Error).message}` }],
					details: { error: "db_open_failed" },
				};
			}
			try {
				const stats = buildOrRefreshIndex(db);
				const limit = Math.max(1, Math.min(20, params.limit ?? 3));
				const roleFilter = params.role_filter
					? params.role_filter.split(",").map((s) => s.trim()).filter(Boolean)
					: null;

				let results: Array<{ session_id: string; when: string; preview: string; score?: number }> = [];
				if (!params.query || params.query.trim() === "") {
					let sql =
						"SELECT session_id, when_iso, preview, role FROM sessions";
					const args: unknown[] = [];
					if (roleFilter && roleFilter.length > 0) {
						sql += ` WHERE role IN (${roleFilter.map(() => "?").join(",")})`;
						args.push(...roleFilter);
					}
					sql += " ORDER BY when_iso DESC LIMIT ?";
					args.push(limit);
					const rows = db.prepare(sql).all(...args) as Array<{
						session_id: string;
						when_iso: string;
						preview: string;
						role: string;
					}>;
					results = rows.map((r) => ({ session_id: r.session_id, when: r.when_iso, preview: r.preview }));
				} else {
					let sql =
						"SELECT session_id, when_iso, preview, role, bm25(sessions) AS score FROM sessions WHERE sessions MATCH ?";
					const args: unknown[] = [params.query];
					if (roleFilter && roleFilter.length > 0) {
						sql += ` AND role IN (${roleFilter.map(() => "?").join(",")})`;
						args.push(...roleFilter);
					}
					sql += " ORDER BY score ASC LIMIT ?";
					args.push(limit);
					const rows = db.prepare(sql).all(...args) as Array<{
						session_id: string;
						when_iso: string;
						preview: string;
						role: string;
						score: number;
					}>;
					results = rows.map((r) => ({
						session_id: r.session_id,
						when: r.when_iso,
						preview: r.preview,
						score: r.score,
					}));
				}

				const lines: string[] = [];
				lines.push(
					`Found ${results.length} session(s)${params.query ? ` matching "${params.query}"` : " (most recent)"}. Index: ${stats.indexed} updated, ${stats.skipped} skipped.`,
				);
				for (const r of results) {
					lines.push("");
					lines.push(`- ${r.session_id} (${r.when})${r.score !== undefined ? ` [score=${r.score.toFixed(3)}]` : ""}`);
					lines.push(`  ${r.preview}`);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { count: results.length, results, index_stats: stats },
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `session_search error: ${(e as Error).message}` }],
					details: { error: "exception" },
				};
			} finally {
				try {
					db.close();
				} catch {}
			}
		},
	});

		pi.on?.("session_end", async () => {
		for (const c of mcpClients.values()) c.stop();
		mcpClients.clear();
	});
}
