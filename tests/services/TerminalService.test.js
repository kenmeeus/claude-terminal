/**
 * TerminalService — Windows spawn PATH repair.
 *
 * Regression cover for the intermittent "File not found" when starting a
 * Claude session after a reboot: Windows can relaunch the app before the full
 * user PATH is applied, so `%APPDATA%\npm` (where the npm-global `claude` shim
 * lives) is missing and the spawn fails. The service now guarantees a small
 * set of conventional dirs on the spawn env's PATH (appended, so the user's own
 * precedence is kept) and resolves the shell itself to an absolute path.
 *
 * Executable lookup is mocked: `where.exe` never runs here, so the tests are
 * deterministic and do not depend on what the host has installed. Real
 * spawning is covered by the live sandbox smoke test, not by this file.
 */

// Avoid loading the node-pty native binding (built for the Electron ABI) and
// electron itself when the module graph is required under jest.
jest.mock('node-pty', () => ({ spawn: jest.fn() }));
jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}), { virtual: true });
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(() => { throw new Error('where.exe is mocked out'); }),
}));
// Remote Control adds `--rc` to the CLI when enabled; keep it out of the args.
jest.mock('../../src/main/services/RemoteControlService', () => ({
  launchesTerminalsConnected: () => false,
}), { virtual: true });

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const pty  = require('node-pty');
const { execFileSync } = require('child_process');

const terminalService = require('../../src/main/services/TerminalService');
const { _internals } = terminalService;
const { windowsSpawnPathDirs, buildTerminalEnv, resolveWindowsExecutable, _resolvedExecutables } = _internals;

// The PATH-repair and cmd.exe launch behaviour is Windows-specific.
const itWin = process.platform === 'win32' ? test : test.skip;

const tempDirs = [];
function mkTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsvc-'));
  tempDirs.push(dir);
  return dir;
}

