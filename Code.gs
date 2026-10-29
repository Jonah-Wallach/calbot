/***** CalBot v1.1 — vent (email or text) → Gemini → Google Calendar *****/

const CONFIG = {
  LABEL: 'CalBot',
  CALENDAR_NAME: 'Deadlines',
  TZ: 'America/New_York',
  GEMINI_MODEL: 'gemini-2.5-flash',          // if you get a 404, swap in the current Flash name from AI Studio
  DEFAULT_DUE_TIME: '23:59',
  TASK_TIME: '20:00',                         // undated to-dos land at 8pm
  DEFAULT_REMINDERS_MIN: [5 * 1440, 2 * 1440, 1440],
  TASK_REMINDERS_MIN: [0],                    // undated tasks: one reminder at 8pm
  DEADLINE_BLOCK_MIN: 30,
  TASK_BLOCK_MIN: 30,
  DEFAULT_EVENT_MIN: 60,
  DIGEST_DAYS: 14,
  DIGEST_HOUR: 17,
  SHEET_NAME: 'Log',
  LOOKBACK_DAYS: 7,
  REF_LIST_MAX: 80,
  // Google color ids: 11 red, 5 yellow, 10 green, 3 purple, 9 blue, 8 grey
  COLOR: {
    exam: '11', lab: '11', project: '11', office_hours: '11',
    homework: '5', school_event: '5',
    personal: '10',
    career: '3',          // jobs / internships / networking
    unsure: '9',          // blue = Gemini wasn't sure
  },
  COLOR_DONE: '8',
  COLOR_URGENT: '11',
  URGENT_DAYS: 1,         // due today or tomorrow and not done → red
};

const EMOJI = { '11': '🟥', '5': '🟨', '10': '🟩', '3': '🟪', '9': '🟦', '8': '⬜' };
const CATEGORIES = ['exam', 'lab', 'project', 'office_hours', 'homework', 'school_event', 'personal', 'career', 'unsure'];
const HEADERS = ['Added', 'Title', 'Kind', 'Due / Start', 'Notes', 'Reminders', 'Event ID',
                 'Source Msg ID', 'Status', 'Category', 'Reminder Min', 'Original Text'];

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['deadline', 'event', 'task'] },
          category: { type: 'STRING', enum: CATEGORIES },
          date: { type: 'STRING', description: 'YYYY-MM-DD, empty string for tasks' },
          time: { type: 'STRING', description: 'HH:MM 24h, or empty string if not stated' },
          end_time: { type: 'STRING', description: 'HH:MM 24h end if stated, else empty string' },
          notes: { type: 'STRING' },
          extra_reminders_min: { type: 'ARRAY', items: { type: 'INTEGER' } },
          only_custom_reminders: { type: 'BOOLEAN' },
          confident: { type: 'BOOLEAN' },
          reason: { type: 'STRING' },
        },
        required: ['title', 'kind', 'category', 'date', 'time', 'end_time', 'notes',
                   'extra_reminders_min', 'only_custom_reminders', 'confident', 'reason'],
      },
    },
    updates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', enum: ['done', 'undo', 'move', 'cancel'] },
          // Gemini does not pick ONE item. It reports the words the user used (target)
          // and EVERY plausible reference number (candidates); the code picks the winner.
          target: { type: 'STRING', description: 'the words the user used for the item, e.g. "cve hw"' },
          candidates: { type: 'ARRAY', items: { type: 'INTEGER' } },
          new_date: { type: 'STRING' },
          new_time: { type: 'STRING' },
          confident: { type: 'BOOLEAN' },
          reason: { type: 'STRING' },
        },
        required: ['action', 'target', 'candidates', 'new_date', 'new_time', 'confident', 'reason'],
      },
    },
  },
  required: ['items', 'updates'],
};

/* ---------- ONE-TIME SETUP (no need to re-run if triggers already exist) ---------- */
function setup() {
  if (!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')) {
    throw new Error('Add GEMINI_API_KEY in Project Settings → Script Properties first.');
  }
  getLogSheet_();
  getCalendar_();
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processInbox').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('sendDigest').timeBased().everyDays(1).atHour(CONFIG.DIGEST_HOUR).inTimezone(CONFIG.TZ).create();
  Logger.log('Setup done: hourly inbox check + daily digest around 5pm.');
}

