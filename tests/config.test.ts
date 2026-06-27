// Unit tests for config.ts — resolveMdPaths, buildStartCommand, buildRecoverCommand.

import { describe, it, expect } from 'vitest';
import {
  resolveMdPaths,
  buildStartCommand,
  buildRecoverCommand,
} from '../src/config.js';
import type { CdogConfig } from '../src/types.js';

function makeConfig(overrides: Partial<CdogConfig> = {}): CdogConfig {
  return {
    name: 'test-agent',
    cwd: '/project',
    ...overrides,
  };
}

describe('config.ts', () => {
  describe('resolveMdPaths', () => {
    it('returns [] when md is undefined', () => {
      expect(resolveMdPaths(makeConfig())).toEqual([]);
    });

    it('returns [] when md is empty string', () => {
      expect(resolveMdPaths(makeConfig({ md: '' }))).toEqual([]);
    });

    it('resolves a single relative md', () => {
      const cfg = makeConfig({ md: 'task.md' });
      expect(resolveMdPaths(cfg)).toEqual(['/project/task.md']);
    });

    it('resolves a single absolute md', () => {
      const cfg = makeConfig({ md: '/abs/task.md' });
      expect(resolveMdPaths(cfg)).toEqual(['/abs/task.md']);
    });

    it('resolves comma-separated md (with spaces)', () => {
      const cfg = makeConfig({ md: 'task1.md, task2.md' });
      expect(resolveMdPaths(cfg)).toEqual(['/project/task1.md', '/project/task2.md']);
    });

    it('resolves comma-separated md (no spaces)', () => {
      const cfg = makeConfig({ md: 'task1.md,task2.md' });
      expect(resolveMdPaths(cfg)).toEqual(['/project/task1.md', '/project/task2.md']);
    });

    it('resolves array of md', () => {
      const cfg = makeConfig({ md: ['task1.md', 'task2.md'] });
      expect(resolveMdPaths(cfg)).toEqual(['/project/task1.md', '/project/task2.md']);
    });

    it('resolves mixed relative + absolute in array', () => {
      const cfg = makeConfig({ md: ['task.md', '/abs/other.md'] });
      expect(resolveMdPaths(cfg)).toEqual(['/project/task.md', '/abs/other.md']);
    });

    it('resolves mixed relative + absolute in comma string', () => {
      const cfg = makeConfig({ md: 'task.md,/abs/other.md' });
      expect(resolveMdPaths(cfg)).toEqual(['/project/task.md', '/abs/other.md']);
    });

    it('filters out empty entries in comma-separated', () => {
      const cfg = makeConfig({ md: 'task.md,, ,task2.md' });
      expect(resolveMdPaths(cfg)).toEqual(['/project/task.md', '/project/task2.md']);
    });

    it('filters out empty entries in array', () => {
      const cfg = makeConfig({ md: ['task.md', '', '  ', 'task2.md'] });
      expect(resolveMdPaths(cfg)).toEqual(['/project/task.md', '/project/task2.md']);
    });
  });

  describe('buildStartCommand', () => {
    it('includes --session-id and --name', () => {
      const cmd = buildStartCommand(makeConfig(), 'sid-123');
      expect(cmd.cmd).toContain('--session-id');
      expect(cmd.cmd).toContain('sid-123');
      expect(cmd.cmd).toContain('--name');
      expect(cmd.cmd).toContain('test-agent');
    });

    it('includes cat pipe when md is set', () => {
      const cfg = makeConfig({ md: 'task.md' });
      const cmd = buildStartCommand(cfg, 'sid-123');
      expect(cmd.cmd).toContain('cat');
      expect(cmd.cmd).toContain('/project/task.md');
      expect(cmd.cmd).toContain('|');
    });

    it('includes cat with multiple md files', () => {
      const cfg = makeConfig({ md: ['task1.md', 'task2.md'] });
      const cmd = buildStartCommand(cfg, 'sid-123');
      expect(cmd.cmd).toContain('cat');
      expect(cmd.cmd).toContain('/project/task1.md');
      expect(cmd.cmd).toContain('/project/task2.md');
    });

    it('does not include cat when md is not set', () => {
      const cmd = buildStartCommand(makeConfig(), 'sid-123');
      expect(cmd.cmd).not.toContain('cat');
    });

    it('always includes --debug-file', () => {
      const cmd = buildStartCommand(makeConfig(), 'sid-123');
      expect(cmd.cmd).toContain('--debug-file');
    });

    it('prefixes env vars before claude', () => {
      const cfg = makeConfig({ env: { DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1' } });
      const cmd = buildStartCommand(cfg, 'sid-123');
      expect(cmd.cmd).toContain('DISABLE_TELEMETRY=1');
      expect(cmd.cmd).toContain('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1');
      // env comes before claude, after a cat pipe (applies to claude only)
      expect(cmd.cmd.indexOf('DISABLE_TELEMETRY=1')).toBeLessThan(cmd.cmd.indexOf('claude'));
    });

    it('shell-quotes env values with spaces', () => {
      const cfg = makeConfig({ env: { FOO: 'bar baz' } });
      const cmd = buildStartCommand(cfg, 'sid-123');
      expect(cmd.cmd).toContain("FOO='bar baz'");
    });

    it('omits env prefix when not set', () => {
      const cmd = buildStartCommand(makeConfig(), 'sid-123');
      expect(cmd.cmd).toMatch(/^claude /);
    });

    it('uses configured log path when set', () => {
      const cfg = makeConfig({ log: 'logs/debug.log' });
      const cmd = buildStartCommand(cfg, 'sid-123');
      expect(cmd.logPath).toBe('/project/logs/debug.log');
      expect(cmd.cmd).toContain('/project/logs/debug.log');
    });

    it('defaults log path to <cwd>/logs/claude-debug.log', () => {
      const cmd = buildStartCommand(makeConfig(), 'sid-123');
      expect(cmd.logPath).toBe('/project/logs/claude-debug.log');
    });

    it('includes extra args', () => {
      const cfg = makeConfig({ args: ['--model', 'sonnet'] });
      const cmd = buildStartCommand(cfg, 'sid-123');
      expect(cmd.cmd).toContain('--model');
      expect(cmd.cmd).toContain('sonnet');
    });

    it('returns mdPaths array', () => {
      const cfg = makeConfig({ md: ['task1.md', 'task2.md'] });
      const cmd = buildStartCommand(cfg, 'sid-123');
      expect(cmd.mdPaths).toEqual(['/project/task1.md', '/project/task2.md']);
    });
  });

  describe('buildRecoverCommand', () => {
    it('includes --resume and session id', () => {
      const cmd = buildRecoverCommand(makeConfig(), 'sid-123');
      expect(cmd).toContain('--resume');
      expect(cmd).toContain('sid-123');
    });

    it('includes cat pipe when md is set', () => {
      const cfg = makeConfig({ md: 'task.md' });
      const cmd = buildRecoverCommand(cfg, 'sid-123');
      expect(cmd).toContain('cat');
      expect(cmd).toContain('/project/task.md');
      expect(cmd).toContain('|');
    });

    it('includes cat with multiple md files', () => {
      const cfg = makeConfig({ md: ['task1.md', 'task2.md'] });
      const cmd = buildRecoverCommand(cfg, 'sid-123');
      expect(cmd).toContain('/project/task1.md');
      expect(cmd).toContain('/project/task2.md');
    });

    it('always includes --debug-file', () => {
      const cmd = buildRecoverCommand(makeConfig(), 'sid-123');
      expect(cmd).toContain('--debug-file');
    });

    it('does not include cat when md is not set', () => {
      const cmd = buildRecoverCommand(makeConfig(), 'sid-123');
      expect(cmd).not.toContain('cat');
    });
  });
});