/** Run `fn` with process.env replaced by `vars` (restored afterwards). */
function withEnv(vars, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

afterEach(() => {
  _resolvedExecutables.clear();
  execFileSync.mockClear();
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('resolveWindowsExecutable', () => {
  test('resolves a bare name against a probed directory', () => {
    const dir = mkTemp();
    const target = path.join(dir, 'faux.cmd');
    fs.writeFileSync(target, '@echo off');
    expect(resolveWindowsExecutable('faux', [dir])).toBe(target);
  });

  test('falls back to the bare name when nothing resolves', () => {
    expect(resolveWindowsExecutable('no-such-binary-xyz', [mkTemp()])).toBe('no-such-binary-xyz');
  });

  test('prefers a where.exe hit that exists on disk', () => {
    const dir = mkTemp();
    const target = path.join(dir, 'hit.exe');
    fs.writeFileSync(target, '');
    execFileSync.mockImplementationOnce(() => `${target}\r\n${path.join(dir, 'second.exe')}\r\n`);
    expect(resolveWindowsExecutable('hit', [])).toBe(target);
    expect(execFileSync).toHaveBeenCalledWith('where.exe', ['hit'], expect.objectContaining({ windowsHide: true }));
  });

  test('caches a successful resolution so where.exe runs once per name', () => {
    const dir = mkTemp();
    fs.writeFileSync(path.join(dir, 'cached.exe'), '');
    resolveWindowsExecutable('cached', [dir]);
    resolveWindowsExecutable('cached', [dir]);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  test('does not cache a failed resolution', () => {
    resolveWindowsExecutable('missing-xyz', []);
    resolveWindowsExecutable('missing-xyz', []);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});

describe('buildTerminalEnv', () => {
  test('returns a copy, never the live process.env', () => {
    const env = buildTerminalEnv();
    expect(env).not.toBe(process.env);
  });

  itWin('appends the npm-global bin when it is missing from PATH', () => {
    withEnv({ APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', PATH: 'C:\\Windows\\System32' }, () => {
      const npmBin = path.join(process.env.APPDATA, 'npm');
      const env = buildTerminalEnv();
      expect(env.PATH.split(';')).toContain(npmBin);
      // Appended after the user's own entries so their precedence is kept
      // (a version manager's node must still beat the stock install).
      expect(env.PATH.indexOf(npmBin)).toBeGreaterThan(env.PATH.indexOf('C:\\Windows\\System32'));
    });
  });

  itWin('keeps a complete search path when Windows spells the key Path', () => {
    // Launched from Explorer / startup (not a shell), the key is `Path`. With
    // every required dir already present, the terminal must inherit it intact.
    withEnv({ Path: windowsSpawnPathDirs().join(';') + ';C:\\Tools' }, () => {
      const env = buildTerminalEnv();
      expect(env.PATH).toBe(process.env.Path);
      expect(env.Path).toBeUndefined();
    });
  });

  itWin('does not duplicate a dir already on PATH', () => {
    const dirs = windowsSpawnPathDirs();
    withEnv({ PATH: dirs.join(';') }, () => {
      const env = buildTerminalEnv();
      for (const d of dirs) {
        const occurrences = env.PATH.split(';').filter(p => p.toLowerCase() === d.toLowerCase()).length;
        expect(occurrences).toBe(1);
      }
    });
  });
});

describe('create() on Windows', () => {
  let spawnCalls;
  let fixtures;

  /**
   * A throwaway Windows layout: stub cmd.exe / powershell.exe under a fake
   * SystemRoot and a fake Program Files. The shell lookup probes these dirs
   * (where.exe is mocked out), so nothing here depends on where the host has
   * Windows installed.
   */
  function makeWindowsFixtures() {
    const root = mkTemp();
    const systemRoot = path.join(root, 'Windows');
    const programFiles = path.join(root, 'Program Files');
    const psDir = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    fs.mkdirSync(psDir, { recursive: true });
    fs.mkdirSync(path.join(programFiles, 'nodejs'), { recursive: true });
    fs.writeFileSync(path.join(systemRoot, 'System32', 'cmd.exe'), '');
    fs.writeFileSync(path.join(psDir, 'powershell.exe'), '');
    return { SystemRoot: systemRoot, ProgramFiles: programFiles, APPDATA: path.join(root, 'AppData', 'Roaming') };
  }

  beforeEach(() => {
    fixtures = makeWindowsFixtures();
    spawnCalls = [];
    pty.spawn.mockReset();
    pty.spawn.mockImplementation((file, args, options) => {
      spawnCalls.push({ file, args, options });
      return {
        pid: 4242,
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
        resize() {},
        write() {},
        kill() {},
      };
    });
  });

  afterEach(() => {
    for (const id of [...terminalService.terminals.keys()]) terminalService.terminals.delete(id);
  });

  const cwd = os.homedir();
  const userFirst = 'D:\\my-node-manager\\current';
  // The user's PATH as Windows may hand it over after a reboot: their own
  // entry plus System32, but not the npm-global bin.
  const env = (extra = {}) => ({ ...fixtures, PATH: `${userFirst};${path.join(fixtures.SystemRoot, 'System32')}`, ...extra });

  itWin('spawns cmd.exe /c claude with the npm-global bin added to an incomplete PATH', () => {
    withEnv(env(), () => {
      const result = terminalService.create({ cwd, runClaude: true });
      expect(result.success).toBe(true);
      const [{ file, args, options }] = spawnCalls;
      expect(file).toBe(path.join(fixtures.SystemRoot, 'System32', 'cmd.exe'));
      expect(args).toEqual(['/c', 'claude']);
      const entries = options.env.PATH.split(';');
      expect(entries).toContain(path.join(fixtures.APPDATA, 'npm'));
      // The user's own first entry stays first: fallbacks are appended.
      expect(entries[0]).toBe(userFirst);
      expect(options.env.Path).toBeUndefined();
    });
  });

  itWin('keeps the resume id and permission flag on the claude command', () => {
    withEnv(env(), () => {
      terminalService.create({ cwd, runClaude: true, resumeSessionId: 'abcdef12-3456-7890-abcd-ef1234567890', skipPermissions: true });
      expect(spawnCalls[0].args).toEqual(['/c', 'claude', '--resume', 'abcdef12-3456-7890-abcd-ef1234567890', '--dangerously-skip-permissions']);
    });
  });

  itWin('rejects a malformed resume id instead of passing it to the shell', () => {
    withEnv(env(), () => {
      terminalService.create({ cwd, runClaude: true, resumeSessionId: 'x & del *' });
      expect(spawnCalls[0].args).toEqual(['/c', 'claude']);
    });
  });

  itWin('layers the account env over the repaired spawn env', () => {
    withEnv(env(), () => {
      terminalService.create({ cwd, runClaude: false, accountEnv: { CLAUDE_CONFIG_DIR: 'C:\\accounts\\work' } });
      const spawnEnv = spawnCalls[0].options.env;
      expect(spawnEnv.CLAUDE_CONFIG_DIR).toBe('C:\\accounts\\work');
      expect(spawnEnv.PATH.split(';')).toContain(path.join(fixtures.APPDATA, 'npm'));
      expect(spawnEnv.PATH.split(';')).toContain(path.join(fixtures.ProgramFiles, 'nodejs'));
    });
  });

  itWin('resolves a plain shell tab to the absolute powershell.exe under SystemRoot', () => {
    withEnv(env(), () => {
      terminalService.create({ cwd, runClaude: false });
      const [{ file, args }] = spawnCalls;
      expect(file).toBe(path.join(fixtures.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
      expect(args).toEqual(['-NoLogo', '-NoProfile']);
    });
  });
});
