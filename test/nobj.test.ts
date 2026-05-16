import { describe, test, expect, afterAll } from 'bun:test';
import { encodeSymbols, hostPlatform } from '../nobj';
import type { TargetArch } from '../nobj';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';

// ─── platform / arch detection ────────────────────────────────────────────────

const platform = hostPlatform();
const arch     = (process.arch === 'x64' ? 'x64' : 'arm64') as TargetArch;
const isWin    = platform === 'win32';

// ─── temp file helpers ────────────────────────────────────────────────────────

const TMP     = join(import.meta.dir, '_tmp');
const toClean: string[] = [];

mkdirSync(TMP, { recursive: true });

function tmpPath(name: string): string {
  const p = join(TMP, name);
  toClean.push(p);
  return p;
}

afterAll(() => {
  for (const p of toClean) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
  }
  try { require('fs').rmdirSync(TMP); } catch {}
});

// ─── clang helpers ────────────────────────────────────────────────────────────

function cc(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('clang', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stderr ?? '') + (r.stdout ?? '') };
}

function run(bin: string): { ok: boolean; stdout: string } {
  const r = spawnSync(bin, [], { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

// ─── C harness ────────────────────────────────────────────────────────────────

const C_HARNESS = /* c */`
#include <stdio.h>
#include <string.h>
#include <stdint.h>

extern const uint8_t buf_data[];
extern const char    str_data[];
extern const double  num_data;

int main(void) {
  if (buf_data[0] != 0xde) { puts("FAIL buf[0]"); return 1; }
  if (buf_data[1] != 0xad) { puts("FAIL buf[1]"); return 2; }
  if (buf_data[2] != 0xbe) { puts("FAIL buf[2]"); return 3; }
  if (buf_data[3] != 0xef) { puts("FAIL buf[3]"); return 4; }
  if (strcmp(str_data, "hello nobj") != 0) { puts("FAIL str"); return 5; }
  if (num_data < 3.13 || num_data > 3.15) { puts("FAIL num"); return 6; }
  puts("ok");
  return 0;
}
`;

const SYMBOLS = [
  { name: 'buf_data', obj: Buffer.from([0xde, 0xad, 0xbe, 0xef]) },
  { name: 'str_data', obj: 'hello nobj' },
  { name: 'num_data', obj: 3.14 },
];

// ─── tests ────────────────────────────────────────────────────────────────────

describe(`nobj — ${platform}/${arch}`, () => {
  const objExt = isWin ? '.obj' : '.o';
  const binExt = isWin ? '.exe' : '';

  const objPath = tmpPath(`test${objExt}`);
  const cPath   = tmpPath('main.c');
  const binPath = tmpPath(`main${binExt}`);

  test('encodeSymbols returns a non-empty buffer', () => {
    const buf = encodeSymbols(SYMBOLS, arch, platform);
    expect(buf.length).toBeGreaterThan(0);
    writeFileSync(objPath, buf);
  });

  test('clang links the object into an executable', () => {
    writeFileSync(cPath, C_HARNESS);
    const { ok, out } = cc([cPath, objPath, '-o', binPath]);
    expect(ok, `clang stderr:\n${out}`).toBe(true);
  });

  test('executable reads all three symbols correctly', () => {
    const { ok, stdout } = run(binPath);
    expect(ok, `process exited non-zero, output: ${stdout}`).toBe(true);
    expect(stdout.trim()).toBe('ok');
  });
});
