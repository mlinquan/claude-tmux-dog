import { describe, it, expect } from 'vitest';
import { shouldPlaySound } from '../src/notify.js';
import type { NotifyConfig } from '../src/types.js';

const cfg = (o: Partial<NotifyConfig>): NotifyConfig => o as NotifyConfig;

describe('shouldPlaySound', () => {
  describe('master sound off (default)', () => {
    it('plays nothing when sound is false', () => {
      expect(shouldPlaySound(cfg({ sound: false }), 'agent-failed')).toBe(false);
      expect(shouldPlaySound(cfg({ sound: false }), 'nudge')).toBe(false);
    });
    it('plays nothing when sound is unset', () => {
      expect(shouldPlaySound(cfg({}), 'agent-failed')).toBe(false);
    });
    it('sound_on true overrides master off', () => {
      expect(shouldPlaySound(cfg({ sound: false, sound_on: { 'agent-failed': true } }), 'agent-failed')).toBe(true);
    });
  });

  describe('master sound on, no per-event override', () => {
    it('plays critical events by default', () => {
      expect(shouldPlaySound(cfg({ sound: true }), 'agent-failed')).toBe(true);
      expect(shouldPlaySound(cfg({ sound: true }), 'task-completed')).toBe(true);
      expect(shouldPlaySound(cfg({ sound: true }), 'agent-started')).toBe(true);
      expect(shouldPlaySound(cfg({ sound: true }), 'agent-recovered')).toBe(true);
      expect(shouldPlaySound(cfg({ sound: true }), 'max-run-reached')).toBe(true);
    });
    it('mutes chatty events by default', () => {
      expect(shouldPlaySound(cfg({ sound: true }), 'api-error')).toBe(false);
      expect(shouldPlaySound(cfg({ sound: true }), 'nudge')).toBe(false);
      expect(shouldPlaySound(cfg({ sound: true }), 'compact')).toBe(false);
    });
  });

  describe('sound_on overrides', () => {
    it('explicit true forces sound even for chatty events', () => {
      expect(shouldPlaySound(cfg({ sound: true, sound_on: { nudge: true } }), 'nudge')).toBe(true);
      expect(shouldPlaySound(cfg({ sound: true, sound_on: { 'api-error': true } }), 'api-error')).toBe(true);
    });
    it('explicit false mutes even critical events', () => {
      expect(shouldPlaySound(cfg({ sound: true, sound_on: { 'agent-failed': false } }), 'agent-failed')).toBe(false);
    });
    it('explicit true works when master sound is off', () => {
      expect(shouldPlaySound(cfg({ sound: false, sound_on: { 'task-completed': true } }), 'task-completed')).toBe(true);
    });
  });
});
