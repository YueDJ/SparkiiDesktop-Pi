/*
 * Task 0 measurement harness (NOT production code).
 *
 * Measures, against the LOCKED electron-updater 6.3.0 actually installed in
 * this workspace:
 *   T0-2  setFeedURL with file:// / a local directory
 *   T0-3  absolute artifact URL in a derived latest.yml overriding feed baseUrl
 *   T0-4  AppUpdater.httpExecutor injectability
 *   T0-11 app-update.yml flags (verifyUpdateCodeSignature / updaterCacheDirName)
 *         after setFeedURL override
 *
 * It NEVER downloads a real package: checkForUpdates() only fetches the tiny
 * latest.yml; downloadUpdate() is never called. The "artifact" on the fake
 * origin is a 12-byte text file that is never requested.
 *
 * Run from the repo root:
 *   node docs/superpowers/specs/2026-11-06-task0-scripts/probe-updater.cjs
 * Output: JSON on stdout (one object) plus electron-updater's own logger lines.
 */
'use strict';

const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL, fileURLToPath } = require('node:url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkii-task0-updater-'));
const feedDir = path.join(tmp, 'feed');
const resourcesDir = path.join(tmp, 'resources');
fs.mkdirSync(feedDir, { recursive: true });
fs.mkdirSync(resourcesDir, { recursive: true });
const userData = path.join(tmp, 'userData');
fs.mkdirSync(userData, { recursive: true });

// A synthetically built app-update.yml, standing in for the electron-builder
// output. It is never uploaded; it only proves which keys remain effective.
const appUpdateYml = [
  'provider: generic',
  'url: http://localhost/sparkii-updates/',
  'updaterCacheDirName: sparkii-updater',
  'verifyUpdateCodeSignature: false',
  '',
].join('\n');
fs.writeFileSync(path.join(resourcesDir, 'app-update.yml'), appUpdateYml, 'utf8');

const netRequests = [];
const fakeApp = {
  getVersion: () => '0.1.0',
  getName: () => 'Sparkii',
  getPath: () => userData,
  getAppPath: () => tmp,
  whenReady: () => Promise.resolve(),
  isPackaged: true,
  isReady: () => true,
  on: () => {},
  quit: () => {},
  getLocale: () => 'zh-CN',
};
// Stock ElectronHttpExecutor routes every request through electron.net.request.
// Our stub records the request options and refuses non-http(s) protocols, which
// is exactly what Chromium's net stack does for file:// URLs.
function netRequest(options) {
  netRequests.push({ protocol: options.protocol, hostname: options.hostname, path: options.path });
  throw new Error(`electron.net.request cannot use protocol ${options.protocol} (http/https only)`);
}
const electronStub = {
  app: fakeApp,
  ipcMain: { on: () => {}, handle: () => {} },
  net: { request: netRequest },
  session: { fromPartition: () => ({}) },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};
// ElectronAppAdapter.appUpdateConfigPath uses process.resourcesPath when packed.
process.resourcesPath = resourcesDir;

const pkgRoot = path.resolve(
  __dirname,
  '../../../../node_modules/.pnpm/electron-updater@6.3.0/node_modules/electron-updater',
);
const { NsisUpdater } = require(path.join(pkgRoot, 'out', 'main.js'));
const { version: updaterVersion } = require(path.join(pkgRoot, 'package.json'));

function requestHref(options) {
  // configureRequestUrl() writes protocol/hostname/port/path onto the options
  // object rather than setting options.url.
  if (typeof options === 'string') return options;
  if (options.url) return options.url.href || String(options.url);
  if (options.protocol) {
    const host = options.hostname ? `//${options.hostname}${options.port ? ':' + options.port : ''}` : '';
    return `${options.protocol}${host}${options.path || ''}`;
  }
  return String(options);
}

