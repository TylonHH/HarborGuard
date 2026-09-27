import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextScheduledRun } from './cron';

describe('scheduled scan cron', () => {
  it('uses the next matching time instead of an arbitrary 24-hour delay', () => {
    const now = Date.now();
    const next = nextScheduledRun('* * * * *');
    assert.ok(next.getTime() > now);
    assert.ok(next.getTime() - now <= 60_000);
  });

  it('rejects malformed expressions before saving a schedule', () => {
    assert.throws(() => nextScheduledRun('not a cron expression'), /Invalid cron schedule/);
  });
});
