import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

// Approved root configuration - STRICTLY LOCKED to Zia
export const APPROVED_ROOT = path.resolve('/Users/jayanthpranaykonada/Zia');

// Security patterns for sensitive files that must never be exposed
const SENSITIVE_PATTERNS = [
  /^\.env/i,
  /\.env(\..+)?$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credentials(\.json)?$/i,
  /service-account.*\.json$/i,
  /\.npmrc$/i,
  /\.yarnrc$/i,
  /\.netrc$/i,
  /\.git-credentials$/i,
  /secret/i,
  /password/i
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svgz',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z',
  '.exe', '.bin', '.dll', '.dylib', '.so', '.a', '.o',
  '.pyc', '.class', '.jar', '.wasm', '.mov', '.mp4', '.mp3',
  '.sqlite', '.sqlite3', '.db', '.DS_Store'
]);

const MAX_READ_BYTES = 512 * 1024; // 512 KB
const MAX_SEARCH_RESULTS = 50;

/**
 * Validates that an input path stays strictly inside APPROVED_ROOT.
 * Resolves symlinks to ensure they do not escape the root.
 */
export function sanitizeAndValidatePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Invalid path: must be a non-empty string');
  }

  let resolved;
  if (path.isAbsolute(inputPath)) {
    resolved = path.resolve(inputPath);
  } else {
    resolved = path.resolve(APPROVED_ROOT, inputPath);
  }

  // Prevent path traversal
  if (resolved !== APPROVED_ROOT && !resolved.startsWith(APPROVED_ROOT + path.sep)) {
    throw new Error(`Security Violation: Path "${inputPath}" resolves outside approved root (${APPROVED_ROOT})`);
  }

  // Prevent symlink escape
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    if (real !== APPROVED_ROOT && !real.startsWith(APPROVED_ROOT + path.sep)) {
      throw new Error(`Security Violation: Symlink target "${real}" points outside approved root (${APPROVED_ROOT})`);
    }
    return real;
  }

  return resolved;
}

export function isSensitive(filePath) {
  const base = path.basename(filePath);
  return SENSITIVE_PATTERNS.some(pat => pat.test(base));
}

export function isBinary(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (buffer) {
    const checkLen = Math.min(buffer.length, 1024);
    for (let i = 0; i < checkLen; i++) {
      if (buffer[i] === 0) return true;
    }
  }
  return false;
}

// Read-only tools definition with mandatory hints
export const READONLY_TOOLS = [
  {
    name: 'readonly_list_directory',
    description: 'List files and directories under the approved root (/Users/jayanthpranaykonada/Zia).',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path under Zia root (e.g. "." or "Sources")'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'readonly_read_file',
    description: 'Read the text contents of a file under the approved root (/Users/jayanthpranaykonada/Zia).',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path under Zia root (e.g. "Package.swift" or "AGENTS.md")'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'readonly_search_files',
    description: 'Search text files under the approved root for a query string.',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text substring to search for'
        },
        path: {
          type: 'string',
          description: 'Subdirectory to search inside (optional, defaults to root)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'readonly_file_info',
    description: 'Retrieve safe file metadata (size, modification date, extension) under the approved root.',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path under Zia root to inspect'
        }
      },
      required: ['path']
    }
  }
];

