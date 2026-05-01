#!/usr/bin/env node
/**
 * qa-pi postinstall — copies bundled QA extension + agents to ~/.qapi/agent/
 * Idempotent: re-running upgrades bundled files but preserves user-edited copies.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PKG_DIR = path.resolve(ROOT, "..");
const HOME_QAPI = path.join(os.homedir(), ".qapi", "agent");

async function copyDir(src, dst, { preserveExisting = false } = {}) {
	await fs.mkdir(dst, { recursive: true });
	for (const entry of await fs.readdir(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		const d = path.join(dst, entry.name);
		if (entry.isDirectory()) {
			await copyDir(s, d, { preserveExisting });
		} else {
			if (preserveExisting) {
				try { await fs.access(d); continue; } catch {}
			}
			await fs.copyFile(s, d);
		}
	}
}

async function main() {
	try {
		// Bundled extension → ~/.qapi/agent/extensions/qa-pi/
		const extSrc = path.join(PKG_DIR, "qa-extension");
		const extDst = path.join(HOME_QAPI, "extensions", "qa-pi");
		await copyDir(extSrc, extDst);

		// Bundled agents → ~/.qapi/agent/agents/  (overwrite to ship updates)
		const agSrc = path.join(PKG_DIR, "qa-agents");
		const agDst = path.join(HOME_QAPI, "agents");
		await fs.mkdir(agDst, { recursive: true });
		for (const entry of await fs.readdir(agSrc, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			if (["ARCHITECTURE.md", "MCP-SETUP.md", "README.md"].includes(entry.name)) continue;
			await fs.copyFile(path.join(agSrc, entry.name), path.join(agDst, entry.name));
		}

		// MCP config — preserve user edits
		const mcpSrc = path.join(agSrc, "qa-mcp.default.json");
		const mcpDst = path.join(HOME_QAPI, "qa-mcp.json");
		try { await fs.access(mcpDst); }
		catch { await fs.copyFile(mcpSrc, mcpDst); }

		console.log("qa-pi: installed extension + 7 subagents to", HOME_QAPI);
	} catch (e) {
		console.error("qa-pi postinstall failed (non-fatal):", e.message);
	}
}

main();
