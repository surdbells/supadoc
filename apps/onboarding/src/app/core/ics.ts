/** What goes into the interview's calendar file. */
export interface InterviewIcsInput {
  /** The instant (ISO 8601 with offset, or a Date). */
  startsAtUtc: string | Date;
  minutes: number;
  url: string;
  reference: string;
  /** For the UID and DTSTAMP; defaults to now. */
  now?: Date;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 20261014T090000Z */
function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines. */
export function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds a content line at 75 octets (continuation lines start with a space). */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

/**
 * The interview as an iCalendar file (RFC 5545): UTC start and end, CRLF line
 * endings, escaped text. No names or contact details go in it.
 */
export function buildInterviewIcs(input: InterviewIcsInput): string {
  const start = input.startsAtUtc instanceof Date ? input.startsAtUtc : new Date(input.startsAtUtc);
  if (Number.isNaN(start.getTime())) throw new Error('Invalid interview start');
  const end = new Date(start.getTime() + input.minutes * 60_000);
  const now = input.now ?? new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VideoMed//Doctor applications//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(input.reference)}-${utcStamp(start)}@videomed`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${escapeIcsText(`VideoMed interview (${input.reference})`)}`,
    `DESCRIPTION:${escapeIcsText(`Your VideoMed application interview.\nJoin: ${input.url}\nHave your ID and licence to hand.`)}`,
    `LOCATION:${escapeIcsText(input.url)}`,
    `URL:${input.url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Downloads the file as `videomed-interview.ics`. */
export function downloadIcs(content: string, filename = 'videomed-interview.ics'): void {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
