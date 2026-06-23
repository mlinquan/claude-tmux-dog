// Unit tests for logwatcher.ts — API error classification, intervention logic.
//
// These are the most critical heuristics in cdog: misclassifying an error
// means either (a) killing claude unnecessarily (C-c on a transient network
// blip) or (b) letting it spin on a full context until it crashes.
//
// All tested functions are pure (no tmux/state dependency).

import { describe, it, expect } from 'vitest';
import {
  classifyApiError,
  shouldIntervene,
  interveneThreshold,
  API_ERROR_RE,
  SUCCESS_RE,
} from '../src/logwatcher.js';

describe('logwatcher.ts', () => {
  describe('API_ERROR_RE', () => {
    it('matches standard API error line', () => {
      const line = '2026-06-23T15:57:59.225Z [ERROR] API error (attempt 1/11): undefined Request timed out.';
      expect(API_ERROR_RE.test(line)).toBe(true);
    });

    it('matches without timestamp', () => {
      expect(API_ERROR_RE.test('[ERROR] API error (attempt 2/11): something')).toBe(true);
    });

    it('does not match non-error lines', () => {
      expect(API_ERROR_RE.test('[INFO] Stream started')).toBe(false);
      expect(API_ERROR_RE.test('tool_dispatch_start')).toBe(false);
      expect(API_ERROR_RE.test('')).toBe(false);
    });
  });

  describe('SUCCESS_RE', () => {
    it('matches "Stream started - received first chunk"', () => {
      expect(SUCCESS_RE.test('Stream started - received first chunk')).toBe(true);
    });

    it('matches "[API REQUEST]"', () => {
      expect(SUCCESS_RE.test('[API REQUEST] POST /messages')).toBe(true);
    });

    it('matches "tool_dispatch_start"', () => {
      expect(SUCCESS_RE.test('tool_dispatch_start')).toBe(true);
    });

    it('does not match error lines', () => {
      expect(SUCCESS_RE.test('[ERROR] API error')).toBe(false);
    });
  });

  describe('classifyApiError', () => {
    describe('rate_limit', () => {
      const cases: [string, string][] = [
        ['rate limit', '500 rate_limit: too many requests'],
        ['rate_limit', 'rate_limit error'],
        ['Rate Limit', 'Rate Limit exceeded'],
        ['fair use Chinese', '公平使用 每分钟请求次数过多'],
        ['frequency', 'frequency exceeded'],
        ['429', '429 Too Many Requests'],
      ];

      cases.forEach(([name, line]) => {
        it(`classifies "${name}" as rate_limit`, () => {
          expect(classifyApiError(line)).toBe('rate_limit');
        });
      });
    });

    describe('provider', () => {
      const cases: [string, string][] = [
        ['503', '503 Service Unavailable'],
        ['upstream error', '500 upstream error: bad gateway'],
        ['no available channel', 'no available channel for model'],
        ['overloaded_error', 'overloaded_error: model is busy'],
        ['访问量过大', '该模型当前访问量过大'],
        ['稍后再试', '请稍后再试'],
      ];

      cases.forEach(([name, line]) => {
        it(`classifies "${name}" as provider`, () => {
          expect(classifyApiError(line)).toBe('provider');
        });
      });
    });

    describe('fatal', () => {
      const cases: [string, string][] = [
        ['model_not_found', '503 503 {"error":{"code":"model_not_found","message":"No avai'],
        ['model_not_found simple', 'model_not_found: model not available'],
        ['authentication_failed', 'authentication_failed: invalid key'],
        ['billing_error', 'billing_error: quota exceeded'],
      ];

      cases.forEach(([name, line]) => {
        it(`classifies "${name}" as fatal`, () => {
          expect(classifyApiError(line)).toBe('fatal');
        });
      });
    });

    describe('timeout', () => {
      const cases: [string, string][] = [
        ['timed out', 'Request timed out.'],
        ['524', '524 Proxy Read Timeout'],
        ['TTFB', 'TTFB exceeded 60000ms'],
        ['no response headers', 'no response headers received'],
      ];

      cases.forEach(([name, line]) => {
        it(`classifies "${name}" as timeout`, () => {
          expect(classifyApiError(line)).toBe('timeout');
        });
      });
    });

    describe('unknown', () => {
      it('classifies unclassified errors as unknown', () => {
        expect(classifyApiError('some weird error')).toBe('unknown');
        expect(classifyApiError('[ERROR] API error (attempt 1/11): undefined')).toBe('unknown');
        expect(classifyApiError('')).toBe('unknown');
      });
    });

    describe('priority / ordering', () => {
      it('fatal takes priority over provider', () => {
        // model_not_found + 503 → fatal (model offline, not just busy)
        expect(classifyApiError('503 model_not_found')).toBe('fatal');
      });

      it('fatal takes priority over rate_limit', () => {
        expect(classifyApiError('rate_limit model_not_found')).toBe('fatal');
      });

      it('rate_limit takes priority over provider', () => {
        // If a line mentions both rate_limit and 503, rate_limit wins
        expect(classifyApiError('503 rate_limit')).toBe('rate_limit');
      });

      it('provider takes priority over timeout', () => {
        // If a line mentions both 503 and timed out, provider wins
        expect(classifyApiError('503 timed out')).toBe('provider');
      });

      it('rate_limit takes priority over timeout', () => {
        expect(classifyApiError('rate_limit timed out')).toBe('rate_limit');
      });
    });
  });

  describe('shouldIntervene', () => {
    it('returns true for unknown', () => {
      expect(shouldIntervene('unknown')).toBe(true);
    });

    it('returns true for timeout', () => {
      expect(shouldIntervene('timeout')).toBe(true);
    });

    it('returns false for provider', () => {
      expect(shouldIntervene('provider')).toBe(false);
    });

    it('returns false for rate_limit', () => {
      expect(shouldIntervene('rate_limit')).toBe(false);
    });

    it('returns false for fatal (stop, do not compact)', () => {
      expect(shouldIntervene('fatal')).toBe(false);
    });
  });

  describe('interveneThreshold', () => {
    const defaultThreshold = 3;

    describe('without fast-path (no token data)', () => {
      it('returns defaultThreshold for unknown', () => {
        expect(interveneThreshold('unknown', defaultThreshold)).toBe(3);
      });

      it('returns max(defaultThreshold * 2, 6) for timeout', () => {
        expect(interveneThreshold('timeout', defaultThreshold)).toBe(6);
      });

      it('returns 6 for timeout even when default is 1', () => {
        expect(interveneThreshold('timeout', 1)).toBe(6);
      });

      it('returns 8 for timeout when default is 4', () => {
        expect(interveneThreshold('timeout', 4)).toBe(8);
      });

      it('returns null for provider', () => {
        expect(interveneThreshold('provider', defaultThreshold)).toBe(null);
      });

      it('returns null for rate_limit', () => {
        expect(interveneThreshold('rate_limit', defaultThreshold)).toBe(null);
      });

      it('returns null for fatal (stop immediately, never compact)', () => {
        expect(interveneThreshold('fatal', defaultThreshold)).toBe(null);
      });
    });

    describe('with fast-path (high token count)', () => {
      const maxTokens = 200000;
      const highTokens = Math.round(maxTokens * 0.7); // 140000 = exactly 70%

      it('returns 1 for unknown when tokens >= 70%', () => {
        expect(interveneThreshold('unknown', defaultThreshold, highTokens, maxTokens)).toBe(1);
      });

      it('returns 1 for timeout when tokens >= 70%', () => {
        expect(interveneThreshold('timeout', defaultThreshold, highTokens, maxTokens)).toBe(1);
      });

      it('returns 1 when tokens > 70%', () => {
        const above = Math.round(maxTokens * 0.85);
        expect(interveneThreshold('unknown', defaultThreshold, above, maxTokens)).toBe(1);
      });

      it('still returns null for provider even with high tokens', () => {
        expect(interveneThreshold('provider', defaultThreshold, highTokens, maxTokens)).toBe(null);
      });

      it('still returns null for rate_limit even with high tokens', () => {
        expect(interveneThreshold('rate_limit', defaultThreshold, highTokens, maxTokens)).toBe(null);
      });

      it('still returns null for fatal even with high tokens', () => {
        expect(interveneThreshold('fatal', defaultThreshold, highTokens, maxTokens)).toBe(null);
      });
    });

    describe('with low token count (below 70%)', () => {
      const maxTokens = 200000;
      const lowTokens = Math.round(maxTokens * 0.5); // 100000 = 50%

      it('returns defaultThreshold for unknown with low tokens', () => {
        expect(interveneThreshold('unknown', defaultThreshold, lowTokens, maxTokens)).toBe(3);
      });

      it('returns 6 for timeout with low tokens', () => {
        expect(interveneThreshold('timeout', defaultThreshold, lowTokens, maxTokens)).toBe(6);
      });
    });

    describe('edge cases', () => {
      it('handles null lastUpTokens (no fast-path)', () => {
        expect(interveneThreshold('unknown', defaultThreshold, null, 200000)).toBe(3);
      });

      it('handles undefined lastUpTokens (no fast-path)', () => {
        expect(interveneThreshold('unknown', defaultThreshold, undefined, 200000)).toBe(3);
      });

      it('handles undefined maxTokens (no fast-path)', () => {
        expect(interveneThreshold('unknown', defaultThreshold, 100000, undefined)).toBe(3);
      });

      it('handles both null (no fast-path)', () => {
        expect(interveneThreshold('timeout', defaultThreshold, null, undefined)).toBe(6);
      });
    });
  });
});
