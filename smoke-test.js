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

const isoNow = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
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
    // today must be the earliest selected day so it lands on the rep-based push session
    const td = new Date().getDay();
    const days = [td, td+1, td+2, td+3].filter(x=>x<=6);
    $$(w2,'[data-act="trainday"]').forEach(b=>{ const on=b.classList.contains('on'), want=days.includes(+b.dataset.i);
      if(on!==want) click(w2,b); });
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

    ok('durations are not rewritten as set counts',
       !/\b1 minutes\b/.test(w3.document.body.textContent));

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


  console.log('\n=== 18. navigation ===');
  {
    SERVER = { data: null }; SIGNED_IN = true;
    const w4 = await boot();
    identityHandlers.login && identityHandlers.login(); await wait(80);
    ok('nav hidden during onboarding', $(w4,'#bottomnav').classList.contains('hidden'));
    $(w4,'#p-start').value='80'; $(w4,'#p-goal').value='72';
    const td=new Date().getDay(); const days=[td,td+1,td+2].filter(x=>x<=6);
    $$(w4,'[data-act="trainday"]').forEach(b=>{ if(b.classList.contains('on')!==days.includes(+b.dataset.i)) click(w4,b); });
    click(w4, byAct(w4,'save-profile')); await wait(40);

    const nav=$(w4,'#bottomnav');
    ok('bottom nav present once set up', !nav.classList.contains('hidden'));
    ok('bottom nav has every tab', $$(w4,'#bottomnav button').length>=3);
    ok('current tab marked for assistive tech', $(w4,'#bottomnav button[aria-current="page"]').dataset.t==='workout');
    click(w4, $(w4,'#bottomnav [data-t="ledger"]')); await wait(30);
    ok('bottom nav switches view', !!$(w4,'.tank'));
    ok('bottom nav updates its own state', $(w4,'#bottomnav button[aria-current="page"]').dataset.t==='ledger');
    click(w4, $(w4,'#bottomnav [data-t="workout"]')); await wait(30);

    ok('no back-to-today when already on today', !byAct(w4,'go-today'));
    const other=(td+1)%7;
    click(w4, $(w4,`[data-act="day"][data-i="${other}"]`)); await wait(30);
    ok('previewing another day offers a way back', !!byAct(w4,'go-today'));
    click(w4, byAct(w4,'go-today')); await wait(30);
    ok('back to today works', !byAct(w4,'go-today') && !!byAct(w4,'player-open'));

    console.log('\n=== 19. undo and reset ===');
    ok('no reset offered before anything is done', !byAct(w4,'ask-reset'));
    const repSet=()=>$$(w4,'.ex').filter(a=>!/\d+:\d\d/.test((a.querySelector('.setbtn')||{}).textContent||''))
                 .map(a=>a.querySelector('[data-act="set"]')).filter(Boolean)[0];
    click(w4, repSet()); await wait(30);
    ok('ticked set can be un-ticked by tapping again', (()=>{ const d=$(w4,'.setbtn.done'); click(w4,d); return true; })());
    ok('un-tick actually clears it', !$(w4,'.setbtn.done'));
    click(w4, repSet()); await wait(30);
    ok('per-exercise reset appears once a set is ticked', !!byAct(w4,'reset-ex'));
    ok('hint explains un-ticking', /Tap a ticked set to un-tick/.test($(w4,'#root').textContent));
    click(w4, byAct(w4,'reset-ex')); await wait(30);
    ok('per-exercise reset clears its sets', !$(w4,'.setbtn.done'));

    click(w4, repSet()); await wait(30);
    ok('reset-today offered once there is progress', !!byAct(w4,'ask-reset'));
    ok('reset-today is not one click', !byAct(w4,'reset-today'));
    click(w4, byAct(w4,'ask-reset')); await wait(20);
    ok('asks before clearing the day', !!byAct(w4,'reset-today') && !!byAct(w4,'cancel-reset'));
    click(w4, byAct(w4,'cancel-reset')); await wait(20);
    ok('cancel keeps the progress', !!$(w4,'.setbtn.done'));
    click(w4, byAct(w4,'ask-reset')); await wait(20);
    click(w4, byAct(w4,'reset-today')); await wait(30);
    ok('confirmed reset clears everything', !$(w4,'.setbtn.done') && !byAct(w4,'ask-reset'));

    // logger clear inside the player
    click(w4, byAct(w4,'player-open')); await wait(40);
    let g=0; while(g++<12 && !$(w4,'.plog')){ const n=byAct(w4,'player-next'); if(!n||n.disabled) break; click(w4,n); await wait(20); }
    if($(w4,'.plog')){
      ok('no clear button on an empty logger', !byAct(w4,'clear-log'));
      const kg=$$(w4,'.plogin').find(i=>i.dataset.log==='w');
      kg.value='12'; kg.dispatchEvent(new w4.Event('change',{bubbles:true})); await wait(30);
      // re-render to reflect the value
      click(w4, byAct(w4,'player-next')); await wait(20); click(w4, byAct(w4,'player-prev')); await wait(20);
      ok('clear appears once something is typed', !!byAct(w4,'clear-log'));
      click(w4, byAct(w4,'clear-log')); await wait(30);
      ok('clear empties the logged set', $$(w4,'.plogin').every(i=>i.value===''));
    }
    // Escape closes the player
    w4.document.dispatchEvent(new w4.KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait(30);
    ok('Escape closes the player', !$(w4,'#player'));

    console.log('\n=== 20. the ledger edits the day you picked ===');
    click(w4, $(w4,'#bottomnav [data-t="ledger"]')); await wait(30);
    $(w4,'#f-weight').value='80.2'; click(w4, byAct(w4,'save-day')); await wait(30);
    const y=new Date(); y.setDate(y.getDate()-1);
    const yIso=y.getFullYear()+'-'+String(y.getMonth()+1).padStart(2,'0')+'-'+String(y.getDate()).padStart(2,'0');
    const dt=$(w4,'#f-date'); dt.value=yIso; dt.dispatchEvent(new w4.Event('change',{bubbles:true})); await wait(30);
    ok('switching date says which day is being edited', /Editing/.test($(w4,'.blockhead h2').textContent));
    ok('yesterday starts blank, not with today\'s numbers', $(w4,'#f-weight').value==='');
    ok('offers a way back to today', !!byAct(w4,'ledger-today'));
    $(w4,'#f-weight').value='80.9'; click(w4, byAct(w4,'save-day')); await wait(30);
    click(w4, byAct(w4,'ledger-today')); await wait(30);
    ok('today still holds its own value', $(w4,'#f-weight').value==='80.2');
    ok('save on an existing day reads Update', /Update this day/.test(byAct(w4,'save-day').textContent));
    $(w4,'#f-waist').value='90';
    click(w4, byAct(w4,'clear-form')); await wait(20);
    ok('clear empties the form fields', $(w4,'#f-weight').value==='' && $(w4,'#f-waist').value==='');
    $(w4,'#f-weight').value='79.9';
    $(w4,'#f-weight').dispatchEvent(new w4.KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await wait(30);
    ok('Enter saves the ledger form', /Update this day/.test(byAct(w4,'save-day').textContent));
  }


  console.log('\n=== 21. entered data survives a plan change ===');
  {
    await wait(1800);          // let the previous window's debounced save land first
    SERVER = { data: null }; SIGNED_IN = true;
    const w5 = await boot();
    identityHandlers.login && identityHandlers.login(); await wait(80);
    $(w5,'#p-start').value='80'; $(w5,'#p-goal').value='72';
    ['dumbbells','barbell'].forEach(k=>click(w5, $(w5,`[data-act="equip"][data-k="${k}"]`)));
    const td=new Date().getDay(); const days=[td,td+1,td+2].filter(x=>x<=6);
    $$(w5,'[data-act="trainday"]').forEach(b=>{ if(b.classList.contains('on')!==days.includes(+b.dataset.i)) click(w5,b); });
    click(w5, byAct(w5,'save-profile')); await wait(40);

    // tick the first set of the first two REP-based exercises (timed ones start a countdown instead)
    const repRows=()=>$$(w5,'.ex').filter(a=>!/\d+:\d\d/.test((a.querySelector('.setbtn')||{}).textContent||''));
    const names=repRows().slice(0,2).map(a=>a.querySelector('h4').textContent);
    click(w5, repRows()[0].querySelector('[data-act="set"]')); await wait(30);
    click(w5, repRows()[1].querySelector('[data-act="set"]')); await wait(30);
    const tickedNow=$$(w5,'.setbtn.done').length;
    ok('two sets ticked before the change', tickedNow===2, tickedNow);

    // build a CSV for today that REORDERS: second exercise first, first exercise last, plus one new
    const dayName=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][td];
    const csv=`day,session,exercise,sets,reps,rest\n`+
      `${dayName},Reordered,${names[1]},3,10,60\n`+
      `${dayName},,Totally New Exercise,3,10,60\n`+
      `${dayName},,${names[0]},3,10,60\n`;
    click(w5, $(w5,'[data-act="tab"][data-t="profile"]')); await wait(30);
    const input=$(w5,'#csv-input');
    const file=new w5.File([csv],'reorder.csv',{type:'text/csv'});
    Object.defineProperty(input,'files',{value:[file],configurable:true});
    input.dispatchEvent(new w5.Event('change',{bubbles:true}));
    await wait(120);
    ok('upload accepted', /Loaded 3 exercises/.test($(w5,'#root').textContent), ($(w5,'#root').textContent.match(/Loaded[^.]*\./)||[''])[0]);
    const onDays=$$(w5,'[data-act="trainday"].on').map(b=>+b.dataset.i);
    ok('training-day toggles now match the uploaded plan', onDays.length===1 && onDays[0]===td, JSON.stringify(onDays));

    click(w5, $(w5,'[data-act="tab"][data-t="workout"]')); await wait(30);
    const rows=$$(w5,'.ex').map(a=>({name:a.querySelector('h4').textContent, done:!!a.querySelector('.setbtn.done')}));
    // wait for the debounced save so the server copy is current before the next boot
    await wait(1800);
    ok('plan is the reordered one', rows.map(r=>r.name)[0]===names[1] && rows.map(r=>r.name)[2]===names[0], JSON.stringify(rows));
    ok('tick followed the exercise that moved to the end', rows[2].done);
    ok('tick followed the exercise that moved to the front', rows[0].done);
    ok('the brand-new exercise did not inherit a phantom tick', !rows[1].done);

    // profile change (equipment) with the generated plan — same guarantee
    click(w5, $(w5,'[data-act="tab"][data-t="profile"]')); await wait(30);
    click(w5, byAct(w5,'clear-plan')); await wait(30);
    click(w5, $(w5,'[data-act="tab"][data-t="workout"]')); await wait(30);
    const before=$$(w5,'.ex').filter(a=>a.querySelector('.setbtn.done')).map(a=>a.querySelector('h4').textContent);
    ok('back on the generated plan, same exercises are still ticked', before.length===2 && before.includes(names[0]) && before.includes(names[1]), JSON.stringify(before));

    console.log('\n=== 22. old position-keyed ticks are migrated ===');
    await wait(1800);
    // plant a legacy position-keyed record on the server for TODAY:
    // exercise 1 set 0, and exercise 2 set 1 (both rep-based on a push day)
    const nowD=new Date();
    const tIso=nowD.getFullYear()+'-'+String(nowD.getMonth()+1).padStart(2,'0')+'-'+String(nowD.getDate()).padStart(2,'0');
    SERVER.data.sessions={ [tIso]: {done:{'1-0':true,'2-1':true}} };
    const w6=await boot();
    identityHandlers.login && identityHandlers.login(); await wait(120);
    const ex1=$$(w6,'.ex')[1], ex2=$$(w6,'.ex')[2];
    ok('legacy tick on exercise 1 set 0 shows', ex1.querySelectorAll('.setbtn')[0].classList.contains('done'));
    ok('legacy tick on exercise 2 set 1 shows', ex2.querySelectorAll('.setbtn')[1].classList.contains('done'));
    ok('legacy tick on exercise 2 set 0 is NOT invented', !ex2.querySelectorAll('.setbtn')[0].classList.contains('done'));
    await wait(1800);
    const keys=Object.keys((SERVER.data.sessions[tIso]||{}).done||{});
    ok('migrated keys are name-based and saved back', keys.length===2 && keys.every(k=>k.includes('::')), JSON.stringify(keys));
  }


  console.log('\n=== 23. the motivational layer ===');
  {
    await wait(1800);
    SERVER = { data: null }; SIGNED_IN = true;
    const w7 = await boot();
    identityHandlers.login && identityHandlers.login(); await wait(80);
    $(w7,'#p-name').value='Pruthvi Raj'; $(w7,'#p-start').value='80'; $(w7,'#p-goal').value='72';
    ['dumbbells','barbell'].forEach(k=>click(w7, $(w7,`[data-act="equip"][data-k="${k}"]`)));
    const td=new Date().getDay(); const days=[td,td+1,td+2].filter(x=>x<=6);
    $$(w7,'[data-act="trainday"]').forEach(b=>{ if(b.classList.contains('on')!==days.includes(+b.dataset.i)) click(w7,b); });
    click(w7, byAct(w7,'save-profile')); await wait(40);

    ok('hero greets by first name', /Good (morning|afternoon|evening)|Late night/.test($(w7,'.hero2greet').textContent) && /Pruthvi\./.test($(w7,'.hero2greet').textContent), $(w7,'.hero2greet').textContent);
    ok('hero has a line for a first session', /First one/.test($(w7,'.hero2line').textContent), $(w7,'.hero2line').textContent);
    ok('streak starts at zero and unlit', $(w7,'.streak b').textContent==='0' && !$(w7,'.streak').classList.contains('lit'));
    ok('week strip has seven days', $$(w7,'.strip i').length===7);
    ok('day chips carry status dots', $$(w7,'.cdot').length>=1);

    // tick three rep sets so today counts as trained, then finish
    const repRows=()=>$$(w7,'.ex').filter(a=>!/\d+:\d\d/.test((a.querySelector('.setbtn')||{}).textContent||''));
    for(let k=0;k<3;k++){ click(w7, repRows()[0].querySelectorAll('[data-act="set"]')[k]); await wait(25); }
    ok('hero line changes once work has started', /sets left/.test($(w7,'.hero2line').textContent), $(w7,'.hero2line').textContent);
    ok('streak lights up today', $(w7,'.streak b').textContent==='1' && $(w7,'.streak').classList.contains('lit'));

    click(w7, byAct(w7,'finish')); await wait(60);
    ok('completion screen appears', !!$(w7,'#doneshell'));
    ok('it states the outcome honestly for a partial session', /Logged\.|Good enough|Session done/.test($(w7,'.done h2').textContent), $(w7,'.done h2').textContent);
    ok('it shows sets, time, burned and streak', $$(w7,'.donefacts dt').map(d=>d.textContent).join(',')==='Sets,Time,Burned,Streak');
    ok('first-session milestone fires', /First session in the book/.test($(w7,'#doneshell').textContent));
    ok('it names tomorrow', /Tomorrow:/.test($(w7,'#doneshell').textContent));
    click(w7, byAct(w7,'done-close')); await wait(30);
    ok('completion screen closes', !$(w7,'#doneshell'));
    ok('burn was logged to the ledger', (()=>{ click(w7,$(w7,'[data-act="tab"][data-t="ledger"]')); return /kcal/.test($(w7,'.todaystat').textContent); })());

    ok('week-over-week block present', !!$(w7,'.wow'));
    ok('week-over-week shows sessions 1 vs 0', /1 vs 0/.test($(w7,'.wowgrid').textContent), $(w7,'.wowgrid').textContent.slice(0,60));

    console.log('\n=== 24. streak maths ===');
    await wait(1800);
    // Plant history: trained on the last 3 planned days before today, missed the one before that.
    const plan={}; for(const d of days) plan[d]=true;
    const hist={}; let planted=0, n=1, guard=0;
    while(planted<3 && guard++<30){ const dd=new Date(); dd.setDate(dd.getDate()-n);
      if(plan[dd.getDay()]){ hist[dd.getFullYear()+'-'+String(dd.getMonth()+1).padStart(2,'0')+'-'+String(dd.getDate()).padStart(2,'0')]={done:{'a::0':true,'a::1':true,'a::2':true}}; planted++; }
      n++; }
    // one more planned day further back, NOT trained (breaks the streak there)
    while(guard++<60){ const dd=new Date(); dd.setDate(dd.getDate()-n); if(plan[dd.getDay()]) break; n++; }
    const todayRec=SERVER.data.sessions[Object.keys(SERVER.data.sessions).find(k=>k===isoNow())]||{done:{}};
    SERVER.data.sessions={...hist, [isoNow()]: todayRec};
    const w8=await boot();
    identityHandlers.login && identityHandlers.login(); await wait(120);
    const shown=+$(w8,'.streak b').textContent;
    ok('streak counts the three planted days plus today', shown===4, shown);
    ok('hero acknowledges the streak', /in a row/.test($(w8,'.hero2line').textContent) || /Done for today|sets left/.test($(w8,'.hero2line').textContent), $(w8,'.hero2line').textContent);
    const dots=$$(w8,'.strip i').map(i=>i.className);
    ok('week strip marks trained days', dots.filter(c=>c==='trained').length>=2, JSON.stringify(dots));

    console.log('\n=== 25. a personal record is recognised ===');
    await wait(1800);
    // yesterday-ish: one prior log for an exercise name we will find in today's player
    const w9=await boot(); identityHandlers.login && identityHandlers.login(); await wait(120);
    click(w9, byAct(w9,'player-open')); await wait(40);
    let g=0; while(g++<12 && !$(w9,'.plog')){ const nx=byAct(w9,'player-next'); if(!nx||nx.disabled) break; click(w9,nx); await wait(20); }
    const exName=$$(w9,'.plogin')[0].dataset.name;
    click(w9, byAct(w9,'player-close')); await wait(20);
    await wait(1800);
    const priorIso=Object.keys(hist)[0];
    SERVER.data.sessions[priorIso].log={ [exName]: [{w:10,r:10}] };
    const w10=await boot(); identityHandlers.login && identityHandlers.login(); await wait(120);
    click(w10, byAct(w10,'player-open')); await wait(40);
    g=0; while(g++<12 && !($(w10,'.plogin')&&$(w10,'.plogin').dataset.name===exName)){ const nx=byAct(w10,'player-next'); if(!nx||nx.disabled) break; click(w10,nx); await wait(20); }
    ok('no record flag before logging', !$(w10,'.prflag'));
    const kg=$$(w10,'.plogin').find(i=>i.dataset.log==='w'), rp=$$(w10,'.plogin').find(i=>i.dataset.log==='r');
    kg.value='12'; kg.dispatchEvent(new w10.Event('change',{bubbles:true}));
    rp.value='10'; rp.dispatchEvent(new w10.Event('change',{bubbles:true}));
    click(w10, byAct(w10,'player-next')); await wait(20); click(w10, byAct(w10,'player-prev')); await wait(20);
    ok('heavier set is flagged as a new best', /New best/.test(($(w10,'.prflag')||{}).textContent||''), ($(w10,'.plog')||{}).textContent);
    ok('it says why', /heavier/.test(($(w10,'.prflag')||{}).textContent||''));
    click(w10, byAct(w10,'player-close')); await wait(30);
    click(w10, byAct(w10,'finish')); await wait(60);
    ok('record appears on the completion screen', /New personal records/.test($(w10,'#doneshell').textContent) && new RegExp(exName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).test($(w10,'#doneshell').textContent));
  }

  console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e.message); process.exit(2); });