/* ---------- HOURLY: process new vents, then recolor urgent items ---------- */
function processInbox() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const done = getProcessed_();
    const threads = GmailApp.search('label:' + CONFIG.LABEL + ' newer_than:' + CONFIG.LOOKBACK_DAYS + 'd', 0, 50);

    threads.forEach(thread => {
      thread.getMessages().forEach(msg => {
        const id = msg.getId();
        if (done.set.has(id)) return;
        // first run: mark already-read mail as handled so old vents aren't re-processed
        if (done.fresh && !msg.isUnread()) { markProcessed_(done, id, 'seeded'); return; }

        const text = (msg.getSubject() + '\n' + msg.getPlainBody()).trim();
        let result;
        try {
          const report = handleVent_(text, msg.getDate(), id);
          sendConfirmation_(text, report);
          result = report.length + ' line(s)';
        } catch (e) {
          result = 'error: ' + e.message;
          sendMail_('CalBot error ⚠️', "Couldn't process this vent:\n\n" + text +
            '\n\nError: ' + e.message + '\n\nResend it to try again.');
        }
        markProcessed_(done, id, result);
        msg.markRead();
      });
    });

    try { escalateUrgent_(); } catch (e) { Logger.log('escalate error: ' + e.message); }
  } finally {
    lock.releaseLock();
  }
}

