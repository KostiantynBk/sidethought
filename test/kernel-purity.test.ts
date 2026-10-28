import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Text-level guard: deliberately conservative, including comments and strings.
export const forbiddenPatterns: readonly RegExp[] = [
  /\bDate\b/,
  /\bnew\s+Date\s*\(/,
  /\bMath\s*\.\s*random\s*\(/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bperformance\s*\.\s*now\s*\(/,
  /\brequire\s*\(/,
  /\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?['"](?:node:fs|fs|node:net|node:http|better-sqlite3|openai)['"]/,
  /\bimport\s*\(\s*['"](?:node:fs|fs|node:net|node:http|better-sqlite3|openai)['"]\s*\)/,
];

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('kernel purity', () => {
  it('contains none of the forbidden operations or imports', () => {
    const files = ['src/kernel', 'src/contract'].flatMap((directory) => typescriptFiles(resolve(directory)));
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbiddenPatterns.filter((pattern) => pattern.test(source)).map((pattern) => `${file}: ${pattern}`);
    });
    expect(violations).toEqual([]);
  });
});
