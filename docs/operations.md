# Agent Bridge Operations & Runbook Guide

*Document Version: 1.2.0 (Mission 4 Ship-Ready)*

---

## 1. Quickstart & Installation

```bash
# Clone and enter directory
cd /Users/jayanthpranaykonada/agent-bridge

# Install dependencies (only @modelcontextprotocol/sdk, zero heavy bloat)
npm install

# Run comprehensive system diagnostic
node bin/bridge.js doctor
```

---

## 2. Configuration & Doctor

The bridge configuration is defined in `src/config.js` and resolved via environment variables.

### Running Doctor
```bash
node bin/bridge.js doctor
```

Validates:
- `Config Integrity`: Valid JSON/JS config structure.
- `Auth Key Entropy`: Control plane key present with adequate length and entropy.
- `Database Schema`: Current SQLite schema version and migrations.
- `Allowed Roots`: `ALLOWED_ROOTS` canonicalization and symlink checks.
- `Port Availability`: Ports 8765 and 8768 availability.
- `Disk Space`: Adequate headroom (> 1GB) on host volume.

---

## 3. Starting the Bridge

### MCP Mode (Standard Claude / Antigravity integration):
```bash
node src/mcp-server.js --agent antigravity-ide
```

### Local Gateway & HTTP Control Plane:
```bash
node src/index.js
```

### Command Center Dashboard:
```bash
node bin/bridge.js dashboard --port 8768
```

---

## 4. Online-Safe Backup & Restore

Agent Bridge provides atomic, online-safe backup and restore for SQLite state and the Content-Addressed Storage (CAS) blob store:

### Creating a Backup
```bash
node bin/bridge.js backup ./backups/bridge-backup-$(date +%s)
```
- Uses SQLite `VACUUM INTO` for atomic, non-locking database snapshotting.
- Copies CAS blob directory.
- Writes cryptographic manifest with SHA-256 hashes.

### Restoring from Backup
```bash
node bin/bridge.js restore ./backups/bridge-backup-<timestamp>
```
- Validates manifest SHA-256 signatures before touching disk.
- Atomically replaces database and verifies `PRAGMA integrity_check`.

---

## 5. Retention Pruning

To keep SQLite database size and memory usage bounded:
```bash
# Prune terminal requests and audit logs older than 72 hours
node bin/bridge.js prune 72
```

---

## 6. Troubleshooting by Failure Stage

| Stage | Symptom | Remediation |
|---|---|---|
| `DISCOVERY` | `Agent not found in manifest` | Run `node bin/bridge.js agent verify <id>` or `node bin/bridge.js agent add <id>`. |
| `AUTHENTICATION` | `HTTP 401 Unauthorized` | Provide valid `x-api-key` header matching `CONFIG.CONTROL_PLANE.API_KEY`. |
| `SECURITY_GATE` | `HTTP 403 Forbidden` | Non-loopback Host header or browser Origin detected. Request must originate on `127.0.0.1`. |
| `CLAIM_LEASE` | `LEASE_ACTIVE` | Another worker is processing request. Wait for lease expiration or run `node bin/bridge.js prune`. |
| `FENCING` | `FENCED_ATTEMPT_ERROR` | An older attempt was superseded by a newer epoch. Resubmit with current epoch. |
| `LIVE_GATE` | `LIVE_GATE_STOP` | Live verification attempted without `--confirm-live-run` or human presence. |

---

## 7. Explaining a Request Timeline

To inspect the exact lifecycle timeline of any request:
```bash
node bin/bridge.js explain <requestId>
```
Prints monotonic stage timestamps, latencies, current state, and the next recovery action.

---

## 8. Control-Plane Key Migration & Security Posture

### 8.1 Fresh Install vs. Existing Install Behavior
- **Fresh Install (No existing database or key)**:
  Agent Bridge automatically provisions a 24-byte random authentication key stored in `data/.control_plane_key` with mode `0600` (and attempts to save to the macOS Keychain). The control plane requires this key by default.
- **Existing Install (Database already exists)**:
  To avoid silently breaking existing integrations, Agent Bridge does not automatically generate or inject a new key into existing deployments. If no key is set, `bridge doctor` will flag a loud failing check instructing the operator to configure one.

### 8.2 Migration Path for Existing Deployments
To securely configure a control-plane key for an existing deployment:
1. **Generate a high-entropy secret**:
   ```bash
   KEY=$(openssl rand -hex 24)
   ```
2. **Choose one persistence mechanism**:
   - **Environment Variable (Recommended for CLI / Containers)**:
     ```bash
     export AGENT_BRIDGE_API_KEY="$KEY"
     ```
   - **0600 File in Data Directory (Recommended for Headless Daemons)**:
     ```bash
     echo "$KEY" > data/.control_plane_key
     chmod 0600 data/.control_plane_key
     ```
   - **macOS Keychain (Recommended for macOS Desktop Workstations)**:
     ```bash
     security add-generic-password -U -s agent-bridge -a control_plane_api_key -w "$KEY"
     ```
3. **Verify with Doctor**:
   ```bash
   node bin/bridge.js doctor
   ```

### 8.3 Allowed Roots & Zia Project Isolation
- **Allowed Roots**: Defaults strictly to the Agent Bridge repository root (`/Users/.../agent-bridge`) and `test-workspace/`. To configure extra project roots safely, create a user configuration file at `config/allowed-roots.json` with an array of absolute or relative paths:
  ```json
  [
    "/Users/operator/workspace/my-project"
  ]
  ```
- **Zia Project Protection**: `CONFIG.ZIA_WRITE_LOCKED` defaults to `true`. All mutation operations attempting to write to or modify files in `/Users/jayanthpranaykonada/Zia` (including through symlinks) are strictly denied by `PermissionGuard`.

