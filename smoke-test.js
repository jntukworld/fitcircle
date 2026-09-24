/**
 * FitCircle smoke test — loads index.html in a real DOM, stubs Netlify Identity
 * and the API, then clicks through the app the way a member would.
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const APP = '/mnt/user-data/outputs/fitcircle/index.html';
const IMGMAP = JSON.parse(fs.readFileSync('/mnt/user-data/outputs/fitcircle/exercise-images.json', 'utf8'));

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
};

// what the fake server holds
let SERVER = { data: null };
const calls = [];

function makeFetch(win) {
  return async (url, opts = {}) => {
    calls.push((opts.method || 'GET') + ' ' + url);
    if (url === '/exercise-images.json') {
      return { ok: true, status: 200, json: async () => IMGMAP };
    }
    if (url === '/api/data') {
      const m = opts.method || 'GET';
      if (m === 'GET') return { ok: true, status: 200, json: async () => ({ data: SERVER.data, email: 'a@b.com', isAdmin: true }) };
      if (m === 'PUT') { SERVER.data = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
      if (m === 'DELETE') { SERVER.data = null; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    }
    if (url === '/api/members') {
      return { ok: true, status: 200, json: async () => ({ count: 2, members: [
        { id: 'u1', name: 'A', email: 'a@b.com', startWeight: 75, goalWeight: 68, currentWeight: 74.5, daysLogged: 3, lastLog: '2026-09-23', bankedKcal: 900, updatedAt: '' },
        { id: 'u2', name: 'B', email: 'c@d.com', startWeight: 90, goalWeight: 80, currentWeight: null, daysLogged: 0, lastLog: null, bankedKcal: 0, updatedAt: '' },
      ] }) };
    }
    throw new Error('unexpected fetch ' + url);
  };
}

const identityHandlers = {};
let SIGNED_IN = true;
let opened = [];
let updateCalls = [];

function stubIdentity(win) {
  win.netlifyIdentity = {
    on: (ev, fn) => { identityHandlers[ev] = fn; },
    init: () => {},
    open: (which) => opened.push(which),
    close: () => {},
    logout: () => { win.__loggedOut = true; },
    currentUser: () => SIGNED_IN ? ({
      id: 'u1', email: 'a@b.com',
      app_metadata: { roles: ['admin'] },
      jwt: async () => 'tok',
      update: async (p) => { updateCalls.push(p); return true; },
    }) : null,
  };
}

const wait = (ms = 0) => new Promise(r => setTimeout(r, ms));
const $ = (win, sel) => win.document.querySelector(sel);
const $$ = (win, sel) => [...win.document.querySelectorAll(sel)];
const byAct = (win, act) => $(win, `[data-act="${act}"]`);
const click = (win, el) => el.dispatchEvent(new win.Event('click', { bubbles: true }));

async function boot(hash = '') {
  const dom = new JSDOM(fs.readFileSync(APP, 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://fitcircle.test/' + hash,
    pretendToBeVisual: true,
    beforeParse(win) {
      stubIdentity(win);
      win.fetch = makeFetch(win);
      win.AudioContext = function () {
        return { state: 'running', currentTime: 0, resume() {}, destination: {},
          createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: {}, type: '' }),
          createGain: () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }) };
      };
      Object.defineProperty(win.navigator, 'wakeLock', {
        value: { request: async () => ({ release: async () => {}, addEventListener() {} }) }, configurable: true });
    },
  });
  const win = dom.window;
  await wait(30);
  identityHandlers.init && identityHandlers.init();
  await wait(60);
  return win;
}

(async () => {
  console.log('=== 1. cold start, nobody signed in ===');
  {
    SERVER = { data: null }; SIGNED_IN = false;
    const win = await boot();
    ok('gate is visible', !$(win, '#gate').classList.contains('hidden'));
    ok('sign-in button present', !!$(win, '#signin'));
    ok('forgot-password button present', !!$(win, '#forgot'));
    click(win, $(win, '#forgot'));
    ok('forgot opens the identity widget', opened.includes('login'), JSON.stringify(opened));
    SIGNED_IN = true;
  }

  console.log('\n=== 2. recovery link from email ===');
  {
    opened = []; SIGNED_IN = false;
    const win = await boot('#recovery_token=abc123');
    ok('recovery link opens the reset form', opened.includes('login'), JSON.stringify(opened));
  }
  {
    opened = [];
    const win = await boot('#invite_token=xyz');
    ok('invite link opens the signup form', opened.includes('signup'), JSON.stringify(opened));
  }
  {
    opened = [];
    const win = await boot('#error=access_denied&error_description=expired');
    ok('expired link explains itself', /expired|already been used|already used/i.test($(win, '.gate-note').textContent));
    SIGNED_IN = true;
  }

  console.log('\n=== 3. new member onboarding ===');
  let win;
  {
    SERVER = { data: null };
    win = await boot();
    identityHandlers.login && identityHandlers.login();
    await wait(80);
    ok('onboarding form shown for a new member', /Set up your plan/.test($(win, '#root').textContent));
    ok('equipment choices offered', $$(win, '[data-act="equip"]').length >= 5);
    ok('training day choices offered', $$(win, '[data-act="trainday"]').length === 7);

    // fill it in the way a person would
    $(win, '#p-name').value = 'Test Member';
    $(win, '#p-age').value = '33';
    $(win, '#p-height').value = '173';
    $(win, '#p-start').value = '75';
    $(win, '#p-goal').value = '68';
    $(win, '#p-target').value = '600';
    ['dumbbells', 'barbell', 'treadmill'].forEach(k => click(win, $(win, `[data-act="equip"][data-k="${k}"]`)));
    [1, 2, 3, 4, 5, 6].forEach(i => {
      const b = $(win, `[data-act="trainday"][data-i="${i}"]`);
      if (!b.classList.contains('on')) click(win, b);
    });
    [0].forEach(i => { const b = $(win, `[data-act="trainday"][data-i="${i}"]`); if (b.classList.contains('on')) click(win, b); });

    click(win, byAct(win, 'save-profile'));
    await wait(50);
    ok('profile saved and workout shown', !!byAct(win, 'player-open'), $(win, '#root').textContent.slice(0, 80));
  }

  console.log('\n=== 4. validation refuses bad input ===');
  {
    click(win, byAct(win, 'tab') && $(win, '[data-act="tab"][data-t="profile"]'));
    await wait(20);
    const g = $(win, '#p-goal'); const before = g.value;
    g.value = '90';                                    // goal above start weight
    click(win, byAct(win, 'save-profile'));
    await wait(20);
    ok('rejects a goal above current weight', /below your current weight/i.test($(win, '.status').textContent));
    g.value = before;
  }

  console.log('\n=== 5. password change ===');
  {
    updateCalls = [];
    $(win, '#pw1').value = 'short'; $(win, '#pw2').value = 'short';
    click(win, byAct(win, 'change-password')); await wait(20);
    ok('rejects a short password', /8 characters/i.test($(win, '.status').textContent) && updateCalls.length === 0);

    $(win, '#pw1').value = 'longenough1'; $(win, '#pw2').value = 'different1';
    click(win, byAct(win, 'change-password')); await wait(20);
    ok('rejects a mismatch', /don't match/i.test($(win, '.status').textContent) && updateCalls.length === 0);

    $(win, '#pw1').value = 'longenough1'; $(win, '#pw2').value = 'longenough1';
    click(win, byAct(win, 'change-password')); await wait(60);
    ok('accepts a valid password', updateCalls.length === 1 && updateCalls[0].password === 'longenough1');
    ok('clears the fields afterwards', $(win, '#pw1').value === '');
  }

  console.log('\n=== 6. the workout list ===');
  {
    click(win, $(win, '[data-act="tab"][data-t="workout"]')); await wait(20);
    ok('seven weekday chips', $$(win, '[data-act="day"]').length === 7);
    ok('exercise photos rendered', $$(win, '.exshot').length > 0, $$(win, '.exshot').length);
    ok('set buttons rendered', $$(win, '[data-act="set"]').length > 0);
    const repSet = $$(win, '.ex').filter(a => !/\d+:\d\d/.test((a.querySelector('.setbtn')||{}).textContent||''))
                    .map(a => a.querySelector('[data-act="set"]')).filter(Boolean)[0];
    click(win, repSet); await wait(30);
    ok('ticking a rep set marks it done', $(win, '.setbtn.done') !== null);
    const timedSet = $$(win, '.setbtn').filter(b => /\d+:\d\d/.test(b.textContent))[0];
    if (timedSet) { click(win, timedSet); await wait(30);
      ok('ticking a timed set starts its countdown', !!$(win, '.timerbar')); }
  }

  console.log('\n=== 7. the session player ===');
  {
    click(win, byAct(win, 'player-open')); await wait(30);
    ok('player opens full screen', !!$(win, '#player'));
    ok('player shows a primary action', !!$(win, '.pgo'));
    ok('player shows set markers', $$(win, '.pdot').length > 0);
    ok('player shows progress count', !!$(win, '.pcount'));

    const name1 = $(win, '.pname').textContent;
    click(win, byAct(win, 'player-next')); await wait(20);
    ok('next moves to another exercise', $(win, '.pname').textContent !== name1);
    click(win, byAct(win, 'player-prev')); await wait(20);
    ok('prev comes back', $(win, '.pname').textContent === name1);

    // complete every set of the current exercise through the primary button
    let guard = 0;
    while (guard++ < 40) {
      const go = $(win, '.pgo');
      if (!go || /Next exercise|Finish session|Skip/.test(go.textContent)) break;
      click(win, go); await wait(15);
    }
    ok('primary button advances the exercise', /Next exercise|Finish session|Skip/.test($(win, '.pgo').textContent),
       $(win, '.pgo').textContent);

    click(win, byAct(win, 'player-close')); await wait(20);
    ok('player closes back to the list', !$(win, '#player') && !!byAct(win, 'player-open'));
  }

  console.log('\n=== 8. the ledger ===');
  {
    click(win, $(win, '[data-act="tab"][data-t="ledger"]')); await wait(20);
    ok('ledger renders the gauge', !!$(win, '.tank'));
    $(win, '#f-weight').value = '74.6';
    $(win, '#f-burn').value = '420';
    click(win, byAct(win, 'save-day')); await wait(30);
    ok('a day can be logged', /420/.test($(win, '.todaystat').textContent), $(win, '.todaystat').textContent);
    click(win, $(win, '[data-act="panel"][data-p="history"]')); await wait(20);
    ok('history lists the entry', $$(win, 'tbody tr').length === 1);
  }

  console.log('\n=== 9. admin roster ===');
  {
    click(win, $(win, '[data-act="tab"][data-t="members"]')); await wait(80);
    ok('members tab loads', /Members/.test($(win, '#root').textContent));
    ok('member count shown', /2/.test($(win, '.todaystat').textContent));
  }

  console.log('\n=== 10. persistence ===');
  {
    await wait(1800);   // queueSave debounces at 1500ms
    ok('data was saved to the server', SERVER.data !== null);
    ok('profile persisted', SERVER.data && SERVER.data.profile && SERVER.data.profile.startWeight === 75);
    ok('entry persisted', SERVER.data && Object.keys(SERVER.data.entries).length === 1);
    ok('session ticks persisted', SERVER.data && Object.keys(SERVER.data.sessions).length >= 1);

    const win2 = await boot();
    identityHandlers.login && identityHandlers.login();
    await wait(90);
    ok('reload restores the member', !/Set up your plan/.test($(win2, '#root').textContent));
  }

  console.log('\n=== 11. delete my data ===');
  {
    click(win, $(win, '[data-act="tab"][data-t="profile"]')); await wait(20);
    ok('delete is offered', !!byAct(win, 'ask-delete'));
    ok('no one-click destruction', !byAct(win, 'delete-data'));
    click(win, byAct(win, 'ask-delete')); await wait(20);
    ok('asks for confirmation first', !!byAct(win, 'delete-data') && !!byAct(win, 'cancel-delete'));
    click(win, byAct(win, 'cancel-delete')); await wait(20);
    await wait(0);
    ok('cancel backs out safely', !byAct(win, 'delete-data') && SERVER.data !== null);
    click(win, byAct(win, 'ask-delete')); await wait(20);
    click(win, byAct(win, 'delete-data')); await wait(80);
    ok('confirmed delete clears the server', SERVER.data === null);
    ok('returns to onboarding', /Set up your plan/.test($(win, '#root').textContent));
  }

  console.log('\n=== 12. storage outage does not look like an empty account ===');
  {
    const dom = new JSDOM(fs.readFileSync(APP, 'utf8'), {
      runScripts: 'dangerously', url: 'https://fitcircle.test/', pretendToBeVisual: true,
      beforeParse(w) {
        stubIdentity(w);
        w.fetch = async (u) => u === '/exercise-images.json'
          ? { ok: true, json: async () => IMGMAP }
          : { ok: false, status: 502, json: async () => ({ error: 'Storage unreachable' }) };
        w.AudioContext = function () { return { state: 'running', resume() {} }; };
      },
    });
    const w = dom.window;
    await wait(30);
    w.localStorage.setItem('fitcircle:u1', JSON.stringify({
      profile: { name: 'Cached', startWeight: 80, goalWeight: 72, dailyTarget: 500, mode: 'simple',
                 maintenance: 2400, equipment: [], trainingDays: [1, 3, 5], age: 40, height: 175, sex: 'male' },
      entries: {}, sessions: {} }));
    identityHandlers.init && identityHandlers.init();
    await wait(120);
    const txt = $(w, '#root').textContent;
    ok('falls back to the cached copy instead of onboarding', !/Set up your plan/.test(txt), txt.slice(0, 70));
  }


  console.log('\n=== 13. load logging ===');
  {
    SERVER = { data: null }; SIGNED_IN = true;
    const w2 = await boot();
    identityHandlers.login && identityHandlers.login();
    await wait(80);
    // onboard quickly
    w2.document.querySelector('#p-name').value = 'Logger';
    w2.document.querySelector('#p-start').value = '80';
    w2.document.querySelector('#p-goal').value = '72';
    ['dumbbells','barbell'].forEach(k=>click(w2, $(w2,`[data-act="equip"][data-k="${k}"]`)));
    [1,2,3,4,5].forEach(i=>{const b=$(w2,`[data-act="trainday"][data-i="${i}"]`); if(!b.classList.contains('on')) click(w2,b);});
    click(w2, byAct(w2,'save-profile')); await wait(40);

    click(w2, byAct(w2,'player-open')); await wait(40);
    // walk to a rep-based exercise, which is where the logger lives
    let guard=0;
    while(guard++<20 && !$(w2,'.plog')){ const n=byAct(w2,'player-next'); if(!n||n.disabled) break; click(w2,n); await wait(20); }
    ok('load logger shown for rep exercises', !!$(w2,'.plog'));
    ok('kg and reps fields present', $$(w2,'.plogin').length === 2);
    ok('first time says so', /First time logging this/.test($(w2,'.plast').textContent));

    const kg = $$(w2,'.plogin').find(i=>i.dataset.log==='w');
    const rp = $$(w2,'.plogin').find(i=>i.dataset.log==='r');
    const exName = kg.dataset.name;
    kg.value='11'; kg.dispatchEvent(new w2.Event('change',{bubbles:true}));
    rp.value='12'; rp.dispatchEvent(new w2.Event('change',{bubbles:true}));
    await wait(1800);
    const log = SERVER.data && SERVER.data.sessions[Object.keys(SERVER.data.sessions)[0]].log;
    ok('weight and reps reach the server', !!(log && log[exName] && log[exName][0] &&
       log[exName][0].w===11 && log[exName][0].r===12), JSON.stringify(log||{}).slice(0,120));

    // plant a prior session and confirm the comparison appears
    const today = new Date();
    const past = new Date(today); past.setDate(past.getDate()-7);
    const pIso = past.getFullYear()+'-'+String(past.getMonth()+1).padStart(2,'0')+'-'+String(past.getDate()).padStart(2,'0');
    SERVER.data.sessions[pIso] = { done:{'0-0':true,'0-1':true,'0-2':true},
      log:{ [exName]: [{w:9,r:10},{w:9,r:10}] } };

    const w3 = await boot();
    identityHandlers.login && identityHandlers.login();
    await wait(90);
    click(w3, byAct(w3,'player-open')); await wait(40);
    let g2=0;
    while(g2++<20 && !(($(w3,'.plast')||{}).textContent||'').includes('Last time')){
      const n=byAct(w3,'player-next'); if(!n||n.disabled) break; click(w3,n); await wait(20); }
    ok('shows what to beat from last time', /Last time/.test(($(w3,'.plast')||{}).textContent||''),
       ($(w3,'.plast')||{}).textContent);
    ok('names the best set', /9 kg × 10/.test(($(w3,'.plast')||{}).textContent||''));
    click(w3, byAct(w3,'player-close')); await wait(20);

    console.log('\n=== 14. adherence and waist ===');
    click(w3, $(w3,'[data-act="tab"][data-t="ledger"]')); await wait(30);
    ok('adherence shown on the ledger', /Sessions trained/.test($(w3,'.facts').textContent));
    ok('adherence sentence explains control', /entirely yours to control/.test($(w3,'#root').textContent));
    ok('waist field offered', !!$(w3,'#f-waist'));
    $(w3,'#f-weight').value='79.4'; $(w3,'#f-waist').value='92.5';
    click(w3, byAct(w3,'save-day')); await wait(1800);
    const todayIso = Object.keys(SERVER.data.entries).sort().pop();
    ok('waist persists', SERVER.data.entries[todayIso].waist === 92.5);
    ok('waist shown in the facts', /Waist/.test($(w3,'.facts').textContent));

    console.log('\n=== 15. deload and theme ===');
    click(w3, $(w3,'[data-act="tab"][data-t="profile"]')); await wait(30);
    ok('deload toggle present', !!byAct(w3,'toggle-deload'));
    ok('deload on by default', /Deload weeks on/.test(byAct(w3,'toggle-deload').textContent));
    click(w3, byAct(w3,'toggle-deload')); await wait(30);
    ok('deload can be turned off', /Deload weeks off/.test(byAct(w3,'toggle-deload').textContent));
    click(w3, byAct(w3,'toggle-deload')); await wait(30);

    ok('theme choices offered', $$(w3,'[data-act="theme"]').length === 3);
    click(w3, $(w3,'[data-act="theme"][data-k="light"]')); await wait(30);
    ok('light theme applied', w3.document.documentElement.getAttribute('data-theme')==='light');
    click(w3, $(w3,'[data-act="theme"][data-k="auto"]')); await wait(30);
    ok('auto theme clears the override', !w3.document.documentElement.getAttribute('data-theme'));

    console.log('\n=== 16. nobody else sees your body ===');
    click(w3, $(w3,'[data-act="tab"][data-t="members"]')); await wait(90);
    const head = [...w3.document.querySelectorAll('th')].map(t=>t.textContent).join(' ');
    ok('roster has no weight column', !/weight|goal|waist/i.test(head), head);
    ok('roster shows attendance instead', /Sessions trained/.test(head));
    ok('privacy stated in the UI', /never leave the member/.test($(w3,'#root').textContent));

    console.log('\n=== 17. accessibility ===');
    ok('live region present', !!$(w3,'#announce[aria-live="polite"]'));
    click(w3, $(w3,'[data-act="tab"][data-t="profile"]')); await wait(30);
    ok('toggles expose pressed state', $$(w3,'[data-act="trainday"][aria-pressed]').length === 7);
    ok('table headers scoped', [...w3.document.querySelectorAll('th')].every(t=>t.getAttribute('scope')==='col'));
  }

  console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e.message); process.exit(2); });
