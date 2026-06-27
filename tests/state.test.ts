// Unit tests for state.ts — file locking, CRUD, concurrency safety.
//
// Each test uses a temp CDOG_DIR (via env var) so the user's real
// ~/.cdog/state.json is never touched.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set CDOG_DIR before importing state — state.ts reads it at module load.
const tmpDir = mkdtempSync(join(tmpdir(), 'cdog-test-'));
process.env.CDOG_DIR = tmpDir;

// Import after env is set.
const { loadState, saveState, getAgent, upsertAgent, mutateAgent, removeAgent } =
  await import('../src/state.js');
import type { AgentState } from '../src/types.js';

function makeAgent(name: string = 'test'): AgentState {
  return {
    name,
    session_id: `sid-${name}`,
    tmux_session: name,
    claude_status: 'running',
    cdog_status: 'watching',
    stop_reason: null,
    ended_at: null,
    started_at: new Date().toISOString(),
    last_error: null,
    last_restart_at: null,
    restart_count: 0,
    nudge_count: 0,
  };
}

describe('state.ts', () => {
  beforeEach(() => {
    // Clean state before each test
    saveState({});
  });

  afterEach(() => {
    saveState({});
  });

  describe('loadState / saveState', () => {
    it('returns empty object when state file exists but is empty', () => {
      const state = loadState();
      expect(state).toEqual({});
    });

    it('returns empty object when state file is missing', () => {
      rmSync(join(tmpDir, 'state.json'), { force: true });
      const state = loadState();
      expect(state).toEqual({});
    });

    it('returns empty object when state file is corrupt', () => {
      writeFileSync(join(tmpDir, 'state.json'), 'not json{', 'utf8');
      const state = loadState();
      expect(state).toEqual({});
    });

    it('round-trips save and load', () => {
      const agent = makeAgent('alpha');
      saveState({ alpha: agent });
      const loaded = loadState();
      expect(loaded.alpha).toEqual(agent);
    });
  });

  describe('durability (WS-A)', () => {
    it('backs up a corrupt state file instead of silently wiping it', () => {
      const corrupt = 'not json{';
      writeFileSync(join(tmpDir, 'state.json'), corrupt, 'utf8');
      const state = loadState();
      // Contract preserved: still returns {} for corrupt input.
      expect(state).toEqual({});
      // A backup of the original corrupt contents now exists on disk.
      const backups = readdirSync(tmpDir).filter((f) => /^state\.json\.corrupt\./.test(f));
      expect(backups.length).toBeGreaterThanOrEqual(1);
      expect(readFileSync(join(tmpDir, backups[backups.length - 1]!), 'utf8')).toBe(corrupt);
    });

    it('leaves state.json intact and cleans the temp file when a save cannot start', () => {
      // Seed a valid, complete state.
      saveState({ keep: makeAgent('keep') });
      const before = readFileSync(join(tmpDir, 'state.json'), 'utf8');

      // Pre-create the temp file so saveStateRaw's openSync(tmp, 'wx') throws
      // EEXIST — a deterministic way to trigger the failure path without mocking fs.
      const tmp = join(tmpDir, `state.json.tmp.${process.pid}`);
      writeFileSync(tmp, 'partial junk that must never become state.json', 'utf8');

      expect(() => saveState({ other: makeAgent('other') })).toThrow();

      // Atomicity: only the temp was ever written; state.json is untouched.
      expect(readFileSync(join(tmpDir, 'state.json'), 'utf8')).toBe(before);
      // The failure path cleaned up its temp file.
      expect(existsSync(tmp)).toBe(false);
    });

    it('does not leave a temp file behind after a successful save', () => {
      saveState({ ok: makeAgent('ok') });
      const leftovers = readdirSync(tmpDir).filter((f) => /^state\.json\.tmp\./.test(f));
      expect(leftovers).toEqual([]);
    });
  });

  describe('getAgent', () => {
    it('returns agent by name', () => {
      upsertAgent(makeAgent('beta'));
      const agent = getAgent('beta');
      expect(agent).toBeDefined();
      expect(agent!.name).toBe('beta');
    });

    it('returns undefined for missing agent', () => {
      expect(getAgent('nonexistent')).toBeUndefined();
    });
  });

  describe('upsertAgent', () => {
    it('inserts a new agent', () => {
      upsertAgent(makeAgent('gamma'));
      expect(getAgent('gamma')).toBeDefined();
    });

    it('replaces an existing agent', () => {
      upsertAgent(makeAgent('delta'));
      const updated = makeAgent('delta');
      updated.nudge_count = 5;
      upsertAgent(updated);
      expect(getAgent('delta')!.nudge_count).toBe(5);
    });
  });

  describe('mutateAgent', () => {
    it('mutates fields in place', () => {
      upsertAgent(makeAgent('epsilon'));
      mutateAgent('epsilon', (a) => {
        a.nudge_count = 3;
        a.claude_status = 'failed';
      });
      const agent = getAgent('epsilon')!;
      expect(agent.nudge_count).toBe(3);
      expect(agent.claude_status).toBe('failed');
    });

    it('returns undefined for missing agent', () => {
      expect(mutateAgent('nope', () => {})).toBeUndefined();
    });

    it('persists changes to disk', () => {
      upsertAgent(makeAgent('zeta'));
      mutateAgent('zeta', (a) => {
        a.restart_count = 7;
      });
      // Reload from disk to verify persistence
      const raw = JSON.parse(readFileSync(join(tmpDir, 'state.json'), 'utf8'));
      expect(raw.zeta.restart_count).toBe(7);
    });

    it('supports replacement return', () => {
      upsertAgent(makeAgent('eta'));
      mutateAgent('eta', (a) => {
        return { ...a, nudge_count: 99 };
      });
      expect(getAgent('eta')!.nudge_count).toBe(99);
    });
  });

  describe('removeAgent', () => {
    it('removes an agent', () => {
      upsertAgent(makeAgent('theta'));
      removeAgent('theta');
      expect(getAgent('theta')).toBeUndefined();
    });

    it('does not throw for missing agent', () => {
      expect(() => removeAgent('nonexistent')).not.toThrow();
    });
  });

  describe('concurrency', () => {
    it('serializes concurrent mutations (no lost updates)', () => {
      upsertAgent(makeAgent('concurrent'));
      // Simulate rapid sequential mutations (same process, but lock is tested)
      for (let i = 0; i < 100; i++) {
        mutateAgent('concurrent', (a) => {
          a.nudge_count = (a.nudge_count ?? 0) + 1;
        });
      }
      expect(getAgent('concurrent')!.nudge_count).toBe(100);
    });
  });

  describe('lock cleanup', () => {
    it('does not leave stale lock files after operations', () => {
      upsertAgent(makeAgent('lock-test'));
      mutateAgent('lock-test', () => {});
      removeAgent('lock-test');
      const lockPath = join(tmpDir, 'state.json.lock');
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});

// Cleanup temp dir after all tests
afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
