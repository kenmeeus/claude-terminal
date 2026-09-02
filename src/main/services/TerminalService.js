/**
 * Terminal Service
 * Manages PTY terminal processes
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { execFileSync } = require('child_process');
const terminalCapture = require('./TerminalOutputCapture');

/**
 * Whether a spawned `claude` should carry `--rc`.
 *
 * Read through the service rather than from settings.json directly, so the
 * managed-settings kill switch and the opt-in rules live in exactly one place.
 * Never throws: a terminal must still open when the setting cannot be read.
 */
function _remoteControlEnabled() {
  try {
    return require('./RemoteControlService').launchesTerminalsConnected();
  } catch (_) {
    return false;
  }
}

/**
 * Windows-only: directories holding executables the terminal must spawn but
 * that live on the *user* PATH rather than the system PATH.
 *
 * After a reboot Windows can relaunch the app (auto session restore, "reopen
 * my apps", a startup entry) before the full user PATH has been applied. In
 * that window `%APPDATA%\npm` — where the npm-global `claude` shim lives — is
 * absent from PATH, so node-pty's CreateProcess (and cmd's own lookup of
 * `claude`) fails with a bare "File not found". Plain shell tabs still work
 * because their shell lives in System32 (always on the system PATH), which is
 * exactly the asymmetry the user sees. We guarantee these dirs on the spawn
 * env's PATH (appended, so the user's own precedence is kept) and resolve the
 * shell to an absolute path so spawning never depends on an incomplete PATH.
 */
function windowsSpawnPathDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  dirs.push(path.join(programFiles, 'nodejs'));
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  dirs.push(path.join(sysRoot, 'System32'));
  dirs.push(path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0'));
  return dirs;
}

/** Copy of process.env with the dirs above guaranteed on PATH (Windows only). */
function buildTerminalEnv() {
  const env = { ...process.env };
  if (process.platform !== 'win32') return env;
  const current = env.PATH || env.Path || '';
  const have = current.split(';').map(p => p.trim().toLowerCase()).filter(Boolean);
  const missing = windowsSpawnPathDirs().filter(d => d && !have.includes(d.toLowerCase()));
  // Always assign: when Windows spells the key `Path` and nothing is missing,
  // skipping this would leave PATH unset and the delete below would drop the
  // only search path the terminal has.
  // Append, never prepend: a user who keeps the stock Node dir off PATH on
  // purpose (nvm-windows, volta) must keep their own node/npm winning.
  env.PATH = missing.length ? current + (current ? ';' : '') + missing.join(';') : current;
  // Normalise on PATH so consumers don't read a stale differently-cased `Path`.
  if ('Path' in env) delete env.Path;
  return env;
}

/**
 * Resolve a Windows executable to an absolute path: try the (possibly
 * incomplete) live PATH via where.exe first, then probe the known dirs.
 * Falls back to the bare name so behaviour never regresses if resolution
 * fails — the augmented spawn env is the safety net in that case.
 */
const _resolvedExecutables = new Map();

function resolveWindowsExecutable(name, extraDirs) {
  // Successful lookups are cached: `where.exe` is a synchronous child process
  // (up to 5 s) on the main thread and a shell's location does not move.
  if (_resolvedExecutables.has(name)) return _resolvedExecutables.get(name);
  const resolved = _lookupWindowsExecutable(name, extraDirs);
  if (resolved !== name) _resolvedExecutables.set(name, resolved);
  return resolved;
}

