import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  TOOLS,
  autostartFiles,
  autostartPaths,
  detectPackageManager,
  findExecutable,
  installCommands,
  parseInstallArgs,
  parseSelection,
  parseTailscaleStatus,
  planInstall,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsLauncher,
  renderWindowsTaskXml,
  runInstaller,
  toolById,
} from '../src/installer.js';

test('tool catalog exposes the documented optional tools', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.id), ['git', 'tailscale', 'dsh', 'node']);
  assert.equal(toolById('tailscale').packages.winget, 'Tailscale.Tailscale');
  assert.equal(toolById('dsh').npm, '@deepseek-ai/dsh');
  assert.equal(toolById('missing'), null);
});

test('findExecutable walks PATH and honours PATHEXT on Windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-path-'));
  try {
    fs.writeFileSync(path.join(dir, 'dsb-fake-tool'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'dsb-win-tool.cmd'), '@echo off\n');
    assert.equal(
      findExecutable('dsb-fake-tool', { platform: 'linux', pathEntries: [dir], env: {} }),
      path.join(dir, 'dsb-fake-tool'),
    );
    assert.equal(findExecutable('dsb-nope', { platform: 'linux', pathEntries: [dir], env: {} }), null);
    assert.equal(
      findExecutable('dsb-win-tool', { platform: 'win32', pathEntries: [dir], env: { PATHEXT: '.CMD' } }),
      path.join(dir, 'dsb-win-tool.cmd'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSelection accepts numbers, ranges of input, all and none', () => {
  assert.deepEqual(parseSelection('1,3', 4), [0, 2]);
  assert.deepEqual(parseSelection('2 4', 4), [1, 3]);
  assert.deepEqual(parseSelection('a', 3), [0, 1, 2]);
  assert.deepEqual(parseSelection('none', 3), []);
  assert.deepEqual(parseSelection('', 3), []);
  assert.deepEqual(parseSelection('9,0,-1', 3), []);
});

test('package manager detection prefers winget then brew then distro tools', () => {
  const winget = detectPackageManager({
    platform: 'win32',
    findExecutable: (bin) => (bin === 'winget' ? 'C:/WindowsApps/winget.exe' : null),
  });
  assert.equal(winget.id, 'winget');

  const brew = detectPackageManager({
    platform: 'darwin',
    findExecutable: (bin) => (bin === 'brew' ? '/opt/homebrew/bin/brew' : null),
  });
  assert.equal(brew.id, 'brew');

  const apt = detectPackageManager({
    platform: 'linux',
    findExecutable: (bin) => (bin === 'apt-get' ? '/usr/bin/apt-get' : null),
  });
  assert.equal(apt.id, 'apt-get');
});

test('install commands are concrete per package manager', () => {
  const winget = installCommands('git', { platform: 'win32', manager: { id: 'winget', bin: 'winget' } });
  assert.equal(winget.length, 1);
  assert.equal(winget[0].bin, 'winget');
  assert.deepEqual(winget[0].args.slice(0, 3), ['install', '--id', 'Git.Git']);

  const brew = installCommands('tailscale', { platform: 'darwin', manager: { id: 'brew', bin: 'brew' } });
  assert.deepEqual(brew[0].args, ['install', 'tailscale']);

  const apt = installCommands('tailscale', { platform: 'linux', manager: { id: 'apt', bin: '/usr/bin/apt-get' } });
  assert.equal(apt[0].bin, 'sudo');
  assert.deepEqual(apt[0].args, ['/usr/bin/apt-get', 'install', '-y', 'tailscale']);
  assert.match(apt[0].fallback.label, /tailscale\.com\/install\.sh/);

  const npm = installCommands('dsh', { platform: 'linux', manager: null });
  assert.equal(npm[0].bin, 'npm');
  assert.deepEqual(npm[0].args, ['install', '-g', '@deepseek-ai/dsh']);
});

test('planInstall builds one command per missing selected tool', () => {
  const plan = planInstall(['git', 'tailscale'], {
    platform: 'win32',
    manager: { id: 'winget', bin: 'winget' },
  });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((command) => command.tool), ['git', 'tailscale']);
});

