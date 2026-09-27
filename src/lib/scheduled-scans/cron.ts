import cron from 'node-cron';

export function nextScheduledRun(expression: string): Date {
  if (!cron.validate(expression)) throw new Error('Invalid cron schedule');
  const task = cron.createTask(expression, () => {});
  try {
    task.start();
    const next = task.getNextRun();
    if (!next) throw new Error('Cron schedule has no next run');
    return next;
  } finally {
    task.destroy();
  }
}
