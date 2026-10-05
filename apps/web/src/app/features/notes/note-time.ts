import { inject } from '@angular/core';

import { formatRelativeDate, MT_ORG_TIMEZONE, MT_TODAY } from '@materia/ui';
import { timeOfDay } from '@materia/ui/timeline';

/**
 * When a note was written or changed, in the org's time zone: "Today at 10:42 am", "Yesterday at
 * 4:05 pm", "3 Oct at 9:00 am". Create it in an injection context.
 */
export function noteTime(): (at: Date) => string {
  const today = inject(MT_TODAY);
  const timeZone = inject(MT_ORG_TIMEZONE);
  return (at) => {
    const day = formatRelativeDate(at, today(), timeZone);
    const time = timeOfDay(at, timeZone);
    return time ? `${day} at ${time}` : day;
  };
}