/** Injected executor used by the A / A' implementation (§5.2 step 4). */
function makeLocalAwareExecutor(channelBody, feedFileUrl) {
  const calls = [];
  return {
    calls,
    maxRedirects: 0,
    async request(options) {
      const href = requestHref(options);
      calls.push(href);
      if (href.startsWith('file:') && href.endsWith('latest.yml')) {
        const filePath = fileURLToPath(new URL(href));
        if (filePath !== fileURLToPath(feedFileUrl)) {
          throw new Error(`local feed path mismatch: ${filePath}`);
        }
        return fs.readFileSync(filePath);
      }
      return Buffer.from(channelBody, 'utf8');
    },
    async download() { throw new Error('download() must not be called in this harness'); },
  };
}

// ---------------------------------------------------------------------------
// Tiny fake origin standing in for the remote update server. Its only role is
// to give the absolute artifact URL a DIFFERENT host:port than the feed.
// ---------------------------------------------------------------------------
let fakePort = 0;
const fakeOrigin = http.createServer((req, res) => {
  if (req.url.startsWith('/fake/')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('FAKE-ARTIFACT');
    return;
  }
  res.writeHead(404);
  res.end();
});

function derivedLatestYml() {
  const absolute = `http://127.0.0.1:${fakePort}/fake/Sparkii-0.2.0-win-x64.exe`;
  return [
    'version: 0.2.0',
    'files:',
    `  - url: ${absolute}`,
    '    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    '    size: 12',
    `path: ${path.basename(absolute)}`,
    'sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    "releaseDate: '2026-11-06T05:20:00.000Z'",
    '',
  ].join('\n');
}

function newUpdater() {
  const updater = new NsisUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  return updater;
}

function fileFeedUrl() {
  return pathToFileURL(feedDir + path.sep).href;
}

