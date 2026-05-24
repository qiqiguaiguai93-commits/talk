const { spawn, execSync } = require("child_process");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

// Kill any lingering processes on port 5123
try {
  const out = execSync('netstat -ano | findstr :5123', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = out.trim().split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && pid !== '0') {
      try { execSync(`taskkill //F //PID ${pid} 2>nul`, { stdio: 'ignore' }); } catch (_) {}
    }
  }
} catch (_) {}

// Clean env: remove ELECTRON_RUN_AS_NODE
const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const electron = require("electron");
const child = spawn(String(electron), [".", ...process.argv.slice(2)], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  env: cleanEnv,
});

child.on("exit", (code) => process.exit(code || 0));
