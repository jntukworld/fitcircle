# FitCircle

An invite-only training and fat-loss tracker. Each member signs in, answers a short setup
form, and gets a training week generated from the equipment they actually own and the days
they can actually train. Their weigh-ins and calorie burns are private to them. You get a
roster view.

Nothing here runs on a third-party service. Authentication is Netlify Identity, storage is
Netlify Blobs, and both are included on the Free plan.

---

## What's in the box

```
index.html                      the whole app — no build step, no framework
netlify.toml                    functions directory and security headers
package.json                    pulls in @netlify/blobs for the functions
netlify/functions/data.mjs      reads and writes one member's own record
netlify/functions/members.mjs   admin-only roster
workout-plan-template.csv       the plan template members download and fill in
google-apps-script.gs           optional — makes a Google Sheet the storage backend
```

---

## Deploy

**1. Put it in a Git repo.**

```bash
cd fitcircle
git init
git add .
git commit -m "FitCircle"
git remote add origin git@github.com:YOURNAME/fitcircle.git
git push -u origin main
```

Use Git rather than drag-and-drop. The functions need `@netlify/blobs` installed, and a
Git-connected deploy runs `npm install` for you.

**2. Connect it to Netlify.** New project → import from Git → pick the repo. Leave the build
command empty. Publish directory is `.`. Deploy.

**3. Turn on Identity.** In the Netlify dashboard: **Project configuration → Identity →
Enable Identity**.

**4. Close the door.** Still under Identity: **Registration → Invite only**. This is the step
that makes it a private group. Skip it and anyone who finds the URL can create an account.

**5. Invite your people.** Identity → **Invite users** → enter their email addresses. They
get an email with a link to set a password. They do not need Netlify accounts.

**6. Make yourself admin.** Identity → click your own user → **Edit role** (or edit the user
metadata) → add the role `admin`. Roles are stored as a list, so the field should read:

```
admin
```

Sign out and back in for the new role to appear in your token. The Members tab shows up once
it does.

---

## How the pieces fit

**Auth.** The browser gets a signed JWT from Identity. Every call to `/api/data` sends it as
a bearer token. The function verifies it against your own Identity service before touching
anything, so a member can only ever read and write their own record. The member id comes from
the verified token, never from the request body — there is no way for one member to ask for
another member's data by changing a parameter.

**Storage.** One JSON blob per member in a Blobs store called `members`, keyed by their
Identity user id. Profile, daily entries, and session progress all live in that one object.

**Offline.** Every change is written to the device's local storage first, then synced to the
server on a short delay. If the wifi drops mid-workout, tapped sets are not lost — they sync
when the connection returns. If the server read fails at startup, the app falls back to the
local copy.

**The plan generator.** Nothing is hardcoded. `LIB` in `index.html` is an exercise library
tagged by movement pattern and required equipment. `TEMPLATES` describes each session type as
a list of movement patterns. When a member opens the app, their week is built by picking the
best available exercise for each pattern given their kit, and mapping session types onto the
weekdays they chose. Three training days gets a full-body rotation, six gets a push/pull/legs
split. Days they did not pick become recovery sessions.

---

## Storing it in a Google Sheet

By default everything lives in Netlify Blobs, which works but is invisible to you. Point it at
a Google Sheet instead and you can read, chart and pivot the whole group's data yourself.

**1. Make the sheet.** New Google Sheet, name it whatever you like.

**2. Add the script.** Extensions → Apps Script → delete the placeholder → paste
`google-apps-script.gs` → change `SECRET` at the top to a long random string → Save.

**3. Create the tabs.** In the Apps Script editor, pick the `setup` function from the dropdown
and press Run. Approve the permission prompt. Three tabs appear: `members`, `entries`, `plans`.

**4. Deploy it.** Deploy → New deployment → Web app.

| Setting | Value |
|---|---|
| Execute as | Me |
| Who has access | **Anyone** |

"Anyone" sounds alarming, but the URL never reaches the browser — only your Netlify function
calls it, and every call carries the secret. Pick "Anyone with a Google account" instead and
the function gets a login page rather than your data. Copy the `/exec` URL it hands you.