/* ---------- TEXT / SHORTCUT ENTRY POINT (web app, called by the iPhone Shortcut) ---------- */
function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('WEB_SECRET');
  if (!secret || !e || !e.parameter || e.parameter.key !== secret) {
    return ContentService.createTextOutput('Not authorized');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let text = '';
    try { text = String(JSON.parse(e.postData.contents).text || ''); }
    catch (err) { text = String((e.postData && e.postData.contents) || ''); }
    text = text.replace(/^\s*cal:\s*/i, '').trim();
    if (!text) return ContentService.createTextOutput('Empty message');

    const report = handleVent_(text, new Date(), 'text-' + Date.now());
    return ContentService.createTextOutput(report.length ? report.join('\n\n') : "Didn't find anything to add.");
  } catch (err) {
    return ContentService.createTextOutput('Error: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Core pipeline ---------- */
function handleVent_(text, sentAt, srcId) {
  const cal = getCalendar_();
  const sheet = getLogSheet_();
  const refs = getRefList_(sheet);
  const parsed = parseVent_(text, sentAt, refs);
  Logger.log('PARSED updates: ' + JSON.stringify(parsed.updates));
  const report = [];
  parsed.updates.forEach(u => report.push(applyUpdate_(u, refs, cal, sheet, text, sentAt)));
  parsed.items.forEach(item => report.push(addItem_(item, cal, sheet, srcId, sentAt, text)));
  return report;
}

/* ---------- Gemini ---------- */
function parseVent_(text, sentAt, refs) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const now = Utilities.formatDate(sentAt, CONFIG.TZ, 'EEEE, yyyy-MM-dd HH:mm');
  const refText = refs.length
    ? refs.map(r => '#' + r.n + ' | ' + r.title + ' | due ' +
        Utilities.formatDate(r.due, CONFIG.TZ, 'EEE yyyy-MM-dd HH:mm') + ' | ' +
        (r.status === 'added' ? 'open' : r.status)).join('\n')
    : '(none yet)';

  const prompt = `You turn a student's rambling "vent" (email or text) into calendar actions.
Now: ${now} (America/New_York).

Date table (use it to resolve days):
${dateTable_(sentAt)}

Items already on the calendar (use these reference numbers for updates):
${refText}

Return two lists: ITEMS (new things to add) and UPDATES (changes to items listed above).

ITEMS rules:
- Extract every concrete thing the user needs to do or attend. Ignore feelings and filler. Never invent dates.
- kind "deadline" = something due (homework, labs, projects, papers, applications, emails with a due date). kind "event" = something at a specific time (exams, meetings, office hours, club events). kind "task" = a to-do with NO date and NO time at all (e.g. "send an email to my TA", "remind me to ..."): date and time must be empty strings.
- category: exam (exams, quizzes, tests, finals) | lab (lab reports, lab due) | project (projects, project due dates, group project meetings, term papers) | office_hours (attending office hours) | homework (homework, problem sets, assignments) | school_event (mandatory school or org events, e.g. honor society meetings) | personal (emails, errands, social, fun, library returns, anything else) | career (jobs, internships, applications, hiring-manager emails, interviews, networking, LinkedIn, career fairs) | unsure (cannot tell).
- Weekdays: a bare weekday ("Thursday", "this Thursday") = the soonest upcoming one after today, never today unless the user says today or tonight. "Next Thursday" = the one after that (second soonest). "Next week Thursday" = Thursday of the next calendar week (weeks start Monday). "End of the week" = Friday. Use the date table.
- title: short and scannable, include the course if mentioned (e.g. "Hydro HW", "MCE Exam 2").
- notes: details worth remembering (e.g. "all 3 parts must be done"). Empty string if none.
- time: only if stated, 24h HH:MM. "noon" = 12:00, "midnight" = 23:59 that day. Empty string otherwise.
- end_time: only if an end time is stated, else empty string.
- extra_reminders_min: extra reminders the user explicitly asked for, in minutes before ("an hour before" = 60, "5 hours before" = 300, "the day before" = 1440). Empty array if none.
- only_custom_reminders: true ONLY if the user says to skip or replace the usual reminders for that item.
- confident: false if you cannot tell what this is or when it is; put the reason in reason. Otherwise true and reason is an empty string.
- If an item is mentioned twice, output it once. Do not re-add something already on the calendar with the same date.

UPDATES rules (only for items already listed above). Output ONE update per thing the user refers to.
- target: the words the user used for that item, copied from the vent without dates or filler (e.g. "finished cve hw and chinese he for tmrew" gives two updates with targets "cve hw" and "chinese he").
- candidates: EVERY reference number from the list above that could be the item the user means. Do NOT choose between them; include all of them and the program will pick. Match by meaning, not exact spelling: abbreviations (hw = homework, lab = lab report), typos, and missing words are fine. Only include items that fit what the user said (a "cve hw" update must not list unrelated homework). Empty array if nothing in the list fits.
- action "done": "done", "finished", "submitted", "completed", "turned in" or any synonym. Candidates are the matching OPEN items.
- action "undo": "undo", "not actually done", "need to resubmit", "reopen". Candidates are the matching done or cancelled items.
- action "move": "moved", "pushed back", "rescheduled", "now due ...". Candidates are the matching open items. new_date = YYYY-MM-DD, new_time = HH:MM only if a new time is stated, else empty string.
- action "cancel": "cancelled", "canceled", "no longer happening". Candidates are the matching open items.
- A message that only updates things must have an empty items list. Unused fields are empty strings.

Vent:
"""
${text}
"""`;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.1 },
    }),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const data = JSON.parse(res.getContentText());
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content &&
                 data.candidates[0].content.parts) || [];
  const out = JSON.parse(parts.filter(p => !p.thought).map(p => p.text || '').join(''));
  return { items: out.items || [], updates: out.updates || [] };
}

