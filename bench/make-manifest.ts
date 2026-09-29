/**
 * One-off maintainer tool: resolves the pinned corpus manifest (corpus/manifest.json).
 * Uses authenticated `gh` for tree listings and curl for raw content.
 *
 *   node bench/make-manifest.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

interface Spec {
  category: string;
  repo: string;
  /** regex on the path, or an explicit list of paths */
  match: RegExp | string[];
  count: number;
}

const SPECS: Spec[] = [
  { category: 'github-workflow', repo: 'actions/starter-workflows', match: /^ci\/[a-z-]+\.yml$/, count: 4 },
  { category: 'github-workflow', repo: 'nodejs/node', match: /^\.github\/workflows\/[a-z-]+\.yml$/, count: 3 },
  { category: 'github-workflow', repo: 'vercel/next.js', match: /^\.github\/workflows\/[a-z_-]+\.yml$/, count: 3 },
  { category: 'github-workflow', repo: 'rust-lang/cargo', match: /^\.github\/workflows\//, count: 3 },
  { category: 'kubernetes', repo: 'kubernetes/examples', match: /\.yaml$/, count: 6 },
  { category: 'kubernetes', repo: 'argoproj/argocd-example-apps', match: /\.yaml$/, count: 3 },
  { category: 'helm-values', repo: 'prometheus-community/helm-charts', match: /^charts\/[^/]+\/values\.yaml$/, count: 3 },
  { category: 'helm-values', repo: 'grafana/helm-charts', match: /values\.yaml$/, count: 3 },
  { category: 'helm-values', repo: 'argoproj/argo-helm', match: /^charts\/[^/]+\/values\.yaml$/, count: 3 },
  { category: 'helm-values', repo: 'traefik/traefik-helm-chart', match: /values\.yaml$/, count: 2 },
  { category: 'compose', repo: 'docker/awesome-compose', match: /compose\.ya?ml$/, count: 6 },
  { category: 'openapi', repo: 'OAI/learn.openapis.org', match: /^examples\/.*\.ya?ml$/, count: 3 },
  { category: 'openapi', repo: 'OAI/OpenAPI-Specification', match: /^tests\/v3\.0\/pass\/.*\.ya?ml$/, count: 2 },
  { category: 'gitlab-ci', repo: 'rocky-linux/peridot', match: ['.gitlab-ci.yml'], count: 1 },
  { category: 'gitlab-ci', repo: 'oofnikj/docker-openwrt', match: ['.gitlab-ci.yml'], count: 1 },
  { category: 'gitlab-ci', repo: 'rambler-digital-solutions/rambler-ui', match: ['.gitlab-ci.yml'], count: 1 },
  { category: 'gitlab-ci', repo: 'USNavalResearchLaboratory/simdissdk', match: ['.gitlab-ci.yml'], count: 1 },
  { category: 'gitlab-ci', repo: 'espressif/esp-azure', match: ['.gitlab-ci.yml'], count: 1 },
  { category: 'gitlab-ci', repo: 'erlang/docker-erlang-example', match: ['.gitlab-ci.yml'], count: 1 },
  { category: 'gitlab-ci', repo: 'KDE/plasma-workspace', match: ['.gitlab-ci.yml'], count: 1 },
  { category: 'dependabot', repo: 'OAI/learn.openapis.org', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'nodejs/node', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'python/cpython', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'psf/requests', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'cli/cli', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'fastapi/fastapi', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'pytest-dev/pytest', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'hashicorp/terraform', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'docker/compose', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'helm/helm', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'dependabot', repo: 'actions/checkout', match: ['.github/dependabot.yml'], count: 1 },
  { category: 'renovate', repo: 'Apadmi-Engineering/fastlane-plugin-screenshotbot', match: ['renovate.yaml'], count: 1 },
  { category: 'renovate', repo: 'rjw57/devcontainer', match: ['renovate.yaml'], count: 1 },
  { category: 'renovate', repo: 'coreyjonoliver/dotfiles', match: ['renovate.yaml'], count: 1 },
  { category: 'renovate', repo: 'hmcts/cnp-flux-config', match: ['apps/monitoring/version-reporter/renovate/renovate.yaml'], count: 1 },
];

const gh = (args: string[]): string =>
  execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });

interface Entry { category: string; repo: string; sha: string; path: string; url: string; sha256: string; bytes: number }
const out: Entry[] = [];

for (const s of SPECS) {
  let sha: string;
  try {
    sha = gh(['api', `repos/${s.repo}/commits/HEAD`, '--jq', '.sha']).trim();
  } catch {
    console.error('skip repo', s.repo);
    continue;
  }
  let paths: string[];
  if (Array.isArray(s.match)) paths = s.match;
  else {
    const lines = gh(['api', `repos/${s.repo}/git/trees/${sha}?recursive=1`, '--jq', '.tree[]|select(.type=="blob")|"\\(.size) \\(.path)"']).split('\n');
    const all = lines
      .map((l) => l.split(' '))
      .filter(([size, p]) => p && Number(size) > 300 && Number(size) < 60000 && (s.match as RegExp).test(p))
      .map(([, p]) => p as string);
    const step = Math.max(1, Math.floor(all.length / s.count));
    paths = [];
    for (let i = 0; i < all.length && paths.length < s.count; i += step) paths.push(all[i] as string);
  }
  for (const path of paths) {
    const url = `https://raw.githubusercontent.com/${s.repo}/${sha}/${path}`;
    let body: Buffer;
    try {
      body = execFileSync('curl', ['-fsSL', '-m', '30', url], { timeout: 40_000, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      console.error('skip file', url);
      continue;
    }
    const doc = parseDocument(body.toString('utf8'));
    if (doc.errors.length) {
      console.error('does not parse, skip', url);
      continue;
    }
    out.push({ category: s.category, repo: s.repo, sha, path, url, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length });
  }
}
mkdirSync('corpus', { recursive: true });
writeFileSync('corpus/manifest.json', JSON.stringify(out, null, 2) + '\n');
console.log(`${out.length} files`);
const byCat: Record<string, number> = {};
for (const e of out) byCat[e.category] = (byCat[e.category] ?? 0) + 1;
console.log(byCat);
