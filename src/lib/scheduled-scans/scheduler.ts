import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { nextScheduledRun } from './cron';

declare global {
  var __harborguard_scheduled_scan_timer: ReturnType<typeof setInterval> | undefined;
}

let checking = false;

async function checkSchedules() {
  if (checking) return;
  checking = true;
  try {
    const now = new Date();
    const schedules = await prisma.scheduledScan.findMany({
      where: { enabled: true, schedule: { not: null } },
      select: { id: true, schedule: true, nextRunAt: true, createdAt: true, updatedAt: true },
    });

    for (const schedule of schedules) {
      if (!schedule.schedule) continue;
      try {
        if (!schedule.nextRunAt) {
          await prisma.scheduledScan.update({
            where: { id: schedule.id },
            data: { nextRunAt: nextScheduledRun(schedule.schedule) },
          });
          continue;
        }
        // Older releases stored "tomorrow" regardless of the cron expression.
        // Correct those rows on startup so they do not wait a whole day.
        const placeholder = [schedule.createdAt, schedule.updatedAt].some(date => {
          const tomorrow = new Date(date);
          tomorrow.setDate(tomorrow.getDate() + 1);
          return Math.abs(tomorrow.getTime() - schedule.nextRunAt!.getTime()) < 60_000;
        });
        if (placeholder && schedule.nextRunAt > now) {
          await prisma.scheduledScan.updateMany({
            where: { id: schedule.id, nextRunAt: schedule.nextRunAt, schedule: schedule.schedule },
            data: { nextRunAt: nextScheduledRun(schedule.schedule) },
          });
          continue;
        }
        if (schedule.nextRunAt > now) continue;

        const claimed = await prisma.scheduledScan.updateMany({
          where: { id: schedule.id, enabled: true, schedule: schedule.schedule, nextRunAt: schedule.nextRunAt },
          data: { nextRunAt: nextScheduledRun(schedule.schedule) },
        });
        if (claimed.count !== 1) continue;

        const { executeScheduledScan } = await import('./executor');
        const response = await executeScheduledScan(schedule.id, 'SCHEDULED');
        if (!response.ok) logger.error(`[ScheduledScans] ${schedule.id}: execution returned HTTP ${response.status}`);
      } catch (error) {
        logger.error(`[ScheduledScans] Could not run ${schedule.id}:`, error);
      }
    }
  } catch (error) {
    logger.error('[ScheduledScans] Scheduler tick failed:', error);
  } finally {
    checking = false;
  }
}

export function startScheduledScanRunner() {
  if (globalThis.__harborguard_scheduled_scan_timer) return;
  void checkSchedules();
  const timer = setInterval(() => void checkSchedules(), 30_000);
  timer.unref();
  globalThis.__harborguard_scheduled_scan_timer = timer;
}