/* ---------- Adding items ---------- */
function addItem_(item, cal, sheet, srcId, sentAt, original) {
  if (item.confident === false) {
    return deny_(sheet, item.title, item.reason || "wasn't sure what this was", original);
  }
  const cat = CONFIG.COLOR[item.category] ? item.category : 'unsure';
  const isTask = item.kind === 'task';
  let due, allDay = false;

  try {
    if (isTask) {
      // no date given: same day at 8pm (tomorrow if it's already past 8pm)
      let day = Utilities.formatDate(sentAt, CONFIG.TZ, 'yyyy-MM-dd');
      due = Utilities.parseDate(day + ' ' + CONFIG.TASK_TIME, CONFIG.TZ, 'yyyy-MM-dd HH:mm');
      if (due.getTime() <= sentAt.getTime()) {
        day = addDays_(day, 1);
        due = Utilities.parseDate(day + ' ' + CONFIG.TASK_TIME, CONFIG.TZ, 'yyyy-MM-dd HH:mm');
      }
      item.date = day;
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date || '')) {
      return deny_(sheet, item.title, 'no usable date', original);
    } else if (item.kind === 'event' && !item.time) {
      allDay = true;
      due = Utilities.parseDate(item.date, CONFIG.TZ, 'yyyy-MM-dd');
    } else {
      due = Utilities.parseDate(item.date + ' ' + (item.time || CONFIG.DEFAULT_DUE_TIME), CONFIG.TZ, 'yyyy-MM-dd HH:mm');
    }
  } catch (e) {
    return deny_(sheet, item.title, 'bad date or time', original);
  }

  if (findDupe_(sheet, item.title, item.date)) {
    return '↩️ Already on calendar: ' + item.title + ' (' + fmt_(due, allDay) + ')';
  }

  const base = isTask ? CONFIG.TASK_REMINDERS_MIN : CONFIG.DEFAULT_REMINDERS_MIN;
  const intended = [...new Set((item.extra_reminders_min || [])
    .concat(item.only_custom_reminders ? [] : base).filter(m => m >= 0 && m <= 40320))]
    .slice(0, 5).sort((a, b) => b - a);
  const active = intended.filter(m => due.getTime() - m * 60000 > Date.now());

  const color = colorFor_(cat, due);
  const desc = (item.notes ? item.notes + '\n\n' : '') + 'Added by CalBot';
  let ev;

  if (allDay) {
    ev = cal.createAllDayEvent(item.title, due, { description: desc });
  } else if (item.kind === 'event') {
    const end = item.end_time
      ? Utilities.parseDate(item.date + ' ' + item.end_time, CONFIG.TZ, 'yyyy-MM-dd HH:mm')
      : new Date(due.getTime() + CONFIG.DEFAULT_EVENT_MIN * 60000);
    ev = cal.createEvent(item.title, due, end, { description: desc });
  } else if (isTask) {
    ev = cal.createEvent(item.title, due, new Date(due.getTime() + CONFIG.TASK_BLOCK_MIN * 60000), { description: desc });
  } else {
    ev = cal.createEvent('DUE: ' + item.title, new Date(due.getTime() - CONFIG.DEADLINE_BLOCK_MIN * 60000), due, { description: desc });
  }
  ev.setColor(color);
  applyReminders_(ev, intended, item.kind, due);

  sheet.appendRow([new Date(), item.title, item.kind, due, item.notes, active.map(fmtMin_).join(', '),
    ev.getId(), srcId, 'added', cat, JSON.stringify(intended), String(original || '').slice(0, 500)]);

  return EMOJI[color] + ' ' + item.title + ' — ' + fmt_(due, allDay) + ' (' + cat.replace('_', ' ') + ')' +
    (isTask ? '  [no date given → 8pm]' : '') +
    (item.notes ? '\n     ' + item.notes : '') +
    '\n     reminders: ' + (active.length ? active.map(fmtMin_).join(', ') : 'none');
}

function deny_(sheet, title, reason, original) {
  sheet.appendRow([new Date(), title, '', '', reason, '', '', '', 'denied', '', '', String(original || '').slice(0, 500)]);
  return '❌ Event denied: ' + title + ' — ' + reason;
}

function findDupe_(sheet, title, date) {
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return sheet.getDataRange().getValues().slice(1).some(r =>
    (r[8] === 'added' || r[8] === 'done') && norm(r[1]) === norm(title) &&
    r[3] instanceof Date && Utilities.formatDate(r[3], CONFIG.TZ, 'yyyy-MM-dd') === date);
}

/* ---------- Done / undo / move / cancel ---------- */
// The code (not Gemini) decides WHICH item an update applies to.
function applyUpdate_(u, refs, cal, sheet, original, sentAt) {
  const todayStart = startOfDayMs_(sentAt || new Date());
  const hit = resolveRef_(u, refs, todayStart);
  if (!hit) {
    return deny_(sheet, 'Update (' + u.action + '): ' + (u.target || '?'),
      'couldn\'t find anything matching "' + (u.target || '?') + '" among items from the last 3 weeks' +
      (u.reason ? ' (' + u.reason + ')' : ''), original);
  }
  let msg = applyResolved_(u, hit.ref, cal, sheet, original);
  const also = hit.others.filter(r => r.status === hit.ref.status).slice(0, 2);
  if (also.length) {
    msg += '\n     (also matched, left alone: ' +
      also.map(r => r.title + ' ' + fmt_(r.due, false)).join('; ') + ')';
  }
  return msg;
}

