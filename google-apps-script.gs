/**
 * FitCircle — Google Sheets storage
 *
 * Paste this into your sheet: Extensions → Apps Script → replace everything → Save.
 * Then Deploy → New deployment → Web app
 *   Execute as:      Me
 *   Who has access:  Anyone          ← must be "Anyone", not "Anyone with a Google account"
 * Copy the /exec URL it gives you. That plus the SECRET below go into Netlify
 * as the environment variables SHEETS_URL and SHEETS_SECRET.
 *
 * Only your Netlify function ever calls this, and it sends the secret with every
 * request. Change SECRET to a long random string before you deploy.
 */

const SECRET = 'CHANGE-ME-TO-A-LONG-RANDOM-STRING';

const TABS = {
  members: ['member_id','email','name','sex','age','height','start_weight','goal_weight',
            'daily_target','mode','maintenance','equipment','training_days','plan_source',
            'sessions_json','updated_at','week_offset'],
  entries: ['member_id','email','date','weight','burned','eaten','note'],
  plans:   ['member_id','day','session','focus','met','minutes','phase','exercise',
            'sets','detail','seconds','rest','cue','week'],
};

/* ------------------------------------------------------------------ */

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return out({ error: 'Bad request body' }); }

  if (body.secret !== SECRET) return out({ error: 'Not authorised' });

  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); }
  catch (err) { return out({ error: 'Sheet busy, try again' }); }

  try {
    switch (body.op) {
      case 'get':    return out({ record: getMember(body.id) });
      case 'put':    return out(putMember(body.id, body.email, body.record));
      case 'delete': return out(deleteMember(body.id));
      case 'list':   return out(listMembers());
      case 'ping':   return out({ ok: true });
      default:       return out({ error: 'Unknown operation' });
    }
  } catch (err) {
    return out({ error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return out({ ok: true, note: 'FitCircle storage is running. Data moves over POST only.' });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------- sheet helpers ---------------------------- */

function tab(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  var headers = TABS[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRows(name) {
  var sh = tab(name), headers = TABS[name];
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, headers.length).getValues();
}

/** Replace every row belonging to one member, leaving other members untouched. */
function replaceRows(name, memberId, newRows) {
  var sh = tab(name), headers = TABS[name];
  var last = sh.getLastRow();
  var existing = last > 1 ? sh.getRange(2, 1, last - 1, headers.length).getValues() : [];
  var kept = existing.filter(function (r) { return String(r[0]) !== String(memberId); });
  var all = kept.concat(newRows);

  if (last > 1) sh.getRange(2, 1, last - 1, headers.length).clearContent();
  if (all.length) {
    sh.getRange(2, 1, all.length, headers.length).setValues(all);
    // keep dates as plain text so the sheet's locale can't reformat them
    if (name === 'entries') sh.getRange(2, 3, all.length, 1).setNumberFormat('@');
  }
}

/** Sheets sometimes hands back a Date object for a YYYY-MM-DD cell. Normalise both. */
function isoDate(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v == null ? '' : v).trim();
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/* ------------------------------ read ------------------------------ */

function getMember(id) {
  var mRow = null;
  readRows('members').forEach(function (r) { if (String(r[0]) === String(id)) mRow = r; });
  if (!mRow) return null;

  var profile = {
    name:         String(mRow[2] || ''),
    sex:          String(mRow[3] || 'male'),
    age:          num(mRow[4]),
    height:       num(mRow[5]),
    startWeight:  num(mRow[6]),
    goalWeight:   num(mRow[7]),
    dailyTarget:  num(mRow[8]),
    mode:         String(mRow[9] || 'simple'),
    maintenance:  num(mRow[10]),
    equipment:    String(mRow[11] || '').split(',').map(trim).filter(Boolean),
    trainingDays: String(mRow[12] || '').split(',').map(trim).filter(Boolean).map(Number),
  };

  var entries = {};
  readRows('entries').forEach(function (r) {
    if (String(r[0]) !== String(id)) return;
    var d = isoDate(r[2]);
    if (!d) return;
    entries[d] = {
      weight: num(r[3]),
      burn:   num(r[4]) || 0,
      intake: num(r[5]),
      note:   String(r[6] || ''),
    };
  });

  var days = {};
  var maxWeek = 1;
  readRows('plans').forEach(function (r) {
    if (String(r[0]) !== String(id)) return;
    var wd = Number(r[1]);
    if (isNaN(wd) || wd < 0 || wd > 6) return;
    var w = Number(r[13]);
    if (isNaN(w) || w < 0) w = 0;          // rows written before week support
    if (w > maxWeek) maxWeek = w;
    if (!days[wd]) days[wd] = { meta: {}, exercises: [] };
    if (!days[wd].meta[w]) {
      days[wd].meta[w] = {
        name: String(r[2] || ''), focus: String(r[3] || ''), note: '',
        met: num(r[4]), minutes: num(r[5]),
      };
    }
    days[wd].exercises.push({
      name:   String(r[7] || ''),
      phase:  String(r[6] || 'Main'),
      sets:   num(r[8]) || 1,
      detail: String(r[9] || ''),
      work:   num(r[10]),
      rest:   num(r[11]) || 0,
      cue:    String(r[12] || ''),
      w:      w,
    });
  });

  var dayKeys = Object.keys(days);
  if (dayKeys.length) {
    profile.customPlan = {
      days: days,
      weeks: maxWeek,
      weekOffset: num(mRow[16]) || 0,
      dayCount: dayKeys.length,
      exCount: dayKeys.reduce(function (s, k) { return s + days[k].exercises.length; }, 0),
      fileName: String(mRow[13] || 'your plan'),
    };
  }

  var sessions = {};
  try { sessions = JSON.parse(mRow[14] || '{}') || {}; } catch (e) { sessions = {}; }

  return { profile: profile, entries: entries, sessions: sessions, email: String(mRow[1] || '') };
}

function trim(s) { return String(s).trim(); }

/* ------------------------------ write ------------------------------ */

function putMember(id, email, record) {
  var p = (record && record.profile) || {};
  var entries = (record && record.entries) || {};
  var sessions = (record && record.sessions) || {};
  var cp = p.customPlan;
  var now = new Date().toISOString();

  replaceRows('members', id, [[
    id, email || '', p.name || '', p.sex || '', p.age || '', p.height || '',
    p.startWeight || '', p.goalWeight || '', p.dailyTarget || '', p.mode || 'simple',
    p.maintenance || '',
    (p.equipment || []).join(','), (p.trainingDays || []).join(','),
    cp ? (cp.fileName || 'uploaded') : 'generated',
    JSON.stringify(sessions).slice(0, 45000),
    now,
    cp ? (cp.weekOffset || 0) : 0,
  ]]);

  var entryRows = Object.keys(entries).sort().map(function (d) {
    var e = entries[d] || {};
    return [id, email || '', d,
      e.weight == null ? '' : e.weight,
      e.burn == null ? '' : e.burn,
      e.intake == null ? '' : e.intake,
      e.note || ''];
  });
  replaceRows('entries', id, entryRows);

  var planRows = [];
  if (cp && cp.days) {
    Object.keys(cp.days).sort().forEach(function (wd) {
      var D = cp.days[wd];
      // new shape carries meta per week; a plan saved earlier carries it on the day
      var meta = D.meta || { 0: { name: D.name, focus: D.focus, met: D.met, minutes: D.minutes } };
      (D.exercises || []).forEach(function (ex) {
        var w = ex.w || 0;
        var M = meta[w] || {};
        planRows.push([id, Number(wd), M.name || '', M.focus || '', M.met || '', M.minutes || '',
          ex.phase || '', ex.name || '', ex.sets || 1, ex.detail || '',
          ex.work == null ? '' : ex.work, ex.rest || 0, ex.cue || '', w]);
      });
    });
  }
  replaceRows('plans', id, planRows);

  return { ok: true, updatedAt: now, entries: entryRows.length, planRows: planRows.length };
}

function deleteMember(id) {
  replaceRows('members', id, []);
  replaceRows('entries', id, []);
  replaceRows('plans', id, []);
  return { ok: true };
}

/* ------------------------------ roster ------------------------------ */

function listMembers() {
  var byMember = {};
  readRows('entries').forEach(function (r) {
    var id = String(r[0]);
    if (!byMember[id]) byMember[id] = { dates: [], weights: [], burned: 0 };
    var d = isoDate(r[2]);
    if (d) byMember[id].dates.push(d);
    var w = num(r[3]);
    if (w != null) byMember[id].weights.push({ d: d, w: w });
    byMember[id].burned += num(r[4]) || 0;
  });

  var members = readRows('members').map(function (r) {
    var id = String(r[0]);
    var agg = byMember[id] || { dates: [], weights: [], burned: 0 };
    agg.weights.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    var recent = agg.weights.slice(-7);
    var trend = recent.length
      ? recent.reduce(function (s, x) { return s + x.w; }, 0) / recent.length
      : null;
    agg.dates.sort();
    return {
      id: id,
      name: String(r[2] || ''),
      email: String(r[1] || ''),
      startWeight: num(r[6]),
      goalWeight: num(r[7]),
      currentWeight: trend == null ? null : Math.round(trend * 100) / 100,
      daysLogged: agg.dates.length,
      lastLog: agg.dates.length ? agg.dates[agg.dates.length - 1] : null,
      bankedKcal: Math.round(agg.burned),
      updatedAt: String(r[15] || ''),
    };
  });

  members.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
  return { count: members.length, members: members };
}

/* ------------------------------------------------------------------ */
/** Run this once from the editor to create the three tabs with headers. */
function setup() {
  tab('members'); tab('entries'); tab('plans');
  SpreadsheetApp.getActiveSpreadsheet().toast('FitCircle tabs are ready.');
}