/** T0-2 stock executor + file:// feed (no injection). */
async function probeFileFeedStock(latestYml) {
  const out = { accepted: false };
  const updater = newUpdater();
  netRequests.length = 0;
  try {
    updater.setFeedURL({ provider: 'generic', url: fileFeedUrl() });
    out.setFeedURLThrew = false;
  } catch (e) {
    out.setFeedURLThrew = true;
    out.setFeedURLError = String(e && e.message || e);
    return out;
  }
  try {
    const result = await updater.checkForUpdates();
    out.accepted = true;
    out.version = result && result.updateInfo && result.updateInfo.version;
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  out.netRequestOptions = netRequests.slice();
  out.channelUrlComputed = `${fileFeedUrl()}latest.yml`;
  return out;
}

/** T0-2/T0-3/T0-4/A: custom executor reading the local feed in-process. */
async function probeFileFeedInjected(latestYml) {
  const out = { accepted: false };
  const updater = newUpdater();
  const exec = makeLocalAwareExecutor(latestYml, new URL('latest.yml', fileFeedUrl()));
  updater.httpExecutor = exec;                 // inject BEFORE setFeedURL
  updater.setFeedURL({ provider: 'generic', url: fileFeedUrl() });
  const client = await updater.clientPromise;
  out.httpExecutorInjected = client.executor === exec;
  try {
    const result = await updater.checkForUpdates();
    out.accepted = true;
    out.version = result && result.updateInfo && result.updateInfo.version;
    out.metadataRequests = exec.calls.slice();
    const files = client.resolveFiles(result.updateInfo);
    out.resolvedArtifactUrl = files[0].url.href;
    out.absoluteOverrideWorks =
      files[0].url.href === `http://127.0.0.1:${fakePort}/fake/Sparkii-0.2.0-win-x64.exe`;
  } catch (e) {
    out.error = String(e && e.message || e);
    out.metadataRequests = exec.calls.slice();
  }
  return out;
}

/** A' control: loopback HTTP feed with absolute artifact URL. */
async function probeLoopbackFeed(latestYml) {
  const out = { accepted: false };
  const token = 't0-' + Math.random().toString(36).slice(2);
  const feedPath = `/${token}/`;
  const localServer = http.createServer((req, res) => {
    if (req.url === `${feedPath}latest.yml`) {
      res.writeHead(200, { 'content-type': 'application/yaml', 'cache-control': 'no-store' });
      res.end(latestYml);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    localServer.listen(0, '127.0.0.1', resolve);
    localServer.once('error', reject);
  });
  const loopbackBase = `http://127.0.0.1:${localServer.address().port}${feedPath}`;
  const exec = makeLocalAwareExecutor(latestYml, new URL('latest.yml', loopbackBase));
  const updater = newUpdater();
  updater.httpExecutor = exec;
  updater.setFeedURL({ provider: 'generic', url: loopbackBase });
  const client = await updater.clientPromise;
  out.httpExecutorInjected = client.executor === exec;
  try {
    const result = await updater.checkForUpdates();
    out.accepted = true;
    out.version = result && result.updateInfo && result.updateInfo.version;
    out.metadataRequests = exec.calls.slice();
    const files = client.resolveFiles(result.updateInfo);
    out.resolvedArtifactUrl = files[0].url.href;
    out.absoluteOverrideWorks =
      files[0].url.href === `http://127.0.0.1:${fakePort}/fake/Sparkii-0.2.0-win-x64.exe`;
  } catch (e) {
    out.error = String(e && e.message || e);
    out.metadataRequests = exec.calls.slice();
  }
  out.feedBaseUrl = loopbackBase;
  await new Promise((resolve) => localServer.close(resolve));
  return out;
}

/** T0-11: does setFeedURL disable app-update.yml? */
async function probeAppUpdateYmlFlags() {
  const updater = newUpdater();
  updater.setFeedURL({ provider: 'generic', url: 'http://127.0.0.1:1/' });
  const disk = await updater.configOnDisk.value;           // still readable
  const src = fs.readFileSync(path.join(pkgRoot, 'out', 'AppUpdater.js'), 'utf8');
  const nsisSrc = fs.readFileSync(path.join(pkgRoot, 'out', 'NsisUpdater.js'), 'utf8');
  return {
    configOnDiskStillReadable: true,
    diskConfig: disk,
    providerFeedBypassed: updater.clientPromise !== null,
    getOrCreateDownloadHelperReadsCacheDirName:
      /const dirName = \(await this\.configOnDisk\.value\)\.updaterCacheDirName/.test(src),
    verifySignatureReadsPublisherName:
      /\(await this\.configOnDisk\.value\)\.publisherName/.test(nsisSrc),
    conclusion:
      'setFeedURL bypasses app-update.yml ONLY for the feed provider. updaterCacheDirName and publisherName/verifyUpdateCodeSignature are still read from app-update.yml during download. Setting win.verifyUpdateCodeSignature:false therefore remains effective.',
  };
}

(async () => {
  const report = {
    task: 'task0-updater-probe',
    ranAt: new Date().toISOString(),
    node: process.version,
    electronUpdaterVersion: updaterVersion,
    lockedAt: '6.3.0 (>= 6.3.0)',
    noRealPackageDownloaded: true,
  };
  try {
    await new Promise((resolve, reject) => {
      fakeOrigin.listen(0, '127.0.0.1', () => { fakePort = fakeOrigin.address().port; resolve(); });
      fakeOrigin.once('error', reject);
    });
    const latestYml = derivedLatestYml();
    fs.writeFileSync(path.join(feedDir, 'latest.yml'), latestYml, 'utf8');
    report.derivedLatestYml = latestYml;
    report.appUpdateYmlUsed = appUpdateYml;
    report.fileFeedStock = { url: fileFeedUrl(), ...(await probeFileFeedStock(latestYml)) };
    report.fileFeedWithInjectedExecutor = await probeFileFeedInjected(latestYml);
    report.loopbackFeed = await probeLoopbackFeed(latestYml);
    report.appUpdateYmlFlags = await probeAppUpdateYmlFlags();
  } catch (e) {
    report.harnessError = String(e && e.stack || e);
  } finally {
    await new Promise((resolve) => fakeOrigin.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log('TASK0_RESULT_JSON_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('TASK0_RESULT_JSON_END');
})();
