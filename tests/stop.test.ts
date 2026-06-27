// Unit tests for `cdog stop` abort logic (WS-C).
//
// The abort DECISION is a pure function (decideAbort) covering the matrix
// without tmux. Config loading (shouldAbortWork default false) is checked
// against a real temp cdog.json.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'cdog-stop-'));
process.env.CDOG_DIR = tmpDir;

const { decideAbort, isWorking } = await import('../src/commands/stop.js');
const { loadConfig } = await import('../src/config.js');
import type { ClaudeStatus } from '../src/types.js';

describe('cdog stop abort (WS-C)', () => {
  describe('isWorking', () => {
    it('true only for running/pending', () => {
      const yes: ClaudeStatus[] = ['running', 'pending'];
      const no: ClaudeStatus[] = ['waiting', 'completed', 'failed', 'stopped', 'starting'];
      for (const s of yes) expect(isWorking(s)).toBe(true);
      for (const s of no) expect(isWorking(s)).toBe(false);
    });
  });

  describe('decideAbort matrix', () => {
    const on = { abortWork: true, sessionAlive: true };

    it('aborts when enabled + working + alive', () => {
      expect(decideAbort({ ...on, status: 'running' })).toBe(true);
      expect(decideAbort({ ...on, status: 'pending' })).toBe(true);
    });

    it('does NOT abort when claude is not mid-turn', () => {
      for (const s of ['waiting', 'completed', 'failed', 'stopped', 'starting'] as ClaudeStatus[]) {
        expect(decideAbort({ ...on, status: s })).toBe(false);
      }
    });

    it('does NOT abort when abort_work is disabled (default)', () => {
      expect(decideAbort({ abortWork: false, sessionAlive: true, status: 'running' })).toBe(false);
    });

    it('does NOT abort when the tmux session is gone', () => {
      expect(decideAbort({ abortWork: true, sessionAlive: false, status: 'running' })).toBe(false);
    });
  });

  describe('config default', () => {
    afterEach(() => {
      try { rmSync(join(tmpDir, 'cfg.json'), { force: true }); } catch { /* ignore */ }
    });

    it('stop.abort_work defaults to undefined (falsy) when absent', () => {
      const cfgPath = join(tmpDir, 'cfg.json');
      writeFileSync(cfgPath, JSON.stringify({ name: 'x', cwd: tmpDir }), 'utf8');
      expect(loadConfig(cfgPath).stop?.abort_work).toBeUndefined();
    });

    it('stop.abort_work parses when set', () => {
      const cfgPath = join(tmpDir, 'cfg.json');
      writeFileSync(cfgPath, JSON.stringify({ name: 'x', cwd: tmpDir, stop: { abort_work: true } }), 'utf8');
      expect(loadConfig(cfgPath).stop?.abort_work).toBe(true);
    });
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
