/** `10:42`, on the device's clock (the person's wall time). */
export function clockTime(at: Date): string {
  return new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', hour12: false }).format(at);
}

const dayKey = (at: Date) => `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;

/** `10:42` today, `10:42 yesterday`, or `10:42 on Mon 5 Oct` (device time), for the timer's banner. */
export function clockLabel(at: Date, now: Date): string {
  const time = clockTime(at);
  if (dayKey(at) === dayKey(now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(at) === dayKey(yesterday)) return `${time} yesterday`;
  const day = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).format(at);
  return `${time} on ${day}`;
}