function applyResolved_(u, ref, cal, sheet, original) {
  const ev = cal.getEventById(ref.id);
  if (!ev) return deny_(sheet, ref.title, 'that event is no longer on the calendar (deleted by hand?)', original);

  const saved = savedReminders_(ref);

  switch (u.action) {
    case 'done':
      if (ref.status === 'done') return '↩️ Already marked done: ' + ref.title;
      ev.setColor(CONFIG.COLOR_DONE);
      ev.removeAllReminders();
      sheet.getRange(ref.row, 9).setValue('done');
      ref.status = 'done';
      return '☑️ Marked done: ' + ref.title + ' (' + fmt_(ref.due, ev.isAllDayEvent()) + ')';

    case 'cancel':
      if (ref.status !== 'added') return '↩️ Not open, nothing to cancel: ' + ref.title;
      ev.setColor(CONFIG.COLOR_DONE);
      ev.removeAllReminders();
      if (ev.getTitle().indexOf('CANCELLED: ') !== 0) ev.setTitle('CANCELLED: ' + ev.getTitle());
      sheet.getRange(ref.row, 9).setValue('cancelled');
      ref.status = 'cancelled';
      return '🚫 Cancelled (kept in grey): ' + ref.title;

    case 'undo':
      if (ref.status === 'added') return '↩️ Already open: ' + ref.title;
      ev.setTitle(ev.getTitle().replace(/^CANCELLED: /, ''));
      ev.setColor(colorFor_(ref.category, ref.due));
      applyReminders_(ev, saved, ref.kind, ref.due);
      sheet.getRange(ref.row, 9).setValue('added');
      ref.status = 'added';
      return '↩️ Reopened: ' + ref.title + ' (' + fmt_(ref.due, ev.isAllDayEvent()) + ')';

    case 'move': {
      if (ref.status !== 'added') return deny_(sheet, ref.title, 'it is marked ' + ref.status + ', so reopen it first', original);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(u.new_date || '')) return deny_(sheet, ref.title, 'no usable new date', original);
      const allDay = ev.isAllDayEvent();
      let due;
      try {
        if (allDay) {
          due = Utilities.parseDate(u.new_date, CONFIG.TZ, 'yyyy-MM-dd');
          ev.setAllDayDate(due);
        } else if (ref.kind === 'deadline') {
          const t = u.new_time || Utilities.formatDate(ev.getEndTime(), CONFIG.TZ, 'HH:mm');
          due = Utilities.parseDate(u.new_date + ' ' + t, CONFIG.TZ, 'yyyy-MM-dd HH:mm');
          ev.setTime(new Date(due.getTime() - CONFIG.DEADLINE_BLOCK_MIN * 60000), due);
        } else {
          const oldStart = ev.getStartTime();
          const dur = ev.getEndTime().getTime() - oldStart.getTime();
          const t = u.new_time || Utilities.formatDate(oldStart, CONFIG.TZ, 'HH:mm');
          due = Utilities.parseDate(u.new_date + ' ' + t, CONFIG.TZ, 'yyyy-MM-dd HH:mm');
          ev.setTime(due, new Date(due.getTime() + dur));
        }
      } catch (e) {
        return deny_(sheet, ref.title, 'bad new date or time', original);
      }
      ev.setColor(colorFor_(ref.category, due));
      applyReminders_(ev, saved, ref.kind, due);   // reminders reset to match the new date
      sheet.getRange(ref.row, 4).setValue(due);
      ref.due = due;
      return '📅 Moved: ' + ref.title + ' → ' + fmt_(due, allDay) +
        '\n     reminders reset: ' + saved.filter(m => due.getTime() - m * 60000 > Date.now()).map(fmtMin_).join(', ');
    }
  }
  return deny_(sheet, ref.title, 'unknown action', original);
}

