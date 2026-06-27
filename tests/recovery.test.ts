// Unit tests for recovery.ts — parsePaneTokens, COMPACT_TOKEN_RATIO.
//
// parsePaneTokens is a pure function (no tmux dependency), so it's directly
// testable. compactOrNudge requires tmux + state mocking, so it's not tested
// here (covered by integration testing instead).

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'cdog-test-'));
process.env.CDOG_DIR = tmpDir;

const { parsePaneTokens, COMPACT_TOKEN_RATIO, isClaudeWorking } = await import('../src/recovery.js');

describe('recovery.ts', () => {
  describe('parsePaneTokens', () => {
    it('parses ↑ 24.6k tokens', () => {
      const pane = '✻ Jitterbugging… (32m 26s · ↑ 24.6k tokens)';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: 24600 });
    });

    it('parses ↑ 1.2m tokens', () => {
      const pane = '✻ Working… (5m · ↑ 1.2m tokens)';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: 1200000 });
    });

    it('parses ↑ 500 tokens (no unit)', () => {
      const pane = '✻ Thinking… (2s · ↑ 500 tokens)';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: 500 });
    });

    it('parses ↑ 0 tokens', () => {
      const pane = '✻ Idle (↑ 0 tokens)';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: 0 });
    });

    it('returns null when no token line found', () => {
      const pane = '✻ Jitterbugging… (32m 26s)';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: null });
    });

    it('returns null for empty pane', () => {
      expect(parsePaneTokens('')).toEqual({ upTokens: null });
    });

    it('handles ANSI escape codes in pane content', () => {
      const pane = '\x1b[32m✻\x1b[0m Working… \x1b[2m(↑ 15.3k tokens)\x1b[0m';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: 15300 });
    });

    it('handles ↓ (down tokens) — should NOT match', () => {
      const pane = '✻ Working… (↓ 14.4k tokens)';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: null });
    });

    it('handles both ↑ and ↓ — should match ↑ only', () => {
      const pane = '✻ Working… (↓ 14.4k tokens · ↑ 15.6k tokens)';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: 15600 });
    });

    it('handles uppercase K', () => {
      const pane = '↑ 200K tokens';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: 200000 });
    });

    it('handles decimal without unit', () => {
      const pane = '↑ 12345 tokens';
      expect(parsePaneTokens(pane)).toEqual({ upTokens: 12345 });
    });
  });

  describe('COMPACT_TOKEN_RATIO', () => {
    it('is 0.8', () => {
      expect(COMPACT_TOKEN_RATIO).toBe(0.8);
    });
  });

  describe('isClaudeWorking', () => {
    it('true while working (live spinner + ellipsis + timer)', () => {
      expect(isClaudeWorking('✻ Incubating… (1m 47s · ↓ 2.0k tokens)')).toBe(true);
      expect(isClaudeWorking('✻ Jitterbugging… (32m 26s · ↑ 24.6k tokens)')).toBe(true);
    });
    it('false when idle (past-tense, no ellipsis)', () => {
      expect(isClaudeWorking('✻ Cogitated for 1m 54s')).toBe(false);
      expect(isClaudeWorking('❯')).toBe(false);
      expect(isClaudeWorking('')).toBe(false);
    });
  });
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
