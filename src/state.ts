// state.json read/write helpers.
//
// Concurrency safety: all mutations go through withStateLock(), which uses
// an exclusive file lock (O_EXCL create on a .lock file) with spin-wait +
// timeout. This prevents lost updates when multiple cdog processes (e.g.
// `cdog notify` triggered by concurrent hooks) write state simultaneously.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
  writeSync,
  fsyncSync,
  appendFileSync,
} from 'node:fs';
import type { AgentState, StateMap } from './types.js';
import { STATE_PATH, ensureCdogDir, CDOG_DIR } from './util.js';
import { join } from 'node:path';

const LOCK_PATH = join(CDOG_DIR, 'state.json.lock');
/** Append-only log for state-corruption events (self-contained, no logger import → no cycle). */
const CORRUPT_LOG_PATH = join(CDOG_DIR, 'state-corrupt.log');
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 50;

/**
 * Synchronous sleep that does NOT burn CPU. Atomics.wait blocks the thread
 * (releasing the core) until the timeout elapses — unlike a busy-wait loop.
 * Node.js enables SharedArrayBuffer + Atomics.wait on the main thread by
 * default (unlike browsers). One shared buffer reused across calls.
 */
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function syncSleepMs(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

/**
 * Acquire an exclusive lock on state.json via O_EXCL on a .lock file.
 * Polls every LOCK_POLL_MS (sleeping, not spinning) up to LOCK_TIMEOUT_MS.
 * Throws on timeout.
 *
 * Returns a release function that MUST be called in a finally block.
 */
function acquireLock(): () => void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;

  while (fd === null) {
    try {
      // O_EXCL: fails if file already exists → atomic on POSIX.
      fd = openSync(LOCK_PATH, 'wx');
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        // Stale lock heuristic: if the lock file is older than the timeout,
        // it's likely from a crashed process — remove it and retry once.
        try {
          const stat = readFileSync(LOCK_PATH, 'utf8');
          const lockAge = Date.now() - parseInt(stat, 10);
          if (lockAge > LOCK_TIMEOUT_MS) {
            unlinkSync(LOCK_PATH);
            continue;
          }
        } catch {
          // Can't read lock file — break the stale lock.
          try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
          continue;
        }
        throw new Error(`state.json lock timeout after ${LOCK_TIMEOUT_MS}ms`);
      }
      // Wait without burning a CPU core (Atomics.wait blocks; no spin).
      syncSleepMs(LOCK_POLL_MS);
    }
  }

  // Write our PID + timestamp into the lock file for stale detection.
  writeFileSync(LOCK_PATH, String(Date.now()));

  return () => {
    try { closeSync(fd!); } catch { /* ignore */ }
    try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  };
}

/**
 * Execute a function while holding the state lock.
 * The function receives the current state and returns the new state to persist.
 */
function withStateLock<T>(fn: (state: StateMap) => T): T {
  const release = acquireLock();
  try {
    const state = loadStateRaw();
    const result = fn(state);
    if (result !== undefined && typeof result === 'object') {
      saveStateRaw(result as StateMap);
    }
    return result;
  } finally {
    release();
  }
}

/** Load the full state map (empty if missing/corrupt). No locking. */
function loadStateRaw(): StateMap {
  if (!existsSync(STATE_PATH)) return {};
  let raw: string;
  try {
    raw = readFileSync(STATE_PATH, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as StateMap) : {};
  } catch {
    // Corrupt JSON. Back up the bad file BEFORE returning fresh, so the next
    // save doesn't silently destroy potentially-recoverable data. Preserve the
    // public contract (return {}) — callers depend on a StateMap.
    backupCorruptState(raw);
    return {};
  }
}

/**
 * Back up a corrupt state.json so its contents survive the fresh-start save,
 * and surface the event loudly (stderr + append-only log). Self-contained: no
 * logger import (logger.ts depends on state.ts → would be a cycle).
 */
function backupCorruptState(raw: string): void {
  const ts = Date.now();
  const base = `${STATE_PATH}.corrupt.${ts}`;
  // Avoid clobbering an existing backup that shares the same ms timestamp.
  let backup = base;
  let i = 1;
  while (existsSync(backup)) {
    backup = `${base}.${i++}`;
  }
  try {
    writeFileSync(backup, raw, 'utf8');
  } catch {
    /* can't back up — nothing more we can do; still return fresh below */
  }
  const msg = `[${new Date().toISOString()}] state.json corrupt — backed up to ${backup}, starting fresh\n`;
  try {
    ensureCdogDir();
    appendFileSync(CORRUPT_LOG_PATH, msg, 'utf8');
  } catch { /* ignore */ }
  try {
    console.warn(`[cdog] ${msg.trim()}`);
  } catch { /* ignore */ }
}

/**
 * Persist the full state map atomically: write to a temp file in the same
 * directory, fsync, then rename over the target. POSIX rename is atomic, so a
 * crash mid-write can never leave a half-written state.json — readers always
 * see either the old or the complete new file. Temp name carries the pid as
 * belt-and-suspenders against any path that bypasses the lock. No locking.
 */
function saveStateRaw(state: StateMap): void {
  ensureCdogDir();
  const json = JSON.stringify(state, null, 2) + '\n';
  const tmp = `${STATE_PATH}.tmp.${process.pid}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx'); // O_EXCL: fail if a stale temp exists
    writeSync(fd, json);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, STATE_PATH); // atomic replace
  } catch (e) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/** Load the full state map (empty if missing/corrupt). Public, read-only. */
export function loadState(): StateMap {
  return loadStateRaw();
}

/** Persist the full state map atomically. Public, use withStateLock for mutations. */
export function saveState(state: StateMap): void {
  const release = acquireLock();
  try {
    saveStateRaw(state);
  } finally {
    release();
  }
}

/** Get one agent's state, or undefined. */
export function getAgent(name: string): AgentState | undefined {
  return loadStateRaw()[name];
}

/** Upsert a single agent and persist. Lock-protected. */
export function upsertAgent(agent: AgentState): void {
  withStateLock((state) => {
    state[agent.name] = agent;
    return state;
  });
}

/**
 * Update a single agent via a mutator; persists the result.
 * Returns the new state or undefined if agent missing.
 * The mutator may either mutate `a` in place (return void) or return a replacement object.
 * Lock-protected against concurrent cdog processes.
 */
export function mutateAgent(
  name: string,
  fn: (a: AgentState) => AgentState | void,
): AgentState | undefined {
  const release = acquireLock();
  try {
    const state = loadStateRaw();
    const a = state[name];
    if (!a) return undefined;
    const ret = fn(a);
    state[name] = ret ?? a;
    saveStateRaw(state);
    return state[name];
  } finally {
    release();
  }
}

/** Remove an agent from state. Lock-protected. */
export function removeAgent(name: string): void {
  withStateLock((state) => {
    delete state[name];
    return state;
  });
}