/* ---------- Picking WHICH item an update means ---------- */
// Gemini says which items could match (candidates) + the words used (target).
// We run our own word-match first (Gemini's list is the fallback), then apply the user's rule:
//   soonest UPCOMING item wins; only if nothing is upcoming do we fall back to the most recent past one.
function resolveRef_(u, refs, todayStart) {
  const preferred = u.action === 'undo' ? ['done', 'cancelled'] : ['added'];

  const find = pool => {
    const byNum = new Map(pool.map(r => [r.n, r]));
    const fromGemini = (u.candidates || []).map(n => byNum.get(n)).filter(Boolean);
    const fromFuzzy = fuzzyMatch_(u.target, pool);
    // Our own word-match wins (it can't "forget" a second matching item the way a model can);
    // Gemini's list covers meaning-only matches the word-match can't see.
    return fromFuzzy.length ? fromFuzzy : fromGemini;
  };

  // right status first; if nothing, look at everything so we can say "already done" / "already open"
  let cands = find(refs.filter(r => preferred.indexOf(r.status) >= 0));
  if (!cands.length) cands = find(refs);
  if (!cands.length) return null;
  return pickBest_(cands, u.action, todayStart);
}

function pickBest_(cands, action, todayStart) {
  if (action === 'undo') {
    // reopen whichever finished/cancelled item is closest to today
    const s = cands.slice().sort((a, b) =>
      Math.abs(a.due.getTime() - todayStart) - Math.abs(b.due.getTime() - todayStart));
    return { ref: s[0], others: s.slice(1) };
  }
  const sorted = cands.slice().sort((a, b) => a.due.getTime() - b.due.getTime());
  const upcoming = sorted.filter(r => r.due.getTime() >= todayStart);                 // soonest first
  const past = sorted.filter(r => r.due.getTime() < todayStart).reverse();            // most recent first
  const ordered = upcoming.concat(past);
  return { ref: ordered[0], others: ordered.slice(1) };
}

const GENERIC_WORDS = new Set(['homework', 'lab', 'project', 'exam', 'quiz', 'test', 'report', 'paper', 'email', 'meeting']);
const WORD_ALIASES = {
  hw: 'homework', hws: 'homework', homeworks: 'homework', assignment: 'homework', assignments: 'homework',
  pset: 'homework', psets: 'homework', ps: 'homework',
  labs: 'lab', proj: 'project', projects: 'project', exams: 'exam', quizzes: 'quiz', tests: 'test',
};
const STOP_WORDS = new Set(['the', 'a', 'an', 'my', 'our', 'for', 'of', 'to', 'with', 'and', 'on', 'in', 'at', 'due', 'is', 'it', 'that', 'this']);

function tokens_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(Boolean).map(t => WORD_ALIASES[t] || t).filter(t => !STOP_WORDS.has(t));
}

function squash_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function editDistance_(a, b) {
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 1; j <= b.length; j++) { d[0][j] = j; }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function tokenEq_(a, b) {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  if (m >= 3 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)) return true;   // prefix: "chin" ~ "chinese"
  if (m >= 4 && editDistance_(a, b) <= 1) return true;                       // typo
  return false;
}

// Backup matcher used when Gemini lists no usable candidates, and to double-check Gemini's picks.
// Every distinctive word the user said (course names, numbers) must appear in the title.
// Short words and generic words ("hw", "lab") only help the ranking.
function fuzzyMatch_(target, pool) {
  const tt = tokens_(target);
  const tsq = squash_(target);
  if (!tt.length || !tsq) return [];
  const isRequired = t => /^\d+$/.test(t) || (t.length >= 3 && !GENERIC_WORDS.has(t));

  let best = 0, hits = [];
  pool.forEach(r => {
    const st = tokens_(r.title);
    const ssq = squash_(r.title);
    let score = 0;
    if (tsq.length >= 3 && ssq.indexOf(tsq) >= 0) {
      score = 1;                                       // "cvehw" inside "cvehw3"
    } else {
      const matched = tt.filter(t => st.some(s => tokenEq_(t, s)));
      const required = tt.filter(isRequired);
      const allRequiredFound = required.every(t => matched.indexOf(t) >= 0);
      if (!matched.length || !allRequiredFound) return;
      score = matched.length / tt.length;
    }
    if (score > best + 1e-9) { best = score; hits = [r]; }
    else if (Math.abs(score - best) <= 1e-9) hits.push(r);
  });
  return hits;
}

function startOfDayMs_(date) {
  return Utilities.parseDate(Utilities.formatDate(date, CONFIG.TZ, 'yyyy-MM-dd'), CONFIG.TZ, 'yyyy-MM-dd').getTime();
}

