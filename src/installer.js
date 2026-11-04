/*
 * One-command setup for deepseek-bridge.
 *
 * `deepseek install` is deliberately a thin, transparent installer: it probes
 * for the optional tools, shows what is present, and only runs the package
 * manager commands the user selected. It never installs anything silently and
 * it never escalates privileges on its own (`sudo` prompts in the user's own
 * terminal because stdio is inherited).
 *
 * Autostart is a real service, not a shell alias: a systemd user unit on
 * Linux, a LaunchAgent on macOS, and a hidden logon task on Windows. Each one
 * runs `bin/ds-bridge.js` in the foreground so the supervisor can restart it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, paths, saveConfig } from './config.js';
import { createStyle, truncate, visibleLength } from './tui.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'bin', 'deepseek.js');
export const BRIDGE_SCRIPT = path.join(ROOT, 'bin', 'ds-bridge.js');

const TASK_NAME = 'DeepSeek Bridge';
const SERVICE_NAME = 'deepseek-bridge';
const LAUNCH_LABEL = 'com.sarimmohib.deepseek-bridge';

export const TOOLS = [
  {
    id: 'git',
    name: 'Git',
    description: 'updates (`deepseek update`)',
    recommended: true,
    packages: {
      winget: 'Git.Git',
      choco: 'git',
      scoop: 'git',
      brew: 'git',
      apt: 'git',
      dnf: 'git',
      pacman: 'git',
      zypper: 'git',
      apk: 'git',
    },
    probe: { bin: 'git', args: ['--version'] },
  },
  {
    id: 'tailscale',
    name: 'Tailscale',
    description: 'phone / remote access',
    recommended: false,
    packages: {
      winget: 'Tailscale.Tailscale',
      choco: 'tailscale',
      scoop: 'tailscale',
      brew: 'tailscale',
      apt: 'tailscale',
      dnf: 'tailscale',
      pacman: 'tailscale',
      zypper: 'tailscale',
      apk: 'tailscale',
    },
    probe: { bin: 'tailscale', args: ['version'] },
    setup: 'tailscale up',
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    description: 'the supported coding-agent CLI',
    recommended: false,
    npm: '@deepseek-ai/dsh',
    probe: { bin: 'dsh', args: ['--version'] },
  },
  {
    id: 'node',
    name: 'Node.js',
    description: 'the runtime this bridge uses',
    recommended: false,
    packages: {
      winget: 'OpenJS.NodeJS.LTS',
      choco: 'nodejs-lts',
      scoop: 'nodejs-lts',
      brew: 'node',
      apt: 'nodejs',
      dnf: 'nodejs',
      pacman: 'nodejs',
      zypper: 'nodejs',
      apk: 'nodejs',
    },
    probe: { bin: 'node', args: ['--version'] },
    runtime: true,
  },
];

export function toolById(id) {
  return TOOLS.find((tool) => tool.id === id) || null;
}

function pathEntries({ platform = process.platform, env = process.env } = {}) {
  const raw = env.PATH || env.Path || env.path || '';
  return raw.split(path.delimiter).filter(Boolean);
}

function executableNames(bin, platform, env) {
  if (platform !== 'win32') return [bin];
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [bin, ...extensions.map((ext) => `${bin}${ext.toLowerCase()}`)];
}

/** Pure PATH lookup so detection can be tested without spawning anything. */
export function findExecutable(bin, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const entries = options.pathEntries || pathEntries({ platform, env });
  for (const rawDir of entries) {
    const dir = rawDir.replace(/^"(.*)"$/, '$1');
    for (const name of executableNames(bin, platform, env)) {
      const candidate = path.join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch (err) {
        // Windows app-execution aliases (winget.exe in WindowsApps) live behind
        // a reparse point that stat() may refuse with EACCES even though the
        // command is on PATH and runnable. Trust the PATH hit in that case.
        if (err?.code === 'EACCES' || err?.code === 'EPERM') return candidate;
      }
    }
  }
  return null;
}