// Tool execution logic
export async function executeReadonlyTool(name, args = {}) {
  switch (name) {
    case 'readonly_list_directory': {
      const targetPath = sanitizeAndValidatePath(args.path || '.');
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isDirectory()) {
        throw new Error(`Path is not a directory: ${args.path}`);
      }

      const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
      const results = [];

      for (const entry of entries) {
        // Skip hidden sensitive files
        if (isSensitive(entry.name)) continue;

        const fullChildPath = path.join(targetPath, entry.name);
        let size = 0;
        let modifiedAt = null;

        try {
          const s = await fs.promises.stat(fullChildPath);
          size = s.size;
          modifiedAt = s.mtime.toISOString();
        } catch {
          // Ignore inaccessible files
        }

        results.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          size,
          modifiedAt
        });
      }

      return {
        path: path.relative(APPROVED_ROOT, targetPath) || '.',
        root: APPROVED_ROOT,
        count: results.length,
        entries: results
      };
    }

    case 'readonly_read_file': {
      const targetPath = sanitizeAndValidatePath(args.path);
      if (isSensitive(targetPath)) {
        throw new Error(`Access Denied: File "${path.basename(targetPath)}" is blocked by security policy.`);
      }

      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile()) {
        throw new Error(`Path is not a file: ${args.path}`);
      }

      if (stat.size > MAX_READ_BYTES) {
        throw new Error(`File size (${stat.size} bytes) exceeds read limit of ${MAX_READ_BYTES} bytes.`);
      }

      const buffer = await fs.promises.readFile(targetPath);
      if (isBinary(targetPath, buffer)) {
        throw new Error(`Cannot read binary file "${path.basename(targetPath)}" as text.`);
      }

      const content = buffer.toString('utf8');
      const lines = content.split('\n');

      return {
        path: path.relative(APPROVED_ROOT, targetPath),
        size: stat.size,
        lineCount: lines.length,
        content
      };
    }

    case 'readonly_search_files': {
      const { query, path: subPath = '.' } = args;
      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('Query string must not be empty.');
      }

      const startDir = sanitizeAndValidatePath(subPath);
      const matches = [];

      async function walk(currentDir) {
        if (matches.length >= MAX_SEARCH_RESULTS) return;

        let entries;
        try {
          entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (matches.length >= MAX_SEARCH_RESULTS) return;

          // Skip hidden directories like .git and build caches
          if (entry.name === '.git' || entry.name === '.build' || entry.name === 'node_modules') continue;
          if (isSensitive(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            if (isBinary(fullPath)) continue;

            try {
              const stat = await fs.promises.stat(fullPath);
              if (stat.size > MAX_READ_BYTES) continue;

              const content = await fs.promises.readFile(fullPath, 'utf8');
              const lines = content.split('\n');

              for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                if (matches.length >= MAX_SEARCH_RESULTS) break;

                const line = lines[lineIndex];
                if (line.includes(query)) {
                  matches.push({
                    file: path.relative(APPROVED_ROOT, fullPath),
                    lineNumber: lineIndex + 1,
                    snippet: line.trim().slice(0, 200)
                  });
                }
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      }

      await walk(startDir);

      return {
        query,
        root: APPROVED_ROOT,
        matchCount: matches.length,
        capped: matches.length >= MAX_SEARCH_RESULTS,
        matches
      };
    }

    case 'readonly_file_info': {
      const targetPath = sanitizeAndValidatePath(args.path);
      const stat = await fs.promises.stat(targetPath);

      return {
        path: path.relative(APPROVED_ROOT, targetPath) || '.',
        root: APPROVED_ROOT,
        size: stat.size,
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        extension: path.extname(targetPath).toLowerCase(),
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        isSensitive: isSensitive(targetPath)
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Creates and starts the Read-Only MCP Server in Stdio mode.
 */
export async function startStdioServer() {
  const server = new Server(
    {
      name: 'zia-readonly-bridge',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: READONLY_TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const result = await executeReadonlyTool(name, args);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: err.message }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

/**
 * Creates and starts the Streamable HTTP MCP Server.
 */
export function startHttpServer(port = 8766, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      const url = new URL(req.url, `http://${host}:${port}`);

      // Diagnostic health endpoint
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          status: 'ok',
          service: 'zia-readonly-mcp-server',
          approvedRoot: APPROVED_ROOT,
          tools: READONLY_TOOLS.map(t => t.name)
        }));
      }

      // MCP endpoint handling Streamable HTTP JSON-RPC
      if (url.pathname === '/mcp' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const { jsonrpc = '2.0', id = 1, method, params = {} } = data;

            // 1. Initialize Handshake
            if (method === 'initialize') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: {
                    tools: { listChanged: false }
                  },
                  serverInfo: {
                    name: 'zia-readonly-bridge',
                    version: '1.0.0'
                  }
                }
              }));
            }

            // 2. Initialized Notification
            if (method === 'notifications/initialized') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ jsonrpc: '2.0' }));
            }

            // 3. Tools Listing
            if (method === 'tools/list') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  tools: READONLY_TOOLS
                }
              }));
            }

            // 4. Tools Calling
            if (method === 'tools/call') {
              const { name, arguments: args = {} } = params;
              try {
                const result = await executeReadonlyTool(name, args);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                      }
                    ]
                  }
                }));
              } catch (toolErr) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify({ error: toolErr.message }, null, 2)
                      }
                    ],
                    isError: true
                  }
                }));
              }
            }

            // Method Not Found
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Method not found: ${method}` }
            }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32700, message: `Parse error: ${err.message}` }
            }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    });

    server.listen(port, host, () => {
      resolve({ server, port, host, endpoint: `http://${host}:${port}/mcp` });
    });

    server.on('error', reject);
  });
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('readonly-mcp-server.js')) {
  if (process.argv.includes('--stdio')) {
    startStdioServer().catch(err => {
      console.error('Failed to start stdio read-only server:', err);
      process.exit(1);
    });
  } else {
    const portArgIndex = process.argv.indexOf('--port');
    const port = portArgIndex !== -1 ? parseInt(process.argv[portArgIndex + 1], 10) : 8766;
    startHttpServer(port).then(({ port, endpoint }) => {
      console.log(`[ReadOnly MCP] Streamable HTTP server listening on ${endpoint}`);
      console.log(`[ReadOnly MCP] Locked approved root: ${APPROVED_ROOT}`);
    }).catch(err => {
      console.error('Failed to start HTTP read-only server:', err);
      process.exit(1);
    });
  }
}