function getRefList_(sheet) {
  const now = Date.now();
  const rows = sheet.getDataRange().getValues();
  const refs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[6] || !(r[3] instanceof Date)) continue;
    if (['added', 'done', 'cancelled'].indexOf(r[8]) < 0) continue;
    if (r[3].getTime() < now - 21 * 86400000) continue;
    refs.push({ row: i + 1, id: r[6], title: r[1], due: r[3], status: r[8], kind: r[2], category: r[9], remMin: r[10] });
  }
  refs.sort((a, b) => Math.abs(a.due.getTime() - now) - Math.abs(b.due.getTime() - now));
  const kept = refs.slice(0, CONFIG.REF_LIST_MAX).sort((a, b) => a.due.getTime() - b.due.getTime());
  kept.forEach((r, k) => { r.n = k + 1; });
  return kept;
}

function savedReminders_(ref) {
  try { const a = JSON.parse(ref.remMin); if (Array.isArray(a)) return a; } catch (e) {}
  return ref.kind === 'task' ? CONFIG.TASK_REMINDERS_MIN : CONFIG.DEFAULT_REMINDERS_MIN;
}

function applyReminders_(ev, mins, kind, due) {
  const shift = kind === 'deadline' ? CONFIG.DEADLINE_BLOCK_MIN : 0;
  ev.removeAllReminders();
  mins.filter(m => due.getTime() - m * 60000 > Date.now())
      .forEach(m => ev.addPopupReminder(Math.max(0, m - shift)));
}

/* ---------- Colors ---------- */
function colorFor_(category, due) {
  const known = !!CONFIG.COLOR[category];
  const base = known ? CONFIG.COLOR[category] : CONFIG.COLOR_URGENT;
  const d = daysUntil_(due, new Date());
  if (known && category !== 'unsure' && d >= 0 && d <= CONFIG.URGENT_DAYS) return CONFIG.COLOR_URGENT;
  return base;
}

// anything due today/tomorrow and not done turns red (unsure stays blue so you can review it)
function escalateUrgent_() {
  const sheet = getLogSheet_();
  const rows = sheet.getDataRange().getValues();
  const cal = getCalendar_();
  const now = new Date();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[8] !== 'added' || !r[9] || r[9] === 'unsure' || !r[6] || !(r[3] instanceof Date)) continue;
    const d = daysUntil_(r[3], now);
    if (d < 0 || d > CONFIG.URGENT_DAYS) continue;
    const ev = cal.getEventById(r[6]);
    if (ev && ev.getColor() !== CONFIG.COLOR_URGENT) ev.setColor(CONFIG.COLOR_URGENT);
  }
}

