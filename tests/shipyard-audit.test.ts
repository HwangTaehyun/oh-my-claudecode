import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(import.meta.url), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'shipyard-audit.mjs');

interface AuditFinding {
  id: string;
  title: string;
  severity: string;
  confidence: string;
  actionable: boolean;
  evidence: string[];
  advice: string;
}

interface AuditReport {
  scannedRoot: string;
  findings: AuditFinding[];
  summary: { counts: Record<string, number>; verdict: string };
}

function runAudit(root: string): { status: number; report: AuditReport | null; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, report: JSON.parse(out) as AuditReport, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      report: e.stdout ? (JSON.parse(e.stdout) as AuditReport) : null,
      stderr: e.stderr ?? '',
    };
  }
}

function seedCleanYard(root: string): void {
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# Project\n\n## Project conventions\n\n- conventions\n\n## Standards index\n\n- Architecture: docs/standards/architecture.md\n',
  );
  writeFileSync(join(root, 'CONTEXT.md'), '---\ndocumentLanguage: en\n---\n\n# Glossary\n');
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers": {}}\n');
  for (const dir of ['docs/adr', 'docs/standards', 'docs/business', 'design-system', '.omc/skills', 'scripts']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'docs', 'standards', 'architecture.md'), '# Architecture Standards\n');
}

describe('shipyard-audit script (the --check structured finding contract)', () => {
  let yard: string;

  beforeEach(() => {
    yard = mkdtempSync(join(tmpdir(), 'shipyard-audit-'));
  });

  afterEach(() => {
    if (yard && existsSync(yard)) rmSync(yard, { recursive: true, force: true });
  });

  it('exits 0 with no findings on a clean yard', () => {
    seedCleanYard(yard);
    const { status, report } = runAudit(yard);
    expect(status).toBe(0);
    expect(report!.findings).toEqual([]);
    expect(report!.summary.verdict).toBe('clear');
  });

  it('exits 1 and reports missing surfaces on an empty directory', () => {
    const { status, report } = runAudit(yard);
    expect(status).toBe(1);
    expect(report!.summary.verdict).toBe('review-recommended');
    const ids = report!.findings.map((f) => f.id);
    expect(ids).toContain('shipyard.surface.missing.CLAUDE-md');
    expect(ids).toContain('shipyard.surface.missing.CONTEXT-md');
  });

  it('every finding carries the shared severity/confidence/actionable vocabulary', () => {
    const { report } = runAudit(yard);
    expect(report!.findings.length).toBeGreaterThan(0);
    for (const f of report!.findings) {
      expect(['high', 'medium', 'low', 'info']).toContain(f.severity);
      expect(['high', 'low']).toContain(f.confidence);
      expect(typeof f.actionable).toBe('boolean');
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it('reports a missing documentLanguage tag and an invalid tag distinctly', () => {
    writeFileSync(join(yard, 'CONTEXT.md'), '# Glossary (no frontmatter)\n');
    const { report } = runAudit(yard);
    expect(report!.findings.some((f) => f.id === 'shipyard.document-language.missing-frontmatter')).toBe(true);

    writeFileSync(join(yard, 'CONTEXT.md'), '---\nnotLanguage: en\n---\n\n# Glossary\n');
    const second = runAudit(yard);
    expect(second.report!.findings.some((f) => f.id === 'shipyard.document-language.missing-tag')).toBe(true);

    writeFileSync(join(yard, 'CONTEXT.md'), '---\ndocumentLanguage: not-a-tag!\n---\n\n# Glossary\n');
    const third = runAudit(yard);
    expect(third.report!.findings.some((f) => f.id === 'shipyard.document-language.invalid-tag')).toBe(true);
  });

  it('reports dead paths referenced from CLAUDE.md', () => {
    seedCleanYard(yard);
    writeFileSync(
      join(yard, 'CLAUDE.md'),
      '# Project\n\n## Standards index\n\n- Architecture: docs/standards/architecture.md\n- Ghost: docs/standards/does-not-exist.md\n',
    );
    const { status, report } = runAudit(yard);
    expect(status).toBe(1);
    const dead = report!.findings.filter((f) => f.id === 'shipyard.claude-md.dead-path');
    expect(dead.length).toBe(1);
    expect(dead[0].evidence).toEqual(['docs/standards/does-not-exist.md']);
  });

  it('never emits heuristic-class findings (terms unused, standards unreferenced)', () => {
    seedCleanYard(yard);
    const { report } = runAudit(yard);
    expect(
      report!.findings.every((f) => !f.id.startsWith('shipyard.glossary') && !f.id.startsWith('shipyard.standards')),
    ).toBe(true);
  });
});