function readVersion(bin, args) {
  try {
    const result = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    const first = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    const version = first.match(/v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
    return version ? version[0].replace(/^v/i, '') : first.slice(0, 40) || null;
  } catch {
    return null;
  }
}

export function probeTool(tool, options = {}) {
  const bin = findExecutable(tool.probe.bin, options);
  if (!bin) return { id: tool.id, name: tool.name, found: false, path: null, version: null };
  const version = options.skipVersion
    ? null
    : readVersion(bin, tool.probe.args);
  return { id: tool.id, name: tool.name, found: true, path: bin, version };
}

export function probeTools(options = {}) {
  return TOOLS.map((tool) => probeTool(tool, options));
}

/** First package manager available on this machine, in preference order. */
export function detectPackageManager(options = {}) {
  const platform = options.platform || process.platform;
  const find = options.findExecutable || ((bin) => findExecutable(bin, options));
  if (platform === 'win32') {
    for (const id of ['winget', 'choco', 'scoop']) {
      const bin = find(id);
      if (bin) return { id, bin };
    }
    return null;
  }
  if (platform === 'darwin') {
    const bin = find('brew');
    return bin ? { id: 'brew', bin } : null;
  }
  for (const id of ['apt-get', 'dnf', 'pacman', 'zypper', 'apk']) {
    const bin = find(id);
    if (bin) return { id, bin };
  }
  return null;
}

function packageName(tool, manager) {
  return tool.packages?.[manager] || null;
}

function sudoPrefix(platform) {
  return platform === 'linux' ? ['sudo'] : [];
}

/**
 * Build the exact commands for one tool. Returns `[]` for tools that cannot
 * be installed by a package manager (or are already provided by npm).
 */
export function installCommands(toolId, { platform = process.platform, manager = null } = {}) {
  const tool = toolById(toolId);
  if (!tool) return [];
  if (tool.npm) {
    const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
    return [{
      tool: tool.id,
      label: `npm install -g ${tool.npm}`,
      bin: npm,
      args: ['install', '-g', tool.npm],
    }];
  }
  if (!manager) return [];
  const pkg = packageName(tool, manager.id);
  if (!pkg) return [];

  if (manager.id === 'winget') {
    return [{
      tool: tool.id,
      label: `winget install ${pkg}`,
      bin: manager.bin || 'winget',
      args: ['install', '--id', pkg, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'],
    }];
  }
  if (manager.id === 'choco') {
    return [{ tool: tool.id, label: `choco install ${pkg}`, bin: manager.bin || 'choco', args: ['install', pkg, '-y'] }];
  }
  if (manager.id === 'scoop') {
    return [{ tool: tool.id, label: `scoop install ${pkg}`, bin: manager.bin || 'scoop', args: ['install', pkg] }];
  }
  if (manager.id === 'brew') {
    return [{ tool: tool.id, label: `brew install ${pkg}`, bin: manager.bin || 'brew', args: ['install', pkg] }];
  }

  const sudo = sudoPrefix(platform);
  const bin = manager.bin || manager.id;
  const argsByManager = {
    apt: ['install', '-y', pkg],
    dnf: ['install', '-y', pkg],
    pacman: ['-S', '--noconfirm', pkg],
    zypper: ['--non-interactive', 'install', pkg],
    apk: ['add', pkg],
  };
  const args = argsByManager[manager.id];
  if (!args) return [];
  const command = { tool: tool.id, label: `${sudo.join(' ')} ${manager.id} ${args.join(' ')}`.trim(), bin: sudo[0] || bin, args: sudo.length ? [bin, ...args] : args };
  if (tool.id === 'tailscale' && manager.id !== 'pacman') {
    command.fallback = {
      tool: tool.id,
      label: 'curl -fsSL https://tailscale.com/install.sh | sh',
      bin: 'sh',
      args: ['-c', 'curl -fsSL https://tailscale.com/install.sh | sh'],
    };
  }
  return [command];
}

export function planInstall(toolIds, options = {}) {
  const platform = options.platform || process.platform;
  const manager = options.manager === undefined ? detectPackageManager(options) : options.manager;
  const commands = [];
  for (const id of toolIds) {
    commands.push(...installCommands(id, { platform, manager }));
  }
  return commands;
}

export function parseSelection(input, count) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return [];
  if (text === 'a' || text === 'all') return Array.from({ length: count }, (_, i) => i);
  if (text === 'n' || text === 'none') return [];
  const picked = new Set();
  for (const part of text.split(/[\s,]+/)) {
    if (!part) continue;
    const index = Number(part) - 1;
    if (Number.isInteger(index) && index >= 0 && index < count) picked.add(index);
  }
  return [...picked].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ *
 * Autostart
 * ------------------------------------------------------------------ */

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderSystemdUnit({ nodePath = process.execPath, cliPath = BRIDGE_SCRIPT, workdir = ROOT } = {}) {
  return `[Unit]
Description=deepseek-bridge — OpenAI-compatible API for chat.deepseek.com
Documentation=https://github.com/sarimmohib/deepseek-bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${workdir}
ExecStart="${nodePath}" "${cliPath}"
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

export function renderLaunchAgent({ nodePath = process.execPath, cliPath = BRIDGE_SCRIPT, workdir = ROOT, logFile } = {}) {
  const log = logFile || path.join(paths.CONFIG_DIR, 'bridge.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(cliPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workdir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

export function renderWindowsLauncher({ nodePath = process.execPath, cliPath = BRIDGE_SCRIPT } = {}) {
  return `' deepseek-bridge autostart (generated by \`deepseek install\`)
Set shell = CreateObject("WScript.Shell")
shell.Run """${nodePath}"" ""${cliPath}""", 0, False
`;
}

export function renderWindowsTaskXml({ user = null, vbsPath } = {}) {
  const principal = user
    ? `  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
`
    : '';
  const triggerUser = user ? `    <UserId>${xmlEscape(user)}</UserId>\n` : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>deepseek-bridge — start the OpenAI-compatible bridge at logon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
${triggerUser}    </LogonTrigger>
  </Triggers>
${principal}  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${xmlEscape(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function autostartPaths({ platform = process.platform, home = os.homedir(), appData = process.env.APPDATA } = {}) {
  if (platform === 'linux') {
    return {
      kind: 'systemd',
      unit: path.join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`),
    };
  }
  if (platform === 'darwin') {
    return {
      kind: 'launchd',
      plist: path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`),
    };
  }
  const dir = path.join(appData || path.join(home, 'AppData', 'Roaming'), 'deepseek-bridge');
  return {
    kind: 'schtasks',
    dir,
    vbs: path.join(dir, 'autostart.vbs'),
    xml: path.join(dir, 'autostart.xml'),
  };
}

export function autostartStatus({ platform = process.platform, ...options } = {}) {
  const spec = autostartPaths({ platform, ...options });
  if (spec.kind === 'systemd') {
    return { enabled: fs.existsSync(spec.unit), kind: 'systemd', path: spec.unit };
  }
  if (spec.kind === 'launchd') {
    return { enabled: fs.existsSync(spec.plist), kind: 'launchd', path: spec.plist };
  }
  return { enabled: fs.existsSync(spec.xml), kind: 'schtasks', path: spec.xml };
}

export function autostartFiles({ platform = process.platform, nodePath = process.execPath, cliPath = BRIDGE_SCRIPT, workdir = ROOT, ...options } = {}) {
  const spec = autostartPaths({ platform, ...options });
  if (spec.kind === 'systemd') {
    return { spec, files: [{ path: spec.unit, content: renderSystemdUnit({ nodePath, cliPath, workdir }) }] };
  }
  if (spec.kind === 'launchd') {
    return { spec, files: [{ path: spec.plist, content: renderLaunchAgent({ nodePath, cliPath, workdir }) }] };
  }
  const user = options.user || (process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME || null);
  return {
    spec,
    files: [
      { path: spec.vbs, content: renderWindowsLauncher({ nodePath, cliPath }) },
      { path: spec.xml, content: renderWindowsTaskXml({ user, vbsPath: spec.vbs }), encoding: 'utf16le', bom: true },
    ],
  };
}

export function autostartEnableCommands({ platform = process.platform, ...options } = {}) {
  const spec = autostartPaths({ platform, ...options });
  if (spec.kind === 'systemd') {
    const user = os.userInfo().username;
    return [
      { label: 'reload systemd', bin: 'systemctl', args: ['--user', 'daemon-reload'] },
      { label: 'enable the user service', bin: 'systemctl', args: ['--user', 'enable', '--now', `${SERVICE_NAME}.service`] },
      { label: 'keep it running after logout', bin: 'loginctl', args: ['enable-linger', user], optional: true },
    ];
  }
  if (spec.kind === 'launchd') {
    return [
      { label: 'reload the LaunchAgent', bin: 'launchctl', args: ['unload', spec.plist], optional: true },
      { label: 'enable the LaunchAgent', bin: 'launchctl', args: ['load', '-w', spec.plist] },
    ];
  }
  return [{ label: 'register the logon task', bin: 'schtasks', args: ['/Create', '/TN', TASK_NAME, '/XML', spec.xml, '/F'] }];
}

export function autostartDisableCommands({ platform = process.platform, ...options } = {}) {
  const spec = autostartPaths({ platform, ...options });
  if (spec.kind === 'systemd') {
    return [
      { label: 'stop the user service', bin: 'systemctl', args: ['--user', 'disable', '--now', `${SERVICE_NAME}.service`], optional: true },
    ];
  }
  if (spec.kind === 'launchd') {
    return [{ label: 'unload the LaunchAgent', bin: 'launchctl', args: ['unload', '-w', spec.plist], optional: true }];
  }
  return [{ label: 'delete the logon task', bin: 'schtasks', args: ['/Delete', '/TN', TASK_NAME, '/F'], optional: true }];
}

/* ------------------------------------------------------------------ *
 * Tailscale
 * ------------------------------------------------------------------ */

export function parseTailscaleStatus(json) {
  const self = json?.Self || {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  const ipv4 = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || null;
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : null;
  return {
    installed: true,
    dnsName: dnsName || null,
    ipv4,
    online: self.Online !== false,
    hostname: self.HostName || null,
  };
}

export function tailscaleInfo(options = {}) {
  const bin = options.bin || findExecutable('tailscale', options);
  if (!bin) {
    return { installed: false, dnsName: null, ipv4: null, online: false };
  }
  const result = spawnSync(bin, ['status', '--json'], {
    encoding: 'utf8',
    timeout: 1500,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) {
    return { installed: true, dnsName: null, ipv4: null, online: false, error: (result.stderr || '').trim() || 'not connected' };
  }
  try {
    return parseTailscaleStatus(JSON.parse(result.stdout));
  } catch {
    return { installed: true, dnsName: null, ipv4: null, online: false, error: 'unreadable status' };
  }
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

export function runCommand(command, { stdio = 'inherit', cwd = ROOT, dryRun = false, env = process.env } = {}) {
  if (dryRun) {
    console.log(`  ${command.label || `${command.bin} ${command.args.join(' ')}`}`);
    return Promise.resolve({ code: 0, dryRun: true });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command.bin, command.args, { stdio, cwd, env, windowsHide: false, shell: false });
    } catch (err) {
      resolve({ code: -1, error: err });
      return;
    }
    child.on('error', (err) => resolve({ code: -1, error: err }));
    child.on('exit', (code) => resolve({ code: code ?? 0 }));
  });
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

export function parseInstallArgs(argv = []) {
  const toolsFlag = optionValue(argv, '--tools');
  const options = {
    yes: argv.includes('--yes') || argv.includes('-y'),
    dryRun: argv.includes('--dry-run'),
    list: argv.includes('--list'),
    quiet: argv.includes('--quiet'),
    autostart: argv.includes('--autostart') ? true : argv.includes('--no-autostart') ? false : null,
    expose: argv.includes('--expose') ? true : argv.includes('--no-expose') ? false : null,
    help: argv.includes('--help') || argv.includes('-h'),
  };
  if (typeof toolsFlag === 'string') {
    options.tools = toolsFlag.split(/[\s,]+/).filter(Boolean);
  } else if (argv.includes('--no-tools')) {
    options.tools = [];
  } else {
    options.tools = null;
  }
  return options;
}

function selectionIndexes(selection) {
  return [...selection]
    .sort((a, b) => a - b)
    .map((index) => index + 1)
    .join(',');
}

function toolStatus(tool, probe) {
  if (probe.found) return probe.version ? `installed ${probe.version}` : 'installed';
  return 'missing';
}

function renderSetup({ tools, probes, autostart, style, width }) {
  const box = style.ascii
    ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' }
    : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
  const inner = width - 4;
  const lines = [];
  lines.push('');
  lines.push(`${box.tl}${box.h.repeat(width - 2)}${box.tr}`);
  const title = `${style.bold('SETUP')} ${style.dim('optional tools + autostart')}`;
  lines.push(`${box.v} ${title}${' '.repeat(Math.max(0, inner - visibleLength(title)))} ${box.v}`);
  lines.push(`${box.bl}${box.h.repeat(width - 2)}${box.br}`);
  lines.push('');
  const header = `  ${'#'.padEnd(3)}${'TOOL'.padEnd(20)}${'STATUS'.padEnd(22)}WHAT IT IS FOR`;
  lines.push(truncate(style.dim(header), width));
  tools.forEach((tool, index) => {
    const probe = probes.find((item) => item.id === tool.id);
    const mark = probe.found ? style.green('●') : style.dim('○');
    const name = tool.name;
    lines.push(truncate(`  ${mark} ${String(index + 1).padEnd(2)}${name.padEnd(20)}${toolStatus(tool, probe).padEnd(22)}${tool.description}`, width));
  });
  const autoProbe = autostart.enabled ? style.green('configured') : 'off';
  lines.push(truncate(`  ${autostart.enabled ? style.green('●') : style.dim('○')} ${String(tools.length + 1).padEnd(2)}${'Autostart'.padEnd(20)}${String(autoProbe).padEnd(22)}start the bridge at login`, width));
  lines.push('');
  return lines;
}

async function ask(rl, question, { defaultValue = '' } = {}) {
  if (!rl) return defaultValue;
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

export async function installAutostart({ platform = process.platform, dryRun = false, log = console.log } = {}) {
  const { spec, files } = autostartFiles({ platform });
  for (const file of files) {
    if (dryRun) {
      log(`  would write ${file.path}`);
      continue;
    }
    ensureDir(file.path);
    const body = file.bom ? `\ufeff${file.content}` : file.content;
    fs.writeFileSync(file.path, body, file.encoding ? { encoding: file.encoding, mode: 0o644 } : { mode: 0o644 });
  }
  for (const command of autostartEnableCommands({ platform })) {
    const result = await runCommand(command, { dryRun });
    if (result.code !== 0 && !command.optional) {
      return { ok: false, spec, dryRun, error: `${command.label} failed (exit ${result.code})` };
    }
  }
  return { ok: true, spec, dryRun };
}

export async function removeAutostart({ platform = process.platform, dryRun = false, log = console.log } = {}) {
  for (const command of autostartDisableCommands({ platform })) {
    await runCommand(command, { dryRun });
  }
  const spec = autostartPaths({ platform });
  const files = spec.kind === 'systemd' ? [spec.unit] : spec.kind === 'launchd' ? [spec.plist] : [spec.vbs, spec.xml];
  for (const file of files) {
    if (dryRun) {
      log(`  would remove ${file}`);
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
  return { ok: true, spec };
}

export async function runInstaller(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stdin = io.stdin || process.stdin;
  const style = io.style || createStyle({ color: io.color ?? (stdout.isTTY && !process.env.NO_COLOR) });
  const width = Math.min(100, Math.max(64, stdout.columns || 92));
  const options = parseInstallArgs(argv);
  const interactive = Boolean(stdin.isTTY && stdout.isTTY) && !options.yes && !options.quiet;

  if (options.help) {
    stdout.write(`Usage: deepseek install [options]

  --tools git,tailscale,dsh   install exactly these tools, no prompt
  --autostart / --no-autostart
  --expose / --no-expose      bind 0.0.0.0 for LAN/Tailscale access
  --yes, -y                   accept defaults (recommended tools + autostart)
  --dry-run                   print the commands instead of running them
  --list                      show the tool catalog and exit
  --quiet                     no prompts, no banner (used by postinstall)
`);
    return 0;
  }

  const probes = probeTools();
  const autostart = autostartStatus();
  const manager = detectPackageManager();

  if (options.list) {
    const rows = probes.map((probe) => ({
      id: probe.id,
      name: probe.name,
      found: probe.found ? 'yes' : 'no',
      version: probe.version || '',
      install: toolById(probe.id)?.npm ? 'npm' : toolById(probe.id)?.packages?.[manager?.id || ''] || '',
    }));
    stdout.write(`${JSON.stringify({ manager: manager?.id || null, tools: rows, autostart }, null, 2)}\n`);
    return 0;
  }

  if (!options.quiet) {
    for (const line of renderSetup({ tools: TOOLS, probes, autostart, style, width })) stdout.write(`${line}\n`);
    stdout.write(`  ${style.dim(`package manager: ${manager ? manager.id : 'none detected'}`)}\n\n`);
  }

  // Defaults: recommended tools that are missing, plus autostart when it is off.
  const defaultSelection = new Set(
    TOOLS.map((tool, index) => ({ tool, index }))
      .filter(({ tool }) => tool.recommended && !probes.find((probe) => probe.id === tool.id)?.found)
      .map(({ index }) => index),
  );
  let selection = options.tools
    ? new Set(options.tools.map((id) => TOOLS.findIndex((tool) => tool.id === id)).filter((index) => index >= 0))
    : new Set(defaultSelection);
  let wantAutostart;
  if (options.autostart !== null) wantAutostart = options.autostart;
  else if (options.tools) wantAutostart = false;
  else wantAutostart = !autostart.enabled;
  let wantExpose = options.expose;

  if (interactive) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      while (true) {
        stdout.write(`  ${style.dim('Enter')} continue · ${style.dim('numbers')} toggle · ${style.dim('a')} all · ${style.dim('n')} none · ${style.dim('q')} quit\n`);
        const answer = await ask(rl, `  Selection [${selectionIndexes(selection)}${wantAutostart ? `,${TOOLS.length + 1}` : ''}]`);
        if (answer.toLowerCase() === 'q') return 0;
        if (answer.toLowerCase() === 'a') {
          selection = new Set(TOOLS.map((_, index) => index));
          wantAutostart = true;
        } else if (answer.toLowerCase() === 'n') {
          selection = new Set();
          wantAutostart = false;
        } else if (answer) {
          const indexes = parseSelection(answer, TOOLS.length + 1);
          selection = new Set(indexes.filter((index) => index < TOOLS.length));
          wantAutostart = indexes.includes(TOOLS.length);
        } else {
          break;
        }
      }

      if (wantExpose === null && selection.has(TOOLS.findIndex((tool) => tool.id === 'tailscale'))) {
        const answer = await ask(rl, '  Bind the bridge to 0.0.0.0 so phones/Tailscale can reach it? (y/N)', { defaultValue: 'n' });
        wantExpose = /^y/i.test(answer);
      }
      if (options.autostart === null && wantAutostart) {
        const answer = await ask(rl, '  Start the bridge automatically at login? (Y/n)', { defaultValue: 'y' });
        wantAutostart = !/^n/i.test(answer);
      }
    } finally {
      rl.close();
    }
  }

  const selectedIds = [...selection].map((index) => TOOLS[index].id);
  const missing = selectedIds.filter((id) => !probes.find((probe) => probe.id === id)?.found);
  const commands = planInstall(missing, { manager });

  if (commands.length) {
    stdout.write(`\n  ${style.bold('Installing')} ${missing.join(', ')}\n`);
    for (const command of commands) {
      if (!options.dryRun) stdout.write(`  ${style.dim('→')} ${command.label}\n`);
      let result = await runCommand(command, { dryRun: options.dryRun });
      if (result.code !== 0 && command.fallback) {
        stdout.write(`  ${style.yellow('!')} ${command.label} failed; trying the official installer\n`);
        result = await runCommand(command.fallback, { dryRun: options.dryRun });
      }
      if (result.code !== 0 && !options.dryRun) {
        stdout.write(`  ${style.red('✕')} ${command.tool} did not install (exit ${result.code}). Install it manually and rerun.\n`);
      }
    }
  } else if (missing.length) {
    stdout.write(`\n  ${style.yellow('!')} No package manager found for: ${missing.join(', ')}\n`);
  }

  if (wantAutostart && !autostart.enabled) {
    stdout.write(`\n  ${style.bold('Autostart')}\n`);
    const result = await installAutostart({ dryRun: options.dryRun });
    if (result.ok) {
      const verb = options.dryRun ? 'would register' : 'registered';
      stdout.write(`  ${style.green('●')} ${verb} (${result.spec.kind}) — ${result.spec.unit || result.spec.plist || result.spec.xml}\n`);
    } else {
      stdout.write(`  ${style.red('✕')} ${result.error}\n`);
    }
  } else if (!wantAutostart && autostart.enabled) {
    stdout.write(`\n  ${style.bold('Autostart')}\n`);
    const result = await removeAutostart({ dryRun: options.dryRun });
    if (result.ok) {
      stdout.write(`  ${style.green('●')} removed\n`);
    } else {
      stdout.write(`  ${style.red('✕')} could not remove autostart\n`);
    }
  }

  if (wantExpose) {
    const current = loadConfig();
    if (current.host !== '0.0.0.0') {
      saveConfig({ host: '0.0.0.0' });
      stdout.write(`\n  ${style.green('●')} config.host = 0.0.0.0 (restart the bridge to apply)\n`);
    }
  }

  const after = probeTools();
  stdout.write(`\n  ${style.bold('Ready')}\n`);
  for (const probe of after) {
    const mark = probe.found ? style.green('●') : style.dim('○');
    stdout.write(`  ${mark} ${probe.name.padEnd(20)} ${probe.found ? probe.version || 'installed' : 'missing'}\n`);
  }
  stdout.write(`  ${autostartStatus().enabled ? style.green('●') : style.dim('○')} ${'Autostart'.padEnd(20)} ${autostartStatus().enabled ? autostartStatus().kind : 'off'}\n`);

  const tail = tailscaleInfo();
  if (tail.installed) {
    if (tail.dnsName) {
      stdout.write(`\n  Tailscale: http://${tail.dnsName}:${loadConfig().port}/v1\n`);
    } else {
      stdout.write('\n  Tailscale is installed but not connected. Run `tailscale up`, then restart the bridge.\n');
    }
  }
  stdout.write('\n  Next: run `deepseek` to start the bridge and see the live panel.\n\n');
  return 0;
}
