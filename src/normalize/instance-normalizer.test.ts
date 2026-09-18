import { describe, expect, it } from 'vitest';
import { parseDingTalkTime } from './instance-normalizer.js';

describe('parseDingTalkTime', () => {
  it('treats DingTalk Z timestamps as Asia/Shanghai wall-clock time', () => {
    expect(parseDingTalkTime('2026-09-17T16:28Z')?.toISOString())
      .toBe('2026-09-17T08:28:00.000Z');
  });
});