/* ---------- 5pm digest ---------- */
function sendDigest() {
  const cal = getCalendar_();
  const now = new Date();
  const todayStart = Utilities.parseDate(Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd'), CONFIG.TZ, 'yyyy-MM-dd');
  const end = new Date(now.getTime() + CONFIG.DIGEST_DAYS * 86400000);
  const status = statusMap_();
  const upcoming = [], finished = [];

  cal.getEvents(todayStart, end).forEach(ev => {
    const st = status[ev.getId()] || 'added';
    if (st === 'cancelled') return;
    const allDay = ev.isAllDayEvent();
    const title = ev.getTitle();
    const isDeadline = title.indexOf('DUE: ') === 0;
    const when = allDay ? ev.getAllDayStartDate() : (isDeadline ? ev.getEndTime() : ev.getStartTime());
    const notes = (ev.getDescription() || '').replace(/\n*Added by CalBot\s*$/, '').trim();
    const rec = { title: title, when: when, allDay: allDay, notes: notes };
    if (st === 'done') finished.push(rec);
    else if (allDay || when.getTime() >= now.getTime()) upcoming.push(rec);
  });

  if (!upcoming.length && !finished.length) {
    sendMail_('📅 CalBot: nothing due in the next ' + CONFIG.DIGEST_DAYS + ' days', 'Clear skies. (Or you forgot to schedule something 😉)');
    return;
  }

  let urgent = 0;
  const lines = upcoming.map(r => {
    const d = daysUntil_(r.when, now);
    if (d <= 2) urgent++;
    const label = d <= 0 ? 'TODAY' : d === 1 ? 'TOMORROW' : 'in ' + d + ' days';
    return (d <= 2 ? '🔥 ' : '• ') + label + ' — ' + r.title + ' (' + fmt_(r.when, r.allDay) + ')' +
      (r.notes ? '\n     ' + r.notes : '');
  });

  let body = upcoming.length
    ? 'Next ' + CONFIG.DIGEST_DAYS + ' days:\n\n' + lines.join('\n\n')
    : 'Nothing left to do in the next ' + CONFIG.DIGEST_DAYS + ' days.';
  if (finished.length) {
    body += '\n\n— — —\n✅ FINISHED\n' + finished.map(r => '• ' + r.title + ' (' + fmt_(r.when, r.allDay) + ')').join('\n');
  }
  const subject = '📅 CalBot: ' + upcoming.length + ' coming up' + (urgent ? ' — ' + urgent + ' within 2 days' : '');
  sendMail_(subject, body);
}

function statusMap_() {
  const map = {};
  getLogSheet_().getDataRange().getValues().slice(1).forEach(r => { if (r[6]) map[r[6]] = r[8]; });
  return map;
}

/* ---------- Processed-message tracking (so reading a vent never hides it) ---------- */
function getProcessed_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Processed'), fresh = false;
  if (!sh) {
    sh = ss.insertSheet('Processed');
    sh.getRange('A:A').setNumberFormat('@');
    sh.appendRow(['Msg ID', 'Processed At', 'Result']);
    sh.setFrozenRows(1);
    fresh = true;
  }
  const n = sh.getLastRow() - 1;
  const ids = n > 0 ? sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0])) : [];
  return { sheet: sh, set: new Set(ids), fresh: fresh };
}

function markProcessed_(done, id, result) {
  done.sheet.appendRow([id, new Date(), result]);
  done.set.add(id);
}

/* ---------- Helpers ---------- */
function sendConfirmation_(text, report) {
  const body = report.length
    ? "Got it. Here's what I did:\n\n" + report.join('\n\n')
    : "Didn't find anything to add in that one.";
  sendMail_('CalBot: ' + (report.length ? report.length + ' item(s) processed' : 'nothing added'),
    body + '\n\n— — —\nYour vent:\n' + text);
}

function sendMail_(subject, body) {
  GmailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body);
}

function getCalendar_() {
  const cals = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
  if (!cals.length) throw new Error('No calendar named "' + CONFIG.CALENDAR_NAME + '"');
  return cals[0];
}

function getLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  } else if (!sh.getRange(1, 10).getValue()) {
    sh.getRange(1, 10, 1, 3).setValues([HEADERS.slice(9)]).setFontWeight('bold');
  }
  return sh;
}

function dateTable_(now) {
  const today = Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd');
  const noon = Utilities.parseDate(today + ' 12:00', CONFIG.TZ, 'yyyy-MM-dd HH:mm').getTime();
  const lines = [];
  for (let i = 0; i <= 21; i++) {
    lines.push(Utilities.formatDate(new Date(noon + i * 86400000), CONFIG.TZ, 'EEE yyyy-MM-dd') +
      (i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : ''));
  }
  return lines.join('\n');
}

function addDays_(dateStr, n) {
  const d = Utilities.parseDate(dateStr + ' 12:00', CONFIG.TZ, 'yyyy-MM-dd HH:mm');
  return Utilities.formatDate(new Date(d.getTime() + n * 86400000), CONFIG.TZ, 'yyyy-MM-dd');
}

function daysUntil_(date, now) {
  const a = Utilities.parseDate(Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd'), CONFIG.TZ, 'yyyy-MM-dd');
  const b = Utilities.parseDate(Utilities.formatDate(date, CONFIG.TZ, 'yyyy-MM-dd'), CONFIG.TZ, 'yyyy-MM-dd');
  return Math.round((b - a) / 86400000);
}

function fmt_(date, allDay) {
  return Utilities.formatDate(date, CONFIG.TZ, allDay ? 'EEE MMM d' : 'EEE MMM d, h:mm a');
}

function fmtMin_(m) {
  if (m === 0) return 'at time';
  if (m % 1440 === 0) return (m / 1440) + 'd';
  if (m % 60 === 0) return (m / 60) + 'h';
  return m + 'm';
}
