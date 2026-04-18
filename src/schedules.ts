import { query } from './db.js';
import { logger } from './logger.js';
import type { PollSchedule, ScheduleInput, PollScheduleRow, SourceType } from './types/index.js';

/**
 * Convert a database row to a PollSchedule object
 */
function rowToSchedule(row: PollScheduleRow): PollSchedule {
  return {
    id: row.id,
    name: row.name,
    days_of_week: row.days_of_week,
    time_of_day: row.time_of_day,
    timezone: row.timezone,
    sources: row.sources as SourceType[],
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Get all poll schedules
 */
export async function getAllSchedules(): Promise<PollSchedule[]> {
  const { rows } = await query<PollScheduleRow>(
    'SELECT * FROM poll_schedules ORDER BY id'
  );
  return rows.map(rowToSchedule);
}

/**
 * Get enabled poll schedules only
 */
export async function getEnabledSchedules(): Promise<PollSchedule[]> {
  const { rows } = await query<PollScheduleRow>(
    'SELECT * FROM poll_schedules WHERE enabled = true ORDER BY id'
  );
  return rows.map(rowToSchedule);
}

/**
 * Get a schedule by ID
 */
export async function getScheduleById(id: number): Promise<PollSchedule | null> {
  const { rows } = await query<PollScheduleRow>(
    'SELECT * FROM poll_schedules WHERE id = $1',
    [id]
  );

  if (rows.length === 0) {
    return null;
  }

  return rowToSchedule(rows[0]);
}

/**
 * Create a new poll schedule
 */
export async function createSchedule(input: ScheduleInput): Promise<PollSchedule> {
  const { rows } = await query<PollScheduleRow>(
    `INSERT INTO poll_schedules (name, days_of_week, time_of_day, timezone, sources, enabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING *`,
    [
      input.name,
      input.days_of_week,
      input.time_of_day,
      input.timezone,
      input.sources,
      input.enabled ?? true,
    ]
  );

  logger.info(`Created schedule: ${input.name}`);
  return rowToSchedule(rows[0]);
}

/**
 * Update an existing poll schedule
 */
export async function updateSchedule(
  id: number,
  input: Partial<ScheduleInput>
): Promise<PollSchedule | null> {
  // Build update query dynamically
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(input.name);
  }
  if (input.days_of_week !== undefined) {
    updates.push(`days_of_week = $${paramIndex++}`);
    values.push(input.days_of_week);
  }
  if (input.time_of_day !== undefined) {
    updates.push(`time_of_day = $${paramIndex++}`);
    values.push(input.time_of_day);
  }
  if (input.timezone !== undefined) {
    updates.push(`timezone = $${paramIndex++}`);
    values.push(input.timezone);
  }
  if (input.sources !== undefined) {
    updates.push(`sources = $${paramIndex++}`);
    values.push(input.sources);
  }
  if (input.enabled !== undefined) {
    updates.push(`enabled = $${paramIndex++}`);
    values.push(input.enabled);
  }

  if (updates.length === 0) {
    return getScheduleById(id);
  }

  updates.push(`updated_at = NOW()`);
  values.push(id);

  const { rows } = await query<PollScheduleRow>(
    `UPDATE poll_schedules
     SET ${updates.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );

  if (rows.length === 0) {
    return null;
  }

  logger.info(`Updated schedule: ${rows[0].name}`);
  return rowToSchedule(rows[0]);
}

/**
 * Delete a poll schedule
 */
export async function deleteSchedule(id: number): Promise<boolean> {
  const result = await query(
    'DELETE FROM poll_schedules WHERE id = $1',
    [id]
  );

  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) {
    logger.info(`Deleted schedule with id: ${id}`);
  }

  return deleted;
}

/**
 * Convert a schedule to a cron expression
 *
 * Cron format: minute hour day-of-month month day-of-week
 * Example: "0 7 * * 1-5" = 7:00 AM on weekdays
 *
 * Note: node-cron uses 0-6 for Sunday-Saturday, same as our days_of_week format
 */
export function scheduleToCron(schedule: PollSchedule): string {
  // Parse time_of_day (format: HH:MM:SS or HH:MM)
  const timeParts = schedule.time_of_day.split(':');
  const hour = parseInt(timeParts[0], 10);
  const minute = parseInt(timeParts[1], 10);

  // Convert days array to cron day-of-week expression
  let daysExpr: string;

  if (schedule.days_of_week.length === 0) {
    // No days specified, run daily
    daysExpr = '*';
  } else if (schedule.days_of_week.length === 7) {
    // All days
    daysExpr = '*';
  } else {
    // Sort days and check if they're consecutive
    const sortedDays = [...schedule.days_of_week].sort((a, b) => a - b);

    // Check if consecutive
    let isConsecutive = true;
    for (let i = 1; i < sortedDays.length; i++) {
      if (sortedDays[i] !== sortedDays[i - 1] + 1) {
        isConsecutive = false;
        break;
      }
    }

    if (isConsecutive && sortedDays.length > 1) {
      // Use range notation: e.g., 1-5 for Mon-Fri
      daysExpr = `${sortedDays[0]}-${sortedDays[sortedDays.length - 1]}`;
    } else {
      // Use comma-separated list
      daysExpr = sortedDays.join(',');
    }
  }

  return `${minute} ${hour} * * ${daysExpr}`;
}

/**
 * Get the next scheduled run time for a schedule
 * Note: This is a simplified calculation that doesn't account for timezones perfectly
 */
export function getNextRunTime(schedule: PollSchedule): Date | null {
  if (schedule.days_of_week.length === 0) {
    return null;
  }

  const now = new Date();

  // Parse schedule time
  const timeParts = schedule.time_of_day.split(':');
  const scheduleHour = parseInt(timeParts[0], 10);
  const scheduleMinute = parseInt(timeParts[1], 10);

  // Start from today
  const candidate = new Date(now);
  candidate.setHours(scheduleHour, scheduleMinute, 0, 0);

  // Check the next 8 days to find the next matching day
  for (let i = 0; i < 8; i++) {
    const dayOfWeek = candidate.getDay();

    if (schedule.days_of_week.includes(dayOfWeek)) {
      // This day matches
      if (candidate > now) {
        return candidate;
      }
    }

    // Move to next day
    candidate.setDate(candidate.getDate() + 1);
  }

  return null;
}

/**
 * Validate a schedule input
 */
export function validateScheduleInput(input: ScheduleInput): string[] {
  const errors: string[] = [];

  if (!input.name || input.name.trim().length === 0) {
    errors.push('Name is required');
  }

  if (!input.days_of_week || input.days_of_week.length === 0) {
    errors.push('At least one day must be selected');
  } else {
    for (const day of input.days_of_week) {
      if (day < 0 || day > 6) {
        errors.push('Invalid day of week (must be 0-6)');
        break;
      }
    }
  }

  // Validate time format (HH:MM or HH:MM:SS)
  const timeRegex = /^([01]?[0-9]|2[0-3]):([0-5][0-9])(:[0-5][0-9])?$/;
  if (!input.time_of_day || !timeRegex.test(input.time_of_day)) {
    errors.push('Invalid time format (use HH:MM)');
  }

  if (!input.timezone || input.timezone.trim().length === 0) {
    errors.push('Timezone is required');
  }

  if (!input.sources || input.sources.length === 0) {
    errors.push('At least one source must be selected');
  } else {
    const validSources = ['reddit', 'bluesky', 'youtube', 'discord', 'mastodon'];
    for (const source of input.sources) {
      if (!validSources.includes(source)) {
        errors.push(`Invalid source: ${source}`);
        break;
      }
    }
  }

  return errors;
}
