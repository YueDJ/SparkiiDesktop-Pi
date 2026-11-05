import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scopeName = '@earendil-works';
const requiredPackages = [
  'pi-agent-core',
  'pi-ai',
  'pi-codemode',
  'pi-coding-agent',
  'pi-mcp',
  'pi-schema',
  'pi-telemetry',
  'pi-tui',
];
const expectedVersion = '1.5.0';
const agentHostRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findWorkspaceRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('Cannot find pnpm-workspace.yaml');
    current = parent;
  }
}

findWorkspaceRoot(agentHostRoot);

function findPackageRoot(filePath) {
  let current = dirname(filePath);
  while (true) {
    const packageJsonPath = join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      if (typeof pkg.name === 'string' && pkg.name.startsWith(`${scopeName}/`)) {
        return { packageRoot: current, packageJsonPath, pkg };
      }
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Cannot find ${scopeName} package root for ${filePath}`);
    current = parent;
  }
}

function findDependencyPackage(name, fromPackageRoot) {
  const shortName = name.slice(scopeName.length + 1);
  const candidates = [
    join(fromPackageRoot, 'node_modules', scopeName, shortName, 'package.json'),
    join(dirname(fromPackageRoot), shortName, 'package.json'),
  ];
  let current = fromPackageRoot;
  while (true) {
    candidates.push(join(current, 'node_modules', scopeName, shortName, 'package.json'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return findPackageRoot(realpathSync(candidate));
  }
  throw new Error(`Cannot resolve ${name} from ${fromPackageRoot}`);
}

const piEntry = fileURLToPath(import.meta.resolve(`${scopeName}/pi-coding-agent`));
const rootPackage = findPackageRoot(realpathSync(piEntry));
const discovered = new Map();
const queue = [rootPackage];
while (queue.length > 0) {
  const current = queue.shift();
  const key = realpathSync(current.packageJsonPath);
  if (discovered.has(key)) continue;
  discovered.set(key, current.pkg);
  for (const dependencyName of Object.keys(current.pkg.dependencies ?? {})) {
    if (!dependencyName.startsWith(`${scopeName}/`)) continue;
    queue.push(findDependencyPackage(dependencyName, current.packageRoot));
  }
}

const failures = [];
const packages = [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name));
for (const pkg of packages) {
  console.log(`${pkg.name} ${pkg.version}`);
  if (pkg.version !== expectedVersion) {
    failures.push(`${pkg.name} resolved to ${pkg.version}, expected ${expectedVersion}`);
  }
}

for (const shortName of requiredPackages) {
  const name = `@earendil-works/${shortName}`;
  if (!packages.some((pkg) => pkg.name === name && pkg.version === expectedVersion)) {
    failures.push(`missing ${name}@${expectedVersion}`);
  }
}

if (packages.some((pkg) => pkg.name === '@earendil-works/chord')) {
  failures.push('@earendil-works/chord must not be installed');
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exit(1);
}

console.log(`Pi family verified at ${expectedVersion}`);
