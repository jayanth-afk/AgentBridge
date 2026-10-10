# Vetting & Security Audit — mcp-builder

- **Skill Name:** `mcp-builder`
- **Source Repository:** `https://github.com/anthropics/skills.git`
- **Pinned Commit SHA:** `dbd4588f9e1033efb41dad4bef2f7947c8993d44`
- **Path in Source:** `skills/mcp-builder`
- **License:** MIT License (`LICENSE.txt`)
- **Vetted By:** Antigravity (Primary Writer)
- **Selection Source:** Freebuff Tier 1 candidate #1 (`agent-bridge-handoff/.scratch/skills-quarantine/SHORTLIST.md`)
- **Date Vetted:** 2026-10-10

---

## 1. Domain Match & Purpose
`agent-bridge` operates as an MCP server with a 74-tool registry, supporting `stdio` and `streamable_http` transports, profile-based token surfaces, and zero-waste inter-agent delivery.
`mcp-builder` provides official architectural guidelines, best practices, and reference implementations for high-quality MCP servers, tool schema conventions, and evaluation frameworks.

## 2. Security & Invariant Inspection
- **Autonomous Git Push / Write:** NONE. Inspected `SKILL.md`, `reference/*.md`, and `scripts/*.py`. Zero git commands or git repository mutations exist in this skill.
- **Protected Branch Invariant:** FULLY COMPLIANT. Does not attempt to push, branch, merge, or rebase.
- **Destructive Commands:** NONE. Contains no destructive filesystem commands (`rm -rf`, `reset`, `clean`, etc.).
- **Network Egress / Telemetry:** NONE. The bundled Python scripts (`connections.py`, `evaluation.py`) are client-side test harnesses connecting strictly to user-specified local stdio or user-provided server URLs.
- **Dependency Surface:** Optional Python scripts require standard packages (`anthropic`, `mcp`), noted in `scripts/requirements.txt`. No global shell hooks or daemon processes.

## 3. Installation Mode
- **Mode:** Full directory copy (`--copy`), NOT symlinked.
- **Repository Path:** `.agents/skills/mcp-builder/`
- **Quarantine Mirror:** `agent-bridge-handoff/.scratch/skills-quarantine/vetted/mcp-builder/`
- **Regression Impact:** Zero impact on existing test suite or runtime modules.