**5. Tell Netlify.** Project configuration → Environment variables:

```
SHEETS_URL      https://script.google.com/macros/s/AKfyc.../exec
SHEETS_SECRET   the same string you put in the script
```

Redeploy. That's the whole switch. With both variables set everything goes to the sheet; remove
them and it falls straight back to Blobs. `/api/data` keeps the same shape either way, so
nothing in the browser knows the difference.

### What lands in each tab

**members** — one row per person: name, sex, age, height, start and goal weight, daily target,
maintenance, equipment, training days, and whether they're on the generated plan or one they
uploaded.

**entries** — one row per person per day: date, weight, calories burned, calories eaten, note.
This is the tab worth charting.

**plans** — one row per exercise for anyone who uploaded their own CSV, in the same shape as
the template.

### Worth knowing

Apps Script is slower than Blobs — expect a few hundred milliseconds per save rather than tens.
That's why saves batch on a 1.5 second delay and mirror to the device first. A member ticking
off sets mid-workout never waits on Google.

Consumer Google accounts have a daily quota on script calls. A group this size won't come near
it; a few hundred very active members would.

Edit a cell by hand and that member's app picks it up next time they open it. Edit it while
they have the app open and their next save overwrites you — during a session, the app is the
source of truth.

---

## Uploading your own plan

Members who already have a programme — from a coach, or one they've refined themselves —
don't have to use the generated week. On the Setup tab they download
`workout-plan-template.csv`, replace the example rows in Excel or Google Sheets, save as CSV,
and upload it.

One row per exercise. Columns:

| Column | Required | What it does |
|---|---|---|
| `day` | yes | `Mon`, `Monday` or `0`–`6`. Leave a day out and it becomes a recovery day. |
| `exercise` | yes | The exercise name. |
| `week` | no | For plans that alternate. `1` for odd weeks, `2` for even, and so on. Leave it blank for rows that run every week — warm-ups, cool-downs, walk days. Omit the column entirely and the plan simply repeats. |
| `session` | no | Name of that day's workout. Put it on the first row of the day. |
| `focus` | no | One line under the session name. |
| `intensity` | no | `light`, `moderate`, `hard`, `very hard`. Drives the calorie estimate. Defaults to moderate. |
| `minutes` | no | Session length. Worked out from the sets and rests if blank. |
| `phase` | no | Groups exercises under a heading — `Warm-up`, `Main`, `Core`, `Finisher`. |
| `sets` | no | Defaults to 1. |
| `reps` | no | Free text: `12`, `12-15`, `20 steps`, `12 per leg`. |
| `seconds` | no | Timed work. Fill this **or** `reps`, not both — the timer follows whichever is set. |
| `rest` | no | Seconds of rest between sets. Drives the rest countdown. |
| `load` | no | `5 kg pair`, `EZ bar`, `Bodyweight`. Display only. |
| `cue` | no | The form reminder shown under the exercise. |

Session-level fields only need to appear once per day; the first non-empty value wins. Rows
with an unrecognised day or no exercise name are skipped and reported back rather than
failing the whole upload. Quoted fields with commas inside are handled properly, so cues can
be written as normal sentences.

The uploaded plan is stored with that member's profile and takes priority over the generator.
Their equipment and training-day settings stay saved but stop driving anything until they tap
**Go back to the generated plan**.

---

## Changing the programme

Add an exercise by adding one object to `LIB`:

```js
{p:'pullH', n:'Chest-supported row', e:['dumbbells'], t:4,
 sets:4, work:null, rest:60, d:'4 × 12',
 c:'Chest on an incline bench so the lower back sits it out.'}
```

`p` is the movement pattern, `e` is the equipment required, `t` is how strongly to prefer it
when several options qualify. Use `work` for exercises timed in seconds and `d` plus `rest`
for rep-based ones. Nothing else needs to change — it becomes available to every member whose
equipment covers it.

---

## Cost

Free plan covers Identity, Blob storage, and the two functions. Credits are consumed by
compute and bandwidth; a group this size will not come close to the monthly allowance. Check
Netlify's current pricing page before you scale it past a few hundred people.
