#!/usr/bin/env node
// Shipyard yard audit — the mechanically checkable half of `drydock --check`.
//
// Emits findings in the vocabulary the lookout feature and the drydock skill
// text already document (severity / confidence / actionable), so both surfaces
// share one contract. Covers only the high-confidence finding classes; the
// heuristic classes (glossary terms unused in code, standards never
// referenced) stay prose-layer in the skill text and are never emitted here.
//
// Usage: node scripts/shipyard-audit.mjs [repoRoot]
// Exit 0 = clean (no high-confidence actionable findings)
// Exit 1 = high-confidence actionable findings present
// Exit 2 = invocation/environment error
//
// Output: findings JSON on stdout, human summary on stderr.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SEVERITY = { high: 'high', medium: 'medium', low: 'low', info: 'info' };
const TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

const SURFACES = [
  'CLAUDE.md',
  'CONTEXT.md',
  'docs/adr/',
  'docs/standards/',
  'docs/business/',
  'design-system/',
  '.omc/skills/',
  '.mcp.json',
  'scripts/',
];

function finding(id, title, severity, confidence, actionable, evidence, advice) {
  return { id, title, severity, confidence, actionable, evidence, advice };
}

function checkSurfaces(root) {
  const findings = [];
  for (const surface of SURFACES) {
    if (existsSync(join(root, surface))) continue;
    const isDir = surface.endsWith('/');
    findings.push(
      finding(
        `shipyard.surface.missing.${surface.replace(/[^a-z0-9]+/gi, '-')}`,
        `Missing surface: ${surface}`,
        SEVERITY.high,
        'high',
        true,
        [surface],
        isDir ? `Create the ${surface} directory (see the drydock skill for the seed).` : `Create ${surface} (see the drydock skill for the seed).`,
      ),
    );
  }
  return findings;
}

function checkDocumentLanguage(root) {
  const contextPath = join(root, 'CONTEXT.md');
  if (!existsSync(contextPath)) return [];
  const content = readFileSync(contextPath, 'utf-8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return [
      finding(
        'shipyard.document-language.missing-frontmatter',
        'CONTEXT.md has no YAML frontmatter',
        SEVERITY.high,
        'high',
        true,
        ['CONTEXT.md'],
        'Add frontmatter with a `documentLanguage` tag (see the drydock skill).',
      ),
    ];
  }
  const tag = match[1].match(/^documentLanguage:\s*(\S+)\s*$/m);
  if (!tag) {
    return [
      finding(
        'shipyard.document-language.missing-tag',
        'CONTEXT.md frontmatter lacks a documentLanguage tag',
        SEVERITY.high,
        'high',
        true,
        ['CONTEXT.md'],
        'Add `documentLanguage: <tag>` to the frontmatter.',
      ),
    ];
  }
  if (!TAG_PATTERN.test(tag[1])) {
    return [
      finding(
        'shipyard.document-language.invalid-tag',
        `Invalid documentLanguage tag: ${tag[1]}`,
        SEVERITY.high,
        'high',
        true,
        [tag[1]],
        'Use a BCP-47-style tag (language lowercased, script Title-Case, region uppercase).',
      ),
    ];
  }
  return [];
}

// Fenced blocks hold commands, samples, and templated placeholders. A path
// there is illustrative, not a claim about this repo's layout, so scanning it
// manufactures actionable findings the yard cannot act on.
function stripFencedBlocks(content) {
  const lines = content.split(/\r?\n/);
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function checkClaudeMdDeadPaths(root) {
  const claudePath = join(root, 'CLAUDE.md');
  if (!existsSync(claudePath)) return [];
  const content = stripFencedBlocks(readFileSync(claudePath, 'utf-8'));
  const findings = [];
  const seen = new Set();
  const pathPattern = /\b((?:docs|design-system|scripts|\.omc)\/[\w./-]+)/g;
  for (const m of content.matchAll(pathPattern)) {
    const p = m[1];
    if (seen.has(p)) continue;
    seen.add(p);
    if (existsSync(join(root, p))) continue;
    findings.push(
      finding(
        `shipyard.claude-md.dead-path.${p.replace(/[^a-z0-9]+/gi, '-')}`,
        `CLAUDE.md points at a dead path: ${p}`,
        SEVERITY.high,
        'high',
        true,
        [p],
        'Fix the path or remove the section it belongs to.',
      ),
    );
  }
  return findings;
}

export function auditYard(root) {
  return [...checkSurfaces(root), ...checkDocumentLanguage(root), ...checkClaudeMdDeadPaths(root)];
}

function summarize(findings) {
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`shipyard-audit: not a directory: ${root}`);
    process.exit(2);
  }

  const findings = auditYard(root);
  const counts = summarize(findings);
  const clean = findings.every((f) => !(f.actionable && f.severity === SEVERITY.high));

  console.log(
    JSON.stringify(
      {
        scannedRoot: root,
        findings,
        summary: { counts, verdict: clean ? 'clear' : 'review-recommended' },
      },
      null,
      2,
    ),
  );

  console.error(
    findings.length === 0
      ? 'shipyard-audit: clean — no high-confidence findings'
      : `shipyard-audit: ${findings.length} finding(s) (${counts.high} high)`,
  );
  process.exit(clean ? 0 : 1);
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invoked) main();