function _lookupWindowsExecutable(name, extraDirs) {
  try {
    const hit = execFileSync('where.exe', [name], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      .trim().split(/\r?\n/)[0];
    if (hit && fs.existsSync(hit)) return hit;
  } catch { /* not resolvable on the current PATH */ }
  const hasExt = /\.(exe|cmd|bat)$/i.test(name);
  for (const dir of extraDirs || []) {
    for (const ext of hasExt ? [''] : ['.cmd', '.exe', '.bat', '']) {
      const candidate = path.join(dir, name + ext);
      try { if (fs.existsSync(candidate)) return candidate; } catch { /* skip */ }
    }
  }
  return name;
}

class TerminalService {
  constructor() {
    this.terminals = new Map();
    this.terminalId = 0;
    this.mainWindow = null;
    /**
     * Optional callback fired when a PTY exits.
     * Signature: ({ terminalId, exitCode, signal, projectId?, projectPath? }) => void
     * Wired by main.js so workflow triggers can subscribe without creating a
     * circular dep between TerminalService and WorkflowService.
     */
    this.onExitCallback = null;
  }

  /**
   * Set the main window reference for IPC communication
   * @param {BrowserWindow} window
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Send data to renderer safely (checks if window is destroyed)
   * @param {string} channel - IPC channel
   * @param {Object} data - Data to send
   */
  sendToRenderer(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Create a new terminal
   * @param {Object} options
   * @param {string} options.cwd - Working directory
   * @param {boolean} options.runClaude - Whether to run Claude CLI on start
   * @param {boolean} options.skipPermissions - Skip permissions flag for Claude
   * @param {string} options.resumeSessionId - Session ID to resume
   * @returns {Object} - { success: boolean, id?: number, error?: string }
   */
  create({ cwd, runClaude, skipPermissions, resumeSessionId, projectId, projectPath, accountEnv = null }) {
    const id = ++this.terminalId;
    let shellPath = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    let shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [];

    // Validate and resolve working directory
    let effectiveCwd = os.homedir();
    if (cwd) {
      try {
        if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
          effectiveCwd = cwd;
        } else {
          console.warn(`Terminal cwd does not exist: ${cwd}, using home directory`);
        }
      } catch (e) {
        console.warn(`Error checking cwd: ${e.message}, using home directory`);
      }
    }

    // If running Claude, spawn it directly via cmd.exe /c (no shell banner, no prompt)
    if (runClaude && process.platform === 'win32') {
      // Keep the bare `claude` on the cmd line: the spawn env below carries a
      // PATH with %APPDATA%\npm guaranteed (see windowsSpawnPathDirs), which is
      // the fix for the intermittent "File not found" after a reboot relaunch.
      // An absolute path here would be parsed by cmd.exe, and a profile dir
      // containing `&` or `^` (e.g. C:\Users\R&D) would split the command.
      const claudeArgs = ['claude'];
      if (resumeSessionId && /^[a-f0-9\-]{8,64}$/.test(resumeSessionId)) {
        claudeArgs.push('--resume', resumeSessionId);
      }
      if (skipPermissions) {
        claudeArgs.push('--dangerously-skip-permissions');
      }
      // Connect this CLI to Remote Control, so the terminal tab shows up on
      // claude.ai alongside the mirrored chat tabs.
      if (_remoteControlEnabled()) {
        claudeArgs.push('--rc');
      }
      shellPath = 'cmd.exe';
      shellArgs = ['/c', ...claudeArgs];
    }

    // Resolve the shell itself to an absolute path on Windows for the same
    // reason, and spawn with an env whose PATH is guaranteed complete.
    const spawnEnv = buildTerminalEnv();
    if (process.platform === 'win32') {
      shellPath = resolveWindowsExecutable(shellPath, windowsSpawnPathDirs());
    }

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: effectiveCwd,
        // A project pinned to an account gets that account's credential store;
        // everything else in ~/.claude stays shared.
        env: accountEnv ? { ...spawnEnv, ...accountEnv } : spawnEnv
      });

      if (!ptyProcess) {
        throw new Error('PTY process creation returned null');
      }
    } catch (error) {
      console.error('Failed to spawn terminal:', error);
      this.sendToRenderer('terminal-error', {
        id,
        error: `Failed to create terminal: ${error.message}`
      });
      return { success: false, error: error.message };
    }

    // Tag the PTY with project metadata so onExit can reference it.
    // `command` records what was actually launched (shell or Claude CLI), used
    // by terminal_exit_code workflow triggers for commandPattern filtering.
    ptyProcess._meta = {
      projectId:   projectId || null,
      projectPath: projectPath || cwd || null,
      command:     [shellPath, ...(shellArgs || [])].join(' ').trim(),
    };

    this.terminals.set(id, ptyProcess);

    // Handle data output - adaptive batching to reduce IPC flooding
    // 4ms flush when idle (responsive typing), 16ms normal, 32ms when flooding
    let buffer = '';
    let flushScheduled = false;
    let lastFlush = Date.now();

    const dataDisposable = ptyProcess.onData(data => {
      buffer += data;
      if (!flushScheduled) {
        flushScheduled = true;
        const sinceLastFlush = Date.now() - lastFlush;
        const delay = buffer.length > 10000 ? 32 : sinceLastFlush > 100 ? 4 : 16;
        setTimeout(() => {
          this.sendToRenderer('terminal-data', { id, data: buffer });
          // Persist a rolling tail per project. Buffered and written on its own
          // timer, so this adds no disk I/O to the render path.
          terminalCapture.record(ptyProcess._meta?.projectId, buffer);
          buffer = '';
          flushScheduled = false;
          lastFlush = Date.now();
        }, delay);
      }
    });

    // Handle exit
    const exitDisposable = ptyProcess.onExit((evt) => {
      if (ptyProcess._exited) return;
      ptyProcess._exited = true;
      const exitCode = (evt && Number.isFinite(evt.exitCode)) ? evt.exitCode : null;
      const signal   = (evt && evt.signal != null) ? evt.signal : null;
      try { ptyProcess.kill(); } catch (e) {}
      this.terminals.delete(id);
      // Persist whatever the process printed on its way out, before anything
      // can read the log looking for the failure.
      terminalCapture.flush();
      this.sendToRenderer('terminal-exit', { id, exitCode, signal });
      // Fire workflow trigger callback (non-blocking)
      if (typeof this.onExitCallback === 'function') {
        try {
          this.onExitCallback({
            terminalId:  id,
            exitCode,
            signal,
            projectId:   ptyProcess._meta?.projectId || null,
            projectPath: ptyProcess._meta?.projectPath || null,
            command:     ptyProcess._meta?.command || null,
          });
        } catch (cbErr) {
          console.warn('[TerminalService] onExitCallback error:', cbErr.message);
        }
      }
    });

    // Store disposables for cleanup on kill()
    ptyProcess._disposables = [dataDisposable, exitDisposable];

    // Run Claude CLI on non-Windows platforms
    if (runClaude && process.platform !== 'win32') {
      setTimeout(() => {
        let claudeCmd = 'claude';
        if (resumeSessionId) {
          // Validate session ID format to prevent shell injection via PTY
          if (/^[a-f0-9\-]{8,64}$/.test(resumeSessionId)) {
            claudeCmd += ` --resume ${resumeSessionId}`;
          }
        }
        if (skipPermissions) {
          claudeCmd += ' --dangerously-skip-permissions';
        }
        // See the Windows branch above.
        if (_remoteControlEnabled()) {
          claudeCmd += ' --rc';
        }
        try { ptyProcess.write(claudeCmd + '\r'); } catch (e) {}
      }, 500);
    }

    return { success: true, id };
  }

  /**
   * Write data to a terminal
   * @param {number} id - Terminal ID
   * @param {string} data - Data to write
   */
  write(id, data) {
    const term = this.terminals.get(id);
    if (term) {
      try {
        term.write(data);
      } catch (e) {
        // PTY may have been killed — ignore write errors
      }
    }
  }

  /**
   * Resize a terminal
   * @param {number} id - Terminal ID
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   */
  resize(id, cols, rows) {
    const term = this.terminals.get(id);
    if (term) {
      try {
        term.resize(cols, rows);
      } catch (e) {
        // PTY may have been killed — ignore resize errors
      }
    }
  }

  /**
   * Force-kill a process tree on Windows via taskkill
   * @param {number} pid - Process ID
   */
  _forceKillWindows(pid) {
    if (!pid || typeof pid !== 'number') return;
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true });
    } catch (_) {
      // Process may already be dead - that's fine
    }
  }

  /**
   * Kill a terminal
   * @param {number} id - Terminal ID
   */
  kill(id) {
    const term = this.terminals.get(id);
    if (!term) return;

    const pid = term.pid;
    term._exited = true;
    this.terminals.delete(id);

    // Notify renderer before disposing listeners
    this.sendToRenderer('terminal-exit', { id });

    // Dispose event listeners before killing to prevent leaks
    if (term._disposables) {
      for (const d of term._disposables) {
        try { d.dispose(); } catch (_) {}
      }
      term._disposables = null;
    }

    try {
      term.kill();
    } catch (e) {
      console.warn(`[Terminal] kill() failed for ${id}:`, e.message);
    }

    // On Windows, ensure the full process tree is dead
    if (process.platform === 'win32') {
      this._forceKillWindows(pid);
    }
  }

  /**
   * Kill all terminals
   */
  killAll() {
    const pids = [];
    this.terminals.forEach((term, id) => {
      pids.push(term.pid);
      // Dispose event listeners before killing
      if (term._disposables) {
        for (const d of term._disposables) {
          try { d.dispose(); } catch (_) {}
        }
        term._disposables = null;
      }
      try { term.kill(); } catch (_) {}
    });
    this.terminals.clear();

    // Ensure all process trees are dead on Windows
    if (process.platform === 'win32') {
      pids.forEach(pid => this._forceKillWindows(pid));
    }
  }

  /**
   * Get terminal count
   * @returns {number}
   */
  count() {
    return this.terminals.size;
  }

  /**
   * Check if terminal exists
   * @param {number} id
   * @returns {boolean}
   */
  has(id) {
    return this.terminals.has(id);
  }
}

// Singleton instance
const terminalService = new TerminalService();

// Exposed for unit tests; not part of the public service API.
terminalService._internals = {
  windowsSpawnPathDirs,
  buildTerminalEnv,
  resolveWindowsExecutable,
  _resolvedExecutables,
};

module.exports = terminalService;
