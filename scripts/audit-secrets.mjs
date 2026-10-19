import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
const configs = ['apps/api/.env', 'apps/web/.env'].map(path => parse(readFileSync(path)));
const secrets = configs.flatMap(config => Object.entries(config)
  .filter(([key, value]) => /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|TEST_STAFF_EMAIL/.test(key) && value.length > 5)
  .map(([, value]) => value));
try { secrets.push(decodeURIComponent(new URL(configs[0].DATABASE_URL).password)); } catch { /* no URL output */ }
const git = args => spawnSync('git', ['-c', 'safe.directory=' + resolve('.').replaceAll('\\', '/'), ...args], { encoding: 'utf8' });
const ignored = git(['check-ignore', 'apps/api/.env', 'apps/web/.env']);
const tracked = git(['ls-files', '-z']);
const candidates = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
if (tracked.status !== 0 || candidates.status !== 0) { console.log('Git audit unavailable.'); process.exit(1); }
const trackedPaths = tracked.stdout.split('\0').filter(Boolean);
const candidatePaths = candidates.stdout.split('\0').filter(Boolean);
const leakedCandidates = candidatePaths.filter(path => {
  const text = readFileSync(path, 'utf8');
  return secrets.filter(Boolean).some(value => text.includes(value));
});
const logs = [];
function findLogs(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) findLogs(path);
    else if (entry.name.endsWith('.log')) logs.push(path);
  }
}
findLogs('.');
const loggedSecrets = logs.some(path => secrets.filter(Boolean).some(value => readFileSync(path, 'utf8').includes(value)));
const privateSecrets = Object.entries(configs[0]).filter(([key,value]) => /DATABASE_URL|PASSWORD|SECRET|TOKEN|SERVICE_ROLE|TEST_STAFF_EMAIL/.test(key) && value.length > 5).map(([,value]) => value);
try { privateSecrets.push(decodeURIComponent(new URL(configs[0].DATABASE_URL).password)); } catch { /* no URL output */ }
let browserAssets = [];
try { browserAssets = readdirSync('apps/web/dist/assets').filter(name => /\.(js|css)$/.test(name)).map(name => readFileSync(join('apps/web/dist/assets',name),'utf8')); } catch { /* A build is optional for source-only audits. */ }
const privateCredentialsInBrowserBuild = browserAssets.some(text => privateSecrets.filter(Boolean).some(value => text.includes(value)));
const report = {
  bothEnvironmentFilesIgnored: ignored.status === 0 && ignored.stdout.includes('apps/api/.env') && ignored.stdout.includes('apps/web/.env'),
  environmentFilesTracked: trackedPaths.some(path => /(^|\/)\.env($|\.)/.test(path) && !path.endsWith('.env.example')),
  trackedFileCount: trackedPaths.length,
  candidateFilesScanned: candidatePaths.length,
  credentialMatchesInTrackedOrCandidateFiles: leakedCandidates.length,
  applicationLogFilesScanned: logs.length,
  browserAssetsScanned: browserAssets.length,
  privateCredentialsInBrowserBuild,
  credentialsFoundInApplicationLogs: loggedSecrets,
};
console.log(JSON.stringify(report, null, 2));
if (!report.bothEnvironmentFilesIgnored || report.environmentFilesTracked || leakedCandidates.length || loggedSecrets || privateCredentialsInBrowserBuild) process.exitCode = 1;