test('systemd unit runs the bridge in the foreground and restarts it', () => {
  const unit = renderSystemdUnit({
    nodePath: '/usr/bin/node',
    cliPath: '/opt/deepseek-bridge/bin/ds-bridge.js',
    workdir: '/opt/deepseek-bridge',
  });
  assert.match(unit, /WorkingDirectory=\/opt\/deepseek-bridge/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/deepseek-bridge\/bin\/ds-bridge\.js"/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('LaunchAgent plist points at node and the bridge script', () => {
  const plist = renderLaunchAgent({
    nodePath: '/usr/local/bin/node',
    cliPath: '/Users/sarim/deepseek-bridge/bin/ds-bridge.js',
    workdir: '/Users/sarim/deepseek-bridge',
  });
  assert.match(plist, /<string>com\.sarimmohib\.deepseek-bridge<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
});

test('Windows autostart hides the console and registers a logon task', () => {
  const vbs = renderWindowsLauncher({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\Users\\Sarim\\deepseek-bridge\\bin\\ds-bridge.js',
  });
  assert.match(vbs, /WScript\.Shell/);
  assert.match(vbs, /, 0, False/);

  const xml = renderWindowsTaskXml({
    user: 'DESKTOP\\Sarim',
    vbsPath: 'C:\\Tools & Stuff\\autostart.vbs',
  });
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  assert.match(xml, /C:\\Tools &amp; Stuff\\autostart\.vbs/);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<UserId>DESKTOP\\Sarim<\/UserId>/);
});

test('autostart paths are per-platform and files carry the right encoding', () => {
  assert.match(
    autostartPaths({ platform: 'linux', home: '/home/sarim' }).unit,
    /\.config[\\/]systemd[\\/]user[\\/]deepseek-bridge\.service$/,
  );
  assert.match(
    autostartPaths({ platform: 'darwin', home: '/Users/sarim' }).plist,
    /Library[\\/]LaunchAgents[\\/]com\.sarimmohib\.deepseek-bridge\.plist$/,
  );
  assert.match(
    autostartPaths({ platform: 'win32', home: 'C:\\Users\\Sarim', appData: 'C:\\Users\\Sarim\\AppData\\Roaming' }).xml,
    /deepseek-bridge[\\/]autostart\.xml$/,
  );

  const linux = autostartFiles({ platform: 'linux', home: '/home/sarim' });
  assert.equal(linux.files.length, 1);
  assert.match(linux.files[0].content, /ds-bridge\.js/);

  const windows = autostartFiles({
    platform: 'win32',
    home: 'C:\\Users\\Sarim',
    appData: 'C:\\Users\\Sarim\\AppData\\Roaming',
  });
  assert.equal(windows.files.length, 2);
  assert.equal(windows.files[1].encoding, 'utf16le');
  assert.equal(windows.files[1].bom, true);
});

test('Tailscale status JSON is reduced to the fields the panel needs', () => {
  const info = parseTailscaleStatus({
    Self: {
      DNSName: 'desktop-drbedno.tailce34b1.ts.net.',
      TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
      Online: true,
      HostName: 'desktop-drbedno',
    },
  });
  assert.equal(info.dnsName, 'desktop-drbedno.tailce34b1.ts.net');
  assert.equal(info.ipv4, '100.101.102.103');
  assert.equal(info.online, true);
  assert.equal(info.hostname, 'desktop-drbedno');
});

test('install flags parse without prompting', () => {
  const flags = parseInstallArgs(['--tools', 'git,tailscale', '--autostart', '--yes', '--dry-run']);
  assert.deepEqual(flags.tools, ['git', 'tailscale']);
  assert.equal(flags.autostart, true);
  assert.equal(flags.yes, true);
  assert.equal(flags.dryRun, true);

  const off = parseInstallArgs(['--no-autostart', '--no-tools']);
  assert.equal(off.autostart, false);
  assert.deepEqual(off.tools, []);
  assert.equal(off.yes, false);
});

test('interactive wizard renders the checklist and quits on q', async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 100;
  let text = '';
  stdout.on('data', (chunk) => {
    text += chunk.toString();
  });

  const pending = runInstaller(['--dry-run'], { stdin, stdout, color: false });
  stdin.write('q\n');
  stdin.end();
  const code = await pending;

  assert.equal(code, 0);
  assert.match(text, /SETUP/);
  assert.match(text, /Autostart/);
  assert.match(text, /package manager:/);
});
