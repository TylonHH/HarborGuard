import cron from 'node-cron';

export function isValidSchedule(expression: string): boolean {
  return cron.validate(expression);
}

export function nextScheduledRun(expression: string): Date {
  if (!isValidSchedule(expression)) throw new Error('Invalid cron schedule: use five fields (minute hour day month weekday), or six fields with seconds first');
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
