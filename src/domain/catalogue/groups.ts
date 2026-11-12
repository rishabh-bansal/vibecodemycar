import type { GroupId } from './types.ts';

/** Display order of sections (spec §1 "Group labels & order"). */
export const GROUP_ORDER: readonly GroupId[] = [
  'exterior-lighting',
  'dashboard',
  'windows-locks',
  'assistance',
  'comfort',
  'service',
];

/** `service` is a tab, not a chip. */
export const UNLOCK_GROUPS: readonly GroupId[] = GROUP_ORDER.filter((g) => g !== 'service');

export const GROUP_LABELS: Record<GroupId, { mobileChip: string; desktopChip: string; section: string }> = {
  'exterior-lighting': { mobileChip: 'LIGHTS', desktopChip: 'LIGHTS', section: 'Lights' },
  dashboard: { mobileChip: 'DASH', desktopChip: 'DASHBOARD', section: 'Dashboard' },
  'windows-locks': { mobileChip: 'LOCKS', desktopChip: 'LOCKS & WINDOWS', section: 'Locks & windows' },
  assistance: { mobileChip: 'ASSIST', desktopChip: 'ASSISTANCE', section: 'Assistance' },
  comfort: { mobileChip: 'COMFORT', desktopChip: 'COMFORT', section: 'Comfort' },
  service: { mobileChip: 'SERVICE', desktopChip: 'SERVICE TOOLS', section: 'Service tools' },
};

export const isGroupId = (value: string): value is GroupId => value in GROUP_LABELS;
