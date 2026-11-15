/* STRADA v2 — patente B in English. Single-file front end. */
(() => {
  const app = document.getElementById('app');
  const tabs = document.getElementById('tabs');
  const state = {
    user: localStorage.getItem('strada_user') || '',
    highlights: localStorage.getItem('strada_hl') !== '0',
    unlockAll: localStorage.getItem('strada_unlock') === '1',
    subCache: {},
    health: null,
    lean: null,                                                 // words to colour in a statement, from /api/lean
    topicAudio: null,                                           // the one <audio> of the topic lesson screen, while it is open
  };

  // ---------- utils ----------
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // a picture that fails to load (a dropped connection, a busy server) gets one more try a moment later
  document.addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.retried) return;
    img.dataset.retried = '1';
    setTimeout(() => { img.src = img.src + (img.src.includes('?') ? '&' : '?') + 'retry=1'; }, 1500);
  }, true);
  const gap = px => `<div style="height:${px}px"></div>`;

  async function api(path, body) {
    const opts = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: state.user, ...body }) } : {};
    const url = body ? path : path + (path.includes('?') ? '&' : '?') + 'user=' + encodeURIComponent(state.user);
    const r = await fetch(url, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    return r.json();
  }
  const post = (path, body) => api(path, body).catch(e => console.warn(path, e.message));

  let itVoice = null;
  function pickVoice() {
    const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    itVoice = vs.find(v => /^it[-_]IT/i.test(v.lang) && /enhanced|premium|natural/i.test(v.name)) || vs.find(v => /^it/i.test(v.lang)) || null;
  }
  if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function speakIt(text, rate = 0.92) {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'it-IT'; u.rate = rate; if (itVoice) u.voice = itVoice;
    speechSynthesis.speak(u);
  }

  // ---- leaning words: red leans Falso, green leans Vero (measured on the bank; see /api/lean) ----
  const leanCache = new Map();
  function leanRules(tid) {
    if (!state.lean || tid === false) return null;                // false: this text is shown without colours
    if (!leanCache.has(tid)) {
      const seen = new Set(), rules = [];
      for (const r of [...(state.lean.topics[tid] || []), ...state.lean.global]) { if (!seen.has(r.src)) { seen.add(r.src); rules.push({ ...r, re: new RegExp(`^(?:${r.src})$`, 'iu') }); } }
      const alts = rules.map(r => r.src).sort((x, y) => y.length - x.length).join('|');
      leanCache.set(tid, rules.length ? { rules, re: new RegExp(`(^|[^\\p{L}])(${alts})(?=$|[^\\p{L}])`, 'giu') } : null);
    }
    return leanCache.get(tid);
  }
  function leanHits(text, tid) {
    const L = leanRules(tid), hits = [];
    if (!L) return hits;
    for (const m of String(text).matchAll(L.re)) { const r = L.rules.find(x => x.re.test(m[2])); if (r && !hits.includes(r)) hits.push(r); }
    return hits;
  }
  // one line under a statement: what each coloured word means and how often it is false
  function leanLegend(text, tid, force) {
    if (!state.highlights && !force) return '';
    const hits = leanHits(text, tid);
    return hits.length ? `<div class="leanline">${hits.map(r => `<span class="${r.pct_false >= 50 ? 'lf' : 'lv'}"><b>${h(r.it)}</b> = ${h(r.en)} · ${Math.max(r.pct_false, 100 - r.pct_false)}% ${r.pct_false >= 50 ? 'Falso' : 'Vero'}</span>`).join('')}</div>` : '';
  }
  function highlight(text, words, force, tid) {
    let out = h(text);
    if (!state.highlights && !force) return out;
    const L = leanRules(tid);
    if (L) out = out.replace(L.re, (m, pre, w) => { const r = L.rules.find(x => x.re.test(w)); return r ? `${pre}<u class="${r.pct_false >= 50 ? 'lf' : 'lv'}">${w}</u>` : m; });
    for (const w of words || []) {
      const re = new RegExp(`(^|[^\\p{L}])(${h(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}])`, 'iu');
      out = out.replace(re, '$1<mark>$2</mark>');
    }
    return out;
  }
  const narrationHtml = n => h(n).replace(/\[\[(.+?)\]\]/g, (_, t) => `<button class="term" data-say="${h(t)}">${h(t)}</button>`);
  const termsHtml = list => (list || []).map(t => `<button data-say="${h(t.it)}"><span class="it">${h(t.it)}</span> — ${h(t.en)}${t.note ? `<div class="note">${h(t.note)}</div>` : ''}</button>`).join('');

  // how the user is doing on each stop of a topic ({answered, attempts, wrong, accuracy, weak}); missing data just means no marks
  async function stopStats(tid) {
    try { return new Map((await api(`/api/topics/${tid}/stop_stats`)).stops.map(x => [x.id, x])); } catch (_) { return new Map(); }
  }
  const weakBadge = (st, long) => !st || !st.weak ? ''
    : long ? `<div class="weakline"><span class="badge red">Weak stop</span> <span class="small muted">${st.accuracy}% right · ${st.wrong} wrong in ${st.attempts} answers</span></div>`
      : `<span class="badge red">weak · ${st.accuracy}%</span>`;

  function setTab(name) { tabs.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.tab === name)); }
  // the bar is fixed over the page; publish its height so nothing ends up hidden behind it
  const measureTabs = () => document.documentElement.style.setProperty('--tabs-h', `${tabs.offsetHeight}px`);
  measureTabs();
  window.addEventListener('resize', measureTabs);
  window.addEventListener('orientationchange', () => setTimeout(measureTabs, 300));
  const bar = (back, crumb) => `<div class="bar"><button class="back" data-go="${h(back)}">‹ Back</button><span class="crumb">${h(crumb || '')}</span></div>`;
  const errorCard = (e, retry) => `<div class="card"><h3>Couldn't load</h3><p class="muted">${h(e.message)}</p><button class="btn" data-go="${h(retry)}">Try again</button></div>`;
  function stepper(stage, passed) {
    const order = ['teach', 'review', 'quiz'], names = { teach: '1 Teach', review: '2 Review', quiz: '3 Quiz' };
    const cur = order.indexOf(stage);
    return `<div class="stepper">${order.map((s, i) => `<span class="${s === stage ? 'on' : i < cur || passed ? 'done' : ''}">${names[s]}</span>`).join('<i>›</i>')}</div>`;
  }
  function toast(msg) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const t = el(`<div class="toast">${h(msg)}</div>`);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }
  const missedHtml = list => list.map(q => `<div class="item">${q.image_url ? `<img class="thumb" src="${h(q.image_url)}" alt="" loading="lazy">` : ''}<div>${highlight(q.q_it, q.trap_words, true, q.topic_id)} <span class="muted small">→ ${q.answer ? 'Vero' : 'Falso'}</span></div>${q.q_en ? `<div class="small muted">${h(q.q_en)}</div>` : ''}${q.why_en ? `<div class="small">${h(q.why_en)}</div>` : ''}</div>`).join('');
  // a stop opens when the one before it is passed, or once it has been quizzed itself (a stop quiz or a whole-topic run)
  const isLocked = (ord, prevPassed, tried) => !state.unlockAll && ord > 1 && !prevPassed && !tried;

  app.addEventListener('click', e => {
    const lock = e.target.closest('[data-locked]');
    if (lock) { toast(lock.dataset.locked); return; }
    const go = e.target.closest('[data-go]');
    if (go) { location.hash = go.dataset.go; return; }
    const jump = e.target.closest('[data-jump]');
    if (jump) {                                                   // in-page anchors: a bare #id would be read by the hash router
      const box = jump.closest('details'); if (box && jump.dataset.close) box.open = false;
      document.getElementById(jump.dataset.jump)?.scrollIntoView({ block: 'start' });
      return;
    }
    const say = e.target.closest('[data-say]');
    if (say) speakIt(say.dataset.say);
  });

  // ---------- user ----------
  function askUser() {
    setTab('');
    app.innerHTML = `<div class="modal"><div class="card">
      <h2>Who's studying?</h2>
      <p class="muted">Your name keeps your progress separate from anyone else using this app.</p>
      <input type="text" id="uname" placeholder="Farwa" autocomplete="off">${gap(10)}
      <button class="btn primary" id="usave">Start</button></div></div>`;
    const save = () => { const v = document.getElementById('uname').value.trim(); if (!v) return; state.user = v; localStorage.setItem('strada_user', v); route(); };
    document.getElementById('usave').onclick = save;
    document.getElementById('uname').onkeydown = e => { if (e.key === 'Enter') save(); };
  }

  // ---------- home: the road ----------
  async function home() {
    setTab('home');
    app.innerHTML = `<h1>The road</h1><div class="empty">Loading…</div>`;
    let ts;
    try { ts = await api('/api/topics'); } catch (e) { app.innerHTML = errorCard(e, '#/'); return; }
    const nextId = (ts.find(t => t.passed < t.subtopics) || {}).id;
    const done = ts.reduce((a, t) => a + t.passed, 0), total = ts.reduce((a, t) => a + t.subtopics, 0);
    app.innerHTML = `
      <div class="bar"><h1>The road</h1><span class="crumb">${h(state.user)}</span></div>
      <p class="muted">${done} of ${total} stops passed · ${ts.filter(t => t.mastered).length} of ${ts.length} topics mastered.</p>
      <div class="row"><button class="btn primary" data-go="#/crash">⚡ Crash course${daysLeft() >= 0 ? ` · ${daysLeft()} days` : ''}</button><button class="btn" data-go="#/trucchi">🎯 Trucchi</button></div>${gap(10)}
      <div class="row"><button class="btn" data-go="#/signs">🚦 Sign cards</button><button class="btn" data-go="#/numbers">🔢 Numbers</button></div>${gap(10)}
      <button class="btn" data-go="#/repair">Repair test · 10 questions from your weakest topics</button>${gap(16)}
      <div class="road">${ts.map(t => {
        const cls = t.passed === t.subtopics ? 'done' : t.passed || t.lesson_done ? 'started' : '';
        return `<button class="node ${cls} ${t.id === nextId ? 'next' : ''}" data-go="#/topic/${t.id}">
          <span class="dot">${t.passed === t.subtopics ? '✓' : t.ord}</span>
          <div class="title">${h(t.title_en)}${t.mastered ? '<span class="badge green">mastered</span>' : ''}</div>
          <div class="sub">${h(t.title_it)} · ${t.subtopics} stops · ${t.questions} questions</div>
          <div class="meter"><i style="width:${t.subtopics ? Math.round(100 * t.passed / t.subtopics) : 0}%"></i></div>
        </button>`; }).join('')}
      </div>`;
  }

  // ---------- topic: stops ----------
  async function topic(tid) {
    setTab('home');
    app.innerHTML = bar('#/', 'Topic') + `<div class="empty">Loading…</div>`;
    let d, stats;
    try { [d, stats] = await Promise.all([api(`/api/topics/${tid}`), stopStats(tid)]); } catch (e) { app.innerHTML = errorCard(e, `#/topic/${tid}`); return; }
    const subs = d.subtopics;
    const nextId = (subs.find(s => !s.quiz_passed) || {}).id;
    const withAudio = subs.filter(s => s.audio_url).length;
    const topicQs = subs.reduce((a, s) => a + s.question_count, 0);
    const lockedAt = i => isLocked(subs[i].ord, i > 0 && subs[i - 1].quiz_passed, subs[i].attempts > 0);
    const weak = subs.map((s, i) => [s, i]).filter(([s]) => stats.get(s.id)?.weak);
    app.innerHTML = bar('#/', d.topic.title_it) + `
      <h1>${h(d.topic.title_en)}${d.mastered ? '<span class="badge green">mastered</span>' : ''}</h1>
      <p class="muted">${subs.filter(s => s.quiz_passed).length} of ${subs.length} stops passed. Stops unlock in order as you pass each quiz, or all at once when you finish the topic questions.</p>
      <div class="stack">
        <button class="btn primary" data-go="#/read/${tid}">Topic lesson · ${subs.length} stops${withAudio ? ' with audio' : ''}</button>
        ${topicQs ? `<button class="btn quiet" data-go="#/marathon/${tid}">Skip to the topic questions · ${topicQs}</button>` : ''}
        <button class="btn" data-go="#/topic-test/${tid}">Topic test</button>
      </div>${gap(16)}
      ${weak.length ? `<div class="card weakcard"><strong>Needs extra attention</strong><div class="small muted">The stops you get wrong most, lowest accuracy first:</div>
        <div class="chips">${weak.map(([s, i]) => `<button class="chip" ${lockedAt(i) ? `data-locked="Pass stop ${s.ord - 1} first"` : `data-go="#/lesson/${s.id}"`}>Stop ${s.ord} · ${stats.get(s.id).accuracy}%</button>`).join('')}</div></div>${gap(16)}` : ''}
      <div class="road">${subs.map((s, i) => {
        const locked = lockedAt(i);
        const st = stats.get(s.id);
        const cls = s.quiz_passed ? 'done' : s.lesson_done || s.review_done ? 'started' : '';
        const meta = [`${s.question_count} questions`, s.best_accuracy != null ? `best ${s.best_accuracy}%` : null, s.attempts > 1 ? `${s.attempts} tries` : null,
          st && st.accuracy != null ? `${st.accuracy}% right overall` : null].filter(Boolean).join(' · ');
        return `<button class="node ${cls} ${locked ? 'locked' : ''} ${s.id === nextId && !locked ? 'next' : ''}" ${locked ? `data-locked="Pass stop ${s.ord - 1} first"` : `data-go="#/lesson/${s.id}"`}>
          <span class="dot">${s.quiz_passed ? '✓' : locked ? '🔒' : s.ord}</span>
          <div class="title">${h(s.title_en)}${weakBadge(st)}</div>
          <div class="sub">${h(s.title_it)} · ${meta}</div>
        </button>`; }).join('')}
      </div>`;
  }

  async function loadSub(sid, fresh) {
    if (fresh || !state.subCache[sid]) state.subCache[sid] = await api(`/api/subtopics/${sid}`);
    return state.subCache[sid];
  }
  function lockedCard(d) {
    const s = d.subtopic;
    return bar(`#/topic/${s.topic_id}`, d.topic.title_en) + `<div class="card"><h2>🔒 ${h(s.title_en)}</h2><p class="muted">Pass the quiz on stop ${s.ord - 1} (${h(s.prev.title_en)}) to unlock this one.</p>
      <button class="btn primary" data-go="#/lesson/${s.prev.id}">Go to stop ${s.ord - 1}</button></div>`;
  }

  // ---------- stage 1: teach ----------
  async function lesson(sid) {
    setTab('home');
    app.innerHTML = bar('#/', 'Lesson') + `<div class="empty">Loading…</div>`;
    let d;
    try { d = await loadSub(sid, true); } catch (e) { app.innerHTML = errorCard(e, `#/lesson/${sid}`); return; }
    const s = d.subtopic, p = d.progress || {};
    if (isLocked(s.ord, d.prev_passed, d.progress?.attempts > 0)) { app.innerHTML = lockedCard(d); return; }
    const terms = termsHtml(d.terms);
    app.innerHTML = bar(`#/topic/${s.topic_id}`, d.topic.title_en) + stepper('teach', p.quiz_passed) + `
      <h1>${h(s.title_en)}${p.quiz_passed ? `<span class="badge green">passed · ${p.best_accuracy}%</span>` : ''}</h1>
      <p class="muted">${h(s.title_it)} · stop ${s.ord}</p>
      ${s.image_url ? `<div class="figure"><img src="${h(s.image_url)}" alt=""></div>` : ''}${gap(12)}
      ${s.audio_url ? `<div class="card player"><button class="play" id="play" aria-label="Play narration">▶</button><div class="track"><i id="trk"></i></div><span class="time" id="tm">0:00</span></div>`
        : `<div class="card muted small">No narration audio for this stop yet — read the text below and tap any blue word to hear it.</div>`}${gap(12)}
      ${s.narration ? `<div class="narration">${narrationHtml(s.narration)}</div>` : `<p class="muted">No lesson text yet for this stop. Run the enrichment step to generate it.</p>`}${gap(14)}
      ${terms ? `<h3>Words the quiz uses</h3>${gap(8)}<div class="terms">${terms}</div>` : ''}${gap(18)}
      <div class="stack">
        <button class="btn primary" id="toreview">Continue to Review · ${(d.terms || []).length} words + traps</button>
        <button class="btn quiet" data-go="#/quiz/${sid}">Skip to Quiz · ${d.questions.length} questions</button>
      </div>`;
    document.getElementById('toreview').onclick = () => { post('/api/subtopic_progress', { subtopic_id: sid, lesson_done: true }); location.hash = `#/review-stage/${sid}`; };

    if (s.audio_url) {
      const audio = new Audio(s.audio_url);
      const play = document.getElementById('play'), trk = document.getElementById('trk'), tm = document.getElementById('tm');
      play.onclick = () => { if (audio.paused) { window.speechSynthesis?.cancel(); audio.play(); } else audio.pause(); };
      audio.onplay = () => play.textContent = '❚❚';
      audio.onpause = () => play.textContent = '▶';
      audio.ontimeupdate = () => { if (audio.duration) { trk.style.width = `${100 * audio.currentTime / audio.duration}%`; tm.textContent = fmt(audio.duration - audio.currentTime); } };
      audio.onloadedmetadata = () => tm.textContent = fmt(audio.duration);
      audio.onended = () => { play.textContent = '▶'; trk.style.width = '100%'; post('/api/subtopic_progress', { subtopic_id: sid, lesson_done: true }); };
      window.addEventListener('hashchange', () => audio.pause(), { once: true });
    }
  }

  // ---------- stage 2: review (multiple choice engine) ----------
  async function reviewStage(sid) {
    setTab('home');
    app.innerHTML = bar(`#/lesson/${sid}`, 'Review') + `<div class="empty">Loading…</div>`;
    let d, r;
    try { d = await loadSub(sid); r = await api(`/api/review_set/${sid}`); } catch (e) { app.innerHTML = errorCard(e, `#/review-stage/${sid}`); return; }
    const s = d.subtopic;
    if (!r.exercises.length) {
      post('/api/subtopic_progress', { subtopic_id: sid, review_done: true });
      app.innerHTML = bar(`#/lesson/${sid}`, s.title_en) + stepper('review') + `<div class="card"><p>This stop has no words or trap questions to review — straight to the quiz.</p><button class="btn primary" data-go="#/quiz/${sid}">Start quiz</button></div>`;
      return;
    }
    runMC(r.exercises, {
      back: `#/lesson/${sid}`, crumb: s.title_en,
      onFinish: res => {
        post('/api/subtopic_progress', { subtopic_id: sid, review_done: true });
        post('/api/session', { kind: 'review_stage', ref_id: sid, correct: res.correct, total: res.total, passed: true });
        app.innerHTML = bar(`#/lesson/${sid}`, s.title_en) + stepper('review') + `
          <div class="result"><div class="big">${res.pct}%</div><p class="muted">first-try · ${res.total} exercises · ${res.missed} needed a repeat</p></div>
          <div class="card"><strong>Review done.</strong> Now the official questions — every one must be cleared, and you need ${state.health?.stop_pass_pct ?? 90}% first-try to pass the stop.</div>${gap(14)}
          <div class="stack"><button class="btn primary" data-go="#/quiz/${sid}">Start quiz · ${d.questions.length} questions</button><button class="btn quiet" data-go="#/lesson/${sid}">Back to lesson</button></div>`;
      },
    });
  }

  function runMC(exercises, { back, crumb, onFinish }) {
    const items = exercises.map(x => ({ x, wrongOnce: false, streak: 0 }));
    const queue = [...items], total = items.length, cleared = new Set();
    let firstTry = 0, current = null, missed = 0;
    const kinds = { w2m: 'What does this word mean?', m2w: 'Which Italian word is this?', trap: 'Which word completes the official statement?' };
    const header = () => `${bar(back, crumb)}${stepper('review')}
      <div class="row" style="align-items:baseline"><strong>Cleared ${cleared.size} of ${total}</strong><span class="muted small" style="text-align:right">${queue.length + (current ? 1 : 0)} left</span></div>
      <div class="progress"><i style="width:${Math.round(100 * cleared.size / total)}%"></i></div>`;
    const key = x => x.term_id || x.question_id;

    function render() {
      const x = current.x;
      const prompt = x.type === 'w2m' ? `<div class="prompt it">${h(x.prompt)} <button class="btn small" data-say="${h(x.it)}">🔊</button></div>`
        : x.type === 'm2w' ? `<div class="prompt">${h(x.prompt)}</div>`
        : `${x.image_url ? `<div class="figure"><img src="${h(x.image_url)}" alt=""></div>` : ''}<div class="prompt">${h(x.prompt).replace('______', '<span class="blank">&nbsp;</span>')}</div>`;
      app.innerHTML = header() + `<div class="kind">${kinds[x.type]}${current.wrongOnce ? ' · repeat' : ''}</div>${prompt}
        <div class="options">${x.options.map((o, i) => `<button class="btn" data-i="${i}">${h(o)}</button>`).join('')}</div>`;
      app.querySelectorAll('.options .btn').forEach(b => b.onclick = () => answer(+b.dataset.i));
    }

    function answer(i) {
      const item = current, x = item.x, correct = i === x.answer_index;
      if (x.term_id) post('/api/term_answer', { term_id: x.term_id, correct });
      if (correct) {
        item.streak++;
        if (!item.wrongOnce) { firstTry++; cleared.add(key(x)); }
        else if (item.streak >= 2) cleared.add(key(x));
        else queue.push(item);
      } else {
        if (!item.wrongOnce) missed++;
        item.wrongOnce = true; item.streak = 0;
        queue.splice(Math.min(3, queue.length), 0, item);
      }
      app.querySelectorAll('.options .btn').forEach((b, k) => { b.disabled = true; if (k === x.answer_index) b.classList.add('right'); else if (k === i) b.classList.add('wrong'); });
      const explain = x.type === 'trap'
        ? `<div class="verdict">${correct ? '✓ Correct' : '✗ Wrong'} — the word is <mark>${h(x.options[x.answer_index])}</mark></div>
           <p>${highlight(x.q_it, x.trap_words, true)} <strong>→ ${x.answer ? 'Vero' : 'Falso'}</strong></p>${x.q_en ? `<p class="en">${h(x.q_en)}</p>` : ''}${x.why_en ? `<p style="margin:0">${h(x.why_en)}</p>` : ''}`
        : `<div class="verdict">${correct ? '✓ Correct' : '✗ Wrong'}</div><p style="margin:0"><strong style="color:var(--blue)">${h(x.it)}</strong> — ${h(x.en)}${x.note ? `<br><span class="muted small">${h(x.note)}</span>` : ''} <button class="btn small" data-say="${h(x.it)}">🔊</button></p>`;
      app.appendChild(el(`<div class="feedback ${correct ? 'ok' : 'no'}">${explain}</div>`));
      app.appendChild(el(`${gap(12)}`));
      const nb = el(`<button class="btn primary">Next</button>`);
      nb.onclick = next; app.appendChild(nb);
      if (x.type === 'w2m' || x.type === 'm2w') speakIt(x.it);
    }
    function next() { if (!queue.length) { current = null; return onFinish({ correct: firstTry, total, missed, pct: Math.round(100 * firstTry / total) }); } current = queue.shift(); render(); }
    next();
  }

  // ---------- drill engine (quiz stage + spaced review) ----------
  function runDrill({ questions, back, crumb, stage, onFinish }) {
    const items = questions.map(q => ({ q, wrongOnce: false, streak: 0 }));
    const queue = [...items], total = items.length, cleared = new Set(), missed = new Map();
    let firstTry = 0, current = null, answered = 0;
    const header = () => `${bar(back, crumb)}${stage ? stepper(stage) : ''}
      <div class="row" style="align-items:baseline"><strong>Cleared ${cleared.size} of ${total}</strong><span class="muted small" style="text-align:right">${queue.length + (current ? 1 : 0)} left in queue</span></div>
      <div class="progress"><i style="width:${Math.round(100 * cleared.size / total)}%"></i></div>`;

    function renderQuestion() {
      const q = current.q;
      app.innerHTML = header() + `
        ${q.image_url ? `<div class="figure"><img src="${h(q.image_url)}" alt=""></div>` : ''}
        <div class="statement">${highlight(q.q_it, q.trap_words, false, q.topic_id)}</div>${leanLegend(q.q_it, q.topic_id)}
        <div class="tools">
          <button class="btn small" data-say="${h(q.q_it)}">🔊 Listen</button>
          <label class="toggle"><input type="checkbox" id="hl" ${state.highlights ? 'checked' : ''}> highlight trap &amp; leaning words</label>
          ${current.wrongOnce ? '<span class="small muted">· repeat</span>' : ''}
        </div>${gap(16)}
        <div class="vf"><button class="btn" id="vero">Vero</button><button class="btn" id="falso">Falso</button></div>`;
      document.getElementById('vero').onclick = () => answer(true);
      document.getElementById('falso').onclick = () => answer(false);
      document.getElementById('hl').onchange = e => { state.highlights = e.target.checked; localStorage.setItem('strada_hl', state.highlights ? '1' : '0'); renderQuestion(); };
    }

    function answer(val) {
      const item = current, q = item.q, correct = val === q.answer;
      answered++;
      post('/api/answer', { question_id: q.id, correct });
      if (correct) {
        item.streak++;
        if (!item.wrongOnce) { firstTry++; cleared.add(q.id); }
        else if (item.streak >= 2) cleared.add(q.id);
        else queue.push(item);
      } else {
        item.wrongOnce = true; item.streak = 0; missed.set(q.id, q);
        queue.splice(Math.min(3, queue.length), 0, item);
      }
      const trap = (q.trap_words || []).length ? `Trap word: <mark>${h(q.trap_words.join(', '))}</mark>${q.trap_type && q.trap_type !== 'none' ? ` <span class="muted small">(${h(q.trap_type)})</span>` : ''}` : '<span class="muted">No trap word — this one is about the rule itself.</span>';
      app.innerHTML = header() + `
        ${q.image_url ? `<div class="figure"><img src="${h(q.image_url)}" alt=""></div>` : ''}
        <div class="statement">${highlight(q.q_it, q.trap_words, true, q.topic_id)}</div>${leanLegend(q.q_it, q.topic_id, true)}
        <div class="feedback ${correct ? 'ok' : 'no'}">
          <div class="verdict">${correct ? '✓ Correct' : '✗ Wrong'} — it's ${q.answer ? 'Vero' : 'Falso'}${correct ? '' : ' (this one comes back until you get it twice)'}</div>
          ${q.q_en ? `<p class="en">${h(q.q_en)}</p>` : ''}${q.why_en ? `<p>${h(q.why_en)}</p>` : ''}
          <p style="margin:0">${trap}</p>
          ${q.reform_check ? '<p class="small muted" style="margin:8px 0 0">⚠ Rule may have changed in the Dec 2024 reform — double-check this one.</p>' : ''}
          <div id="tutorbox"></div>
        </div>${gap(14)}
        <div class="row">${state.health?.tutor ? `<button class="btn" id="ask">Ask tutor</button>` : ''}<button class="btn primary" id="next">Next</button></div>`;
      document.getElementById('next').onclick = next;
      const ask = document.getElementById('ask');
      if (ask) ask.onclick = () => askTutor(ask, q.id, val, document.getElementById('tutorbox'));
    }
    function next() {
      if (!queue.length) { current = null; return onFinish({ correct: firstTry, total, answered, missed: [...missed.values()], pct: total ? Math.round(100 * firstTry / total) : 0 }); }
      current = queue.shift(); renderQuestion();
    }
    next();
  }

  async function askTutor(btn, qid, given, box) {
    btn.disabled = true; btn.textContent = 'Thinking…';
    try { const r = await api('/api/tutor', { question_id: qid, user_answer: given }); box.innerHTML = `<div class="tutor">${h(r.answer_en)}</div>`; btn.remove(); }
    catch (e) { btn.disabled = false; btn.textContent = 'Ask tutor'; box.innerHTML = `<div class="tutor muted">${h(e.message)}</div>`; }
  }

  // ---------- stage 3: quiz with gate ----------
  async function quiz(sid, shuffled) {
    setTab('home');
    app.innerHTML = bar(`#/lesson/${sid}`, 'Quiz') + `<div class="empty">Loading…</div>`;
    let d;
    try { d = await loadSub(sid, true); } catch (e) { app.innerHTML = errorCard(e, `#/quiz/${sid}`); return; }
    const s = d.subtopic;
    if (isLocked(s.ord, d.prev_passed, d.progress?.attempts > 0)) { app.innerHTML = lockedCard(d); return; }
    const questions = shuffled ? shuffle(d.questions) : d.questions;
    runDrill({
      questions, back: `#/lesson/${sid}`, crumb: s.title_en, stage: 'quiz',
      onFinish: async res => {
        app.innerHTML = bar(`#/lesson/${sid}`, s.title_en) + `<div class="empty">Saving…</div>`;
        let r;
        try { r = await api('/api/subtopic_progress', { subtopic_id: sid, quiz_result: { correct: res.correct, total: res.total } }); }
        catch (e) { r = { passed_now: res.pct >= (state.health?.stop_pass_pct ?? 90), pass_pct: state.health?.stop_pass_pct ?? 90, quiz_passed: false }; }
        delete state.subCache[sid];
        const passed = r.passed_now;
        app.innerHTML = bar(`#/lesson/${sid}`, s.title_en) + stepper('quiz', passed) + `
          <div class="result"><div class="big" style="color:${passed ? 'var(--green)' : 'var(--red)'}">${passed ? 'Stop passed' : 'Not yet'}</div>
          <p class="muted">${res.pct}% first-try · need ${r.pass_pct}% · ${res.total} questions · ${res.answered} answers${r.attempts > 1 ? ` · attempt ${r.attempts}` : ''}</p></div>
          ${res.missed.length ? `<h3>${passed ? 'Missed on first try' : 'Fix these first'}</h3>${gap(8)}<div class="list">${missedHtml(res.missed)}</div>` : `<div class="card"><strong>Clean run.</strong> Every question right first time.</div>`}${gap(16)}
          <div class="stack" id="fin"></div>`;
        const fin = document.getElementById('fin');
        if (passed) {
          fin.appendChild(el(s.next ? `<button class="btn primary" data-go="#/lesson/${s.next.id}">Next stop: ${h(s.next.title_en)}</button>` : `<button class="btn primary" data-go="#/topic/${s.topic_id}">Topic done — back to topic</button>`));
          if (res.missed.length) { const b = el(`<button class="btn">Drill the ${res.missed.length} missed once more</button>`); b.onclick = () => repairThen(res.missed, sid, s, `#/topic/${s.topic_id}`); fin.appendChild(b); }
          fin.appendChild(el(`<button class="btn quiet" data-go="#/topic/${s.topic_id}">Back to topic</button>`));
        } else {
          const b = el(`<button class="btn primary">Repair · drill the ${res.missed.length} missed</button>`);
          b.onclick = () => repairThen(res.missed, sid, s);
          fin.appendChild(b);
          const rt = el(`<button class="btn">Retake quiz now</button>`); rt.onclick = () => quiz(sid, true); fin.appendChild(rt);
          fin.appendChild(el(`<button class="btn quiet" data-go="#/lesson/${sid}">Re-read the lesson</button>`));
        }
      },
    });
  }
  function repairThen(missed, sid, s, backTo) {
    runDrill({
      questions: shuffle(missed), back: `#/lesson/${sid}`, crumb: `${s.title_en} · repair`, stage: 'quiz',
      onFinish: res => {
        app.innerHTML = bar(`#/lesson/${sid}`, s.title_en) + stepper('quiz') + `
          <div class="result"><div class="big">${res.pct}%</div><p class="muted">on the ${res.total} you missed</p></div>
          <div class="stack" id="fin"></div>`;
        const fin = document.getElementById('fin');
        if (backTo) fin.appendChild(el(`<button class="btn primary" data-go="${backTo}">Continue</button>`));
        else { const rt = el(`<button class="btn primary">Retake quiz · ${state.subCache[sid]?.questions.length || ''} questions</button>`); rt.onclick = () => quiz(sid, true); fin.appendChild(rt); }
        fin.appendChild(el(`<button class="btn quiet" data-go="#/lesson/${sid}">Back to lesson</button>`));
      },
    });
  }

  // ---------- exam-style tests: exam, topic test, repair ----------
  function runTest(d, { kind, ref_id, back, title, passedText, failedText }) {
    const qs = d.questions, answers = new Array(qs.length).fill(null);
    const timed = !!d.minutes;
    let i = 0, left = timed ? d.minutes * 60 : 0, timer = null, done = false, used = 0;
    const tick = () => { if (timed) { left--; if (left <= 0) return submit(); } else used++; const t = document.getElementById('timer'); if (t) { t.textContent = fmt(timed ? left : used); t.classList.toggle('low', timed && left < 120); } };
    timer = setInterval(tick, 1000);
    window.addEventListener('hashchange', () => clearInterval(timer), { once: true });

    function render() {
      const q = qs[i];
      app.innerHTML = `
        <div class="bar"><span class="crumb">${h(title)} · ${i + 1} of ${qs.length}</span><span class="timer ${timed && left < 120 ? 'low' : ''}" id="timer">${fmt(timed ? left : used)}</span></div>
        ${q.image_url ? `<div class="figure"><img src="${h(q.image_url)}" alt=""></div>` : ''}
        <div class="statement">${h(q.q_it)}</div>
        <div class="vf"><button class="btn ${answers[i] === true ? 'primary' : ''}" id="vero">Vero</button><button class="btn ${answers[i] === false ? 'primary' : ''}" id="falso">Falso</button></div>${gap(14)}
        <div class="row"><button class="btn" id="prev" ${i === 0 ? 'disabled' : ''}>Previous</button><button class="btn" id="nxt" ${i === qs.length - 1 ? 'disabled' : ''}>Next</button></div>${gap(16)}
        <div class="grid">${qs.map((_, k) => `<button class="${answers[k] !== null ? 'a' : ''} ${k === i ? 'cur' : ''}" data-k="${k}">${k + 1}</button>`).join('')}</div>${gap(16)}
        <button class="btn primary" id="submit">Hand in${answers.includes(null) ? ` (${answers.filter(a => a === null).length} unanswered)` : ''}</button>`;
      const pick = v => { answers[i] = v; if (i < qs.length - 1) i++; render(); };
      document.getElementById('vero').onclick = () => pick(true);
      document.getElementById('falso').onclick = () => pick(false);
      document.getElementById('prev').onclick = () => { i--; render(); };
      document.getElementById('nxt').onclick = () => { i++; render(); };
      app.querySelectorAll('.grid button').forEach(b => b.onclick = () => { i = +b.dataset.k; render(); });
      document.getElementById('submit').onclick = () => { if (!answers.includes(null) || confirm('Unanswered questions count as errors. Hand in anyway?')) submit(); };
    }

    function submit() {
      if (done) return; done = true; clearInterval(timer);
      const results = qs.map((q, k) => ({ q, given: answers[k], correct: answers[k] === q.answer }));
      const wrong = results.filter(r => !r.correct), errors = wrong.length, passed = errors <= d.max_errors;
      post('/api/answers', { answers: results.map(r => ({ user: state.user, question_id: r.q.id, correct: r.correct })) });
      post('/api/session', { kind, ref_id, correct: qs.length - errors, total: qs.length, passed, detail: { errors: wrong.map(r => r.q.id), seconds: timed ? d.minutes * 60 - left : used } });
      app.innerHTML = `${bar(back, title)}
        <div class="result"><div class="big" style="color:${passed ? 'var(--green)' : 'var(--red)'}">${passed ? passedText : failedText}</div>
        <p class="muted">${errors} errors of ${qs.length} (max ${d.max_errors}) · ${fmt(timed ? d.minutes * 60 - left : used)}</p></div>
        ${errors ? `<h3>Wrong or skipped</h3>${gap(8)}<div class="list" id="wrong"></div>` : ''}${gap(16)}
        <div class="stack" id="fin"></div>`;
      const wl = document.getElementById('wrong');
      if (wl) for (const r of wrong) {
        const item = el(`<div class="item"><div>${highlight(r.q.q_it, r.q.trap_words, true, r.q.topic_id)} <span class="muted small">→ ${r.q.answer ? 'Vero' : 'Falso'}${r.given === null ? ' (skipped)' : ''}</span></div>
          ${r.q.q_en ? `<div class="small muted">${h(r.q.q_en)}</div>` : ''}${r.q.why_en ? `<div class="small">${h(r.q.why_en)}</div>` : ''}<div class="tbox"></div></div>`);
        if (state.health?.tutor && r.given !== null) { const b = el(`<button class="btn small" style="margin-top:8px">Ask tutor</button>`); b.onclick = () => askTutor(b, r.q.id, r.given, item.querySelector('.tbox')); item.appendChild(b); }
        wl.appendChild(item);
      }
      const fin = document.getElementById('fin');
      if (wrong.length) { const b = el(`<button class="btn">Drill the ${wrong.length} wrong ones</button>`); b.onclick = () => runDrill({ questions: wrong.map(r => r.q), back, crumb: `${title} · repair`, onFinish: res => { app.innerHTML = `${bar(back, title)}<div class="result"><div class="big">${res.pct}%</div><p class="muted">on the ${res.total} you got wrong</p></div><button class="btn primary" data-go="${back}">Done</button>`; } }); fin.appendChild(b); }
      fin.appendChild(el(`<button class="btn primary" data-go="${back}">Done</button>`));
    }
    render();
  }

  async function examView() {
    setTab('exam');
    const cfg = state.health?.exam || { size: 30, minutes: 20, max_errors: 3 };
    app.innerHTML = `<h1>Exam simulation</h1>
      <div class="card"><p><strong>${cfg.size} questions · ${cfg.minutes} minutes · max ${cfg.max_errors} errors.</strong></p>
      <p class="muted" style="margin:0">Same format as the Motorizzazione test. No highlights, no hints, no listening. You can go back and change answers before you hand it in.</p></div>${gap(12)}
      <button class="btn primary" id="go">Start exam</button>`;
    document.getElementById('go').onclick = async () => {
      app.innerHTML = `<div class="empty">Loading…</div>`;
      let d; try { d = await api('/api/exam'); } catch (e) { app.innerHTML = errorCard(e, '#/exam'); return; }
      runTest(d, { kind: 'exam', back: '#/exam', title: 'Exam', passedText: 'Passed', failedText: 'Failed' });
    };
  }

  async function topicTest(tid) {
    setTab('home');
    app.innerHTML = bar(`#/topic/${tid}`, 'Topic test') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api(`/api/topic_test/${tid}`); } catch (e) { app.innerHTML = errorCard(e, `#/topic/${tid}`); return; }
    const cfg = state.health?.topic_test || { size: 10, max_errors: 3 };
    app.innerHTML = bar(`#/topic/${tid}`, 'Topic test') + `<h1>Topic test</h1><div class="card"><p><strong>${d.questions.length} official questions from this topic · max ${cfg.max_errors} errors.</strong></p><p class="muted" style="margin:0">Pass it and the topic is marked mastered. Untimed.</p></div>${gap(12)}<button class="btn primary" id="go">Start</button>`;
    document.getElementById('go').onclick = () => runTest(d, { kind: 'topic_test', ref_id: tid, back: `#/topic/${tid}`, title: 'Topic test', passedText: 'Topic mastered', failedText: 'Not mastered yet' });
  }

  async function repairView() {
    setTab('home');
    app.innerHTML = bar('#/', 'Repair test') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api('/api/repair'); } catch (e) { app.innerHTML = bar('#/', 'Repair test') + `<div class="card"><h3>Repair test</h3><p class="muted">${h(e.message)}</p><button class="btn" data-go="#/">Back to the road</button></div>`; return; }
    app.innerHTML = bar('#/', 'Repair test') + `<h1>Repair test</h1><div class="card"><p><strong>${d.questions.length} questions from your weakest topics:</strong> ${h(d.topics.join(' and '))}.</p><p class="muted" style="margin:0">Built from what you've missed, topped up with questions you haven't seen there. Max ${d.max_errors} errors.</p></div>${gap(12)}<button class="btn primary" id="go">Start</button>`;
    document.getElementById('go').onclick = () => runTest(d, { kind: 'repair', ref_id: d.topic_ids.join(','), back: '#/', title: 'Repair', passedText: 'Repaired', failedText: 'Still leaking' });
  }

  // ---------- spaced review of official questions ----------
  async function reviewView() {
    setTab('review');
    app.innerHTML = `<h1>Review</h1><div class="empty">Loading…</div>`;
    let d; try { d = await api('/api/review?n=30'); } catch (e) { app.innerHTML = errorCard(e, '#/review'); return; }
    if (!d.questions.length) { app.innerHTML = `<h1>Review</h1><div class="empty">Nothing due yet. Pass a few stops and the questions you answered come back here on a spaced schedule (1, 3, 7, 14, 30 days).</div>`; return; }
    app.innerHTML = `<h1>Review</h1>
      <p class="muted">${d.due_count} due now${d.questions.length > d.due_count ? `, plus ${d.questions.length - d.due_count} you've missed before` : ''}. Wrong answers come back until you get them twice in a row.</p>
      <button class="btn primary" id="go">Start review · ${d.questions.length} questions</button>`;
    document.getElementById('go').onclick = () => runDrill({
      questions: d.questions, back: '#/review', crumb: 'Review',
      onFinish: res => {
        post('/api/session', { kind: 'review', correct: res.correct, total: res.total, passed: true, detail: { missed: res.missed.map(q => q.id) } });
        app.innerHTML = `${bar('#/review', 'Review')}<div class="result"><div class="big">${res.pct}%</div><p class="muted">first-try · ${res.total} questions</p></div>
          ${res.missed.length ? `<h3>Missed</h3>${gap(8)}<div class="list">${missedHtml(res.missed)}</div>` : ''}${gap(16)}<button class="btn primary" data-go="#/review">Back to review</button>`;
      },
    });
  }

  // ---------- words: flashcards ----------
  async function wordsView() {
    setTab('words');
    app.innerHTML = `<h1>Words</h1><div class="empty">Loading…</div>`;
    let d; try { d = await api('/api/words?n=20'); } catch (e) { app.innerHTML = errorCard(e, '#/words'); return; }
    if (!d.terms.length) { app.innerHTML = `<h1>Words</h1><div class="empty">No words yet. Finish a lesson and its Italian exam words show up here as flashcards.</div>`; return; }
    app.innerHTML = `<h1>Words</h1><p class="muted">${d.due_count} due${d.new_count ? ` · ${d.new_count} new` : ''}. Tap a card to flip it, then say whether you knew it.</p><button class="btn primary" id="go">Start · ${d.terms.length} cards</button>`;
    document.getElementById('go').onclick = () => runCards(d.terms);
  }
  function runCards(terms) {
    let i = 0, knew = 0, flipped = false;
    function render() {
      const t = terms[i];
      app.innerHTML = `${bar('#/words', 'Words')}
        <div class="row" style="align-items:baseline"><strong>${i + 1} of ${terms.length}</strong><span class="muted small" style="text-align:right">box ${t.box}</span></div>
        <div class="progress"><i style="width:${Math.round(100 * i / terms.length)}%"></i></div>
        <div class="card flash" id="card">${flipped
          ? `<div class="it" style="font-size:22px">${h(t.it)}</div>${gap(8)}<div class="en">${h(t.en)}</div>${t.note ? `<div class="hint">${h(t.note)}</div>` : ''}`
          : `<div class="it">${h(t.it)}</div><div class="hint">tap to reveal</div>`}</div>${gap(12)}
        <div class="row"><button class="btn small" data-say="${h(t.it)}">🔊 Say it</button></div>${gap(12)}
        ${flipped ? `<div class="vf"><button class="btn" id="no">Didn't know</button><button class="btn primary" id="yes">Knew it</button></div>` : ''}`;
      document.getElementById('card').onclick = () => { if (!flipped) { flipped = true; render(); } };
      if (flipped) {
        const grade = ok => { post('/api/term_answer', { term_id: t.id, correct: ok }); if (ok) knew++; i++; flipped = false; i < terms.length ? render() : finish(); };
        document.getElementById('yes').onclick = () => grade(true);
        document.getElementById('no').onclick = () => grade(false);
      } else speakIt(t.it);
    }
    function finish() {
      post('/api/session', { kind: 'words', correct: knew, total: terms.length, passed: true });
      app.innerHTML = `${bar('#/words', 'Words')}<div class="result"><div class="big">${knew}/${terms.length}</div><p class="muted">known · the rest come back tomorrow</p></div><div class="stack"><button class="btn primary" data-go="#/words">More words</button><button class="btn quiet" data-go="#/">Back to the road</button></div>`;
    }
    render();
  }

  // ---------- stats ----------
  async function statsView() {
    setTab('stats');
    app.innerHTML = `<h1>Stats</h1><div class="empty">Loading…</div>`;
    let d; try { d = await api('/api/stats'); } catch (e) { app.innerHTML = errorCard(e, '#/stats'); return; }
    const T = d.totals;
    const maxW = Math.max(1, ...d.trap_words.map(w => w.wrong));
    app.innerHTML = `<div class="bar"><h1>Stats</h1><span class="crumb">${h(state.user)}</span></div>
      <div class="card"><div class="row" style="text-align:center">
        <div><div style="font-size:26px;font-weight:800">${T.stops_passed}</div><div class="small muted">stops passed</div></div>
        <div><div style="font-size:26px;font-weight:800">${T.topics_mastered}</div><div class="small muted">topics mastered</div></div>
        <div><div style="font-size:26px;font-weight:800">${T.words_known}</div><div class="small muted">words known</div></div>
        <div><div style="font-size:26px;font-weight:800">${T.seen ? Math.round(100 * (T.seen - T.wrong) / T.seen) : 0}%</div><div class="small muted">accuracy · ${T.seen} answers</div></div>
      </div></div>${gap(18)}
      ${T.questions ? `
      <h3>Words that keep catching you</h3><p class="small muted">Wrong answers on questions where this word decides the answer.</p>
      ${d.trap_words.length ? `<div class="bars">${d.trap_words.map(w => `<div class="b"><span><mark>${h(w.word)}</mark></span><i style="width:${Math.round(100 * w.wrong / maxW)}%"></i><span class="small muted">${w.wrong}</span></div>`).join('')}</div>` : '<div class="muted">Nothing yet.</div>'}${gap(18)}
      <h3>Accuracy by topic</h3>${gap(8)}
      <div class="bars">${d.topics.map(t => `<div class="b acc"><span class="small">${h(t.title_en)}</span><i style="width:${t.accuracy ?? 0}%"></i><span class="small muted">${t.accuracy ?? '–'}%</span></div>`).join('')}</div>${gap(18)}
      <h3>Exam simulations</h3>${gap(8)}
      ${d.exams.length ? `<div class="list">${d.exams.map(e => `<div class="item"><strong style="color:${e.passed ? 'var(--green)' : 'var(--red)'}">${e.passed ? 'Passed' : 'Failed'}</strong> · ${e.total - e.correct} errors <span class="muted small">· ${new Date(e.finished_at).toLocaleDateString()}</span></div>`).join('')}</div>` : '<div class="muted">No exams yet.</div>'}` : '<div class="empty">No answers yet. Everything you do lands here.</div>'}${gap(24)}
      <h3>Settings</h3>${gap(8)}
      <label class="toggle"><input type="checkbox" id="unlock" ${state.unlockAll ? 'checked' : ''}> Unlock every stop (skip the pass-to-unlock rule)</label>${gap(16)}
      <button class="btn quiet small" id="switch">Switch user</button>`;
    document.getElementById('unlock').onchange = e => { state.unlockAll = e.target.checked; localStorage.setItem('strada_unlock', state.unlockAll ? '1' : '0'); toast(state.unlockAll ? 'All stops unlocked' : 'Stops unlock in order again'); };
    document.getElementById('switch').onclick = () => { localStorage.removeItem('strada_user'); state.user = ''; state.subCache = {}; route(); };
  }

  // ---------- screen 1 of the topic: every stop's text on one page, narrated stop after stop ----------
  // The topic version of a stop's Teach screen: all the stops of the topic in order, with ONE <audio> element that
  // plays their narration back to back (src + play() inside `ended`, so iOS keeps allowing it after the first tap).
  // It never scrolls the reader away: the stop that is playing is only marked, and the player's title jumps to it
  // on request. Leaving the screen by any route stops the audio (route() calls stopTopicAudio()).
  // In-page jumps use data-jump (scrollIntoView) because a plain #anchor would change the hash the router reads.
  function stopTopicAudio() {
    const a = state.topicAudio;
    if (!a) return;
    state.topicAudio = null;
    a.onended = a.onerror = a.onplay = a.onplaying = a.onpause = a.ontimeupdate = null;
    a.pause(); a.removeAttribute('src'); a.load();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      for (const act of ['play', 'pause', 'previoustrack', 'nexttrack']) { try { navigator.mediaSession.setActionHandler(act, null); } catch (_) { /* unsupported */ } }
    }
  }

  async function readView(tid) {
    setTab('home');
    const back = `#/topic/${tid}`, here = `#/read/${tid}`;
    app.innerHTML = bar(back, 'Topic lesson') + `<div class="empty">Loading…</div>`;
    let d, stats;
    try { [d, stats] = await Promise.all([api(`/api/topics/${tid}/marathon?part=lesson`), stopStats(tid)]); } catch (e) { app.innerHTML = errorCard(e, here); return; }
    if (location.hash !== here) return;                          // left while loading
    const { stops } = d, n = stops.length, qn = d.question_count || 0;
    if (!n) { app.innerHTML = bar(back, 'Topic lesson') + `<div class="empty">This topic has no stops yet.</div>`; return; }
    const tracks = stops.map((_, i) => i).filter(i => stops[i].audio_url);   // stops that have narration
    const weak = stops.map((s, i) => [s, i]).filter(([s]) => stats.get(s.id)?.weak);
    const cont = qn ? `<button class="btn primary" data-go="#/marathon/${tid}">Continue to the questions · ${qn}</button>` : '';

    const index = `<details class="card rindex" id="rindex"><summary>Jump to a stop · ${n} stops</summary>
      <div class="list">${stops.map((s, i) => `<button data-jump="rs-${i}" data-close="1"><b>${i + 1}</b><span>${h(s.title_en)}</span>${weakBadge(stats.get(s.id))}</button>`).join('')}</div></details>`;
    const section = (s, i) => `<section class="rstop" id="rs-${i}">
        <div class="kind">Stop ${i + 1} of ${n}${s.title_it ? ` · ${h(s.title_it)}` : ''}<span class="nowtag">▶ Playing now</span></div>
        <h2>${h(s.title_en)}</h2>
        ${weakBadge(stats.get(s.id), true)}
        ${s.audio_url && tracks.length > 1 ? `<button class="btn small quiet rfrom" data-from="${i}">▶ Listen from here</button>` : ''}
        ${s.image_url ? `<div class="figure"><img src="${h(s.image_url)}" alt="" loading="lazy" decoding="async"></div>` : ''}
        ${s.narration ? `<div class="narration">${narrationHtml(s.narration)}</div>` : '<p class="muted">No lesson text yet for this stop.</p>'}
        ${s.terms ? `<h3>Words for this stop</h3><div class="terms">${termsHtml(s.terms)}</div>` : ''}
        <div class="row rnav">${i > 0 ? `<button class="btn small quiet" data-jump="rs-${i - 1}">‹ Stop ${i}</button>` : '<span></span>'}<button class="btn small quiet" data-jump="rindex">↑ All stops</button>${i + 1 < n ? `<button class="btn small quiet" data-jump="rs-${i + 1}">Stop ${i + 2} ›</button>` : '<span></span>'}</div>
      </section>`;
    const player = tracks.length ? `<div class="tplayer" id="tp">
        <button class="ctl" id="tprev" aria-label="Previous stop">⏮</button><button class="ctl play" id="tpp" aria-label="Play or pause the narration">▶</button><button class="ctl" id="tnext" aria-label="Next stop">⏭</button>
        <button class="tmeta" id="tmeta" aria-label="Jump to the stop that is playing"><span class="small muted" id="tn"></span><span class="tt" id="ttt"></span></button>
        <div class="ttrack"><i id="ttrk"></i></div></div>`
      : `<div class="card muted small">No narration audio for this topic yet. Read the text and tap any blue word to hear it.</div>${gap(12)}`;
    app.innerHTML = bar(back, 'Topic lesson') + `
      <h1>${h(d.topic.title_en)}</h1>
      <p class="muted">${h(d.topic.title_it)} · ${n} stops on one page.${tracks.length ? ' Press play and the narration runs through the stops while you read.' : ''} Tap a blue word to hear it in Italian.</p>
      ${cont}${gap(12)}${player}
      ${weak.length ? `<div class="card weakcard"><strong>Needs extra attention</strong><div class="small muted">Your lowest accuracy in this topic so far:</div>
        <div class="chips">${weak.map(([s, i]) => `<button class="chip" data-jump="rs-${i}">Stop ${i + 1} · ${stats.get(s.id).accuracy}%</button>`).join('')}</div></div>${gap(12)}` : ''}
      ${index}
      ${stops.map(section).join('')}
      <div class="rstop" id="rend">${cont ? `<h3>Done reading?</h3>${gap(8)}${cont}${gap(10)}` : ''}<button class="btn quiet" data-go="${back}">Back to topic</button></div>`;
    if (!tracks.length) return;

    // --- narration: one element, started inside a tap ---
    const audio = state.topicAudio = new Audio();
    const pp = document.getElementById('tpp'), trk = document.getElementById('ttrk'), tn = document.getElementById('tn'), tt = document.getElementById('ttt'), meta = document.getElementById('tmeta');
    const sections = stops.map((_, i) => document.getElementById(`rs-${i}`));
    let ai = 0, started = false, finished = false, failures = 0;
    function draw() {
      sections.forEach((sec, i) => sec.classList.toggle('playing', started && !finished && tracks[ai] === i));
      if (started && !finished) meta.dataset.jump = `rs-${tracks[ai]}`; else delete meta.dataset.jump;
      if (!started) { tn.textContent = `Narration · ${tracks.length} stops`; tt.textContent = 'Tap play to listen'; }
      else if (finished) { tn.textContent = 'Narration finished'; tt.textContent = 'Tap play to hear it again'; }
      else { tn.textContent = `Stop ${tracks[ai] + 1} of ${n}`; tt.textContent = stops[tracks[ai]].title_en; }
    }
    function load() {                                            // always runs inside a tap or inside `ended`
      started = true; finished = ai >= tracks.length;
      trk.style.width = '0'; draw();
      if (finished) { audio.pause(); return; }
      const s = stops[tracks[ai]];
      audio.src = s.audio_url;
      const p = audio.play(); if (p && p.catch) p.catch(() => { /* blocked or interrupted: onpause shows the play button */ });
      if ('mediaSession' in navigator && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: s.title_en, artist: 'STRADA', album: d.topic.title_en });
    }
    function prevStop() {
      if (started && !finished && audio.currentTime > 3) { audio.currentTime = 0; return; }   // like a music player: first restart this stop
      ai = Math.max(0, ai - 1); load();
    }
    const nextStop = () => { if (!finished) { ai = started ? ai + 1 : 1; load(); } };
    const toggle = () => {
      if (!started || finished) { ai = 0; load(); }
      else if (audio.paused) { const p = audio.play(); if (p && p.catch) p.catch(() => {}); }
      else audio.pause();
    };
    pp.onclick = toggle;
    document.getElementById('tprev').onclick = prevStop;
    document.getElementById('tnext').onclick = nextStop;
    app.querySelectorAll('[data-from]').forEach(b => b.onclick = () => { ai = tracks.indexOf(+b.dataset.from); load(); });
    audio.onplay = () => pp.textContent = '❚❚';
    audio.onplaying = () => { failures = 0; };
    audio.onpause = () => pp.textContent = '▶';
    audio.ontimeupdate = () => { if (audio.duration && started && !finished) { trk.style.width = `${100 * audio.currentTime / audio.duration}%`; tn.textContent = `Stop ${tracks[ai] + 1} of ${n} · ${fmt(audio.duration - audio.currentTime)} left`; } };
    audio.onended = () => { post('/api/subtopic_progress', { subtopic_id: stops[tracks[ai]].id, lesson_done: true }); ai++; load(); };
    audio.onerror = () => {
      if (++failures >= 3) { toast('Narration would not load. Check the connection.'); pp.textContent = '▶'; return; }
      toast('That stop would not play, skipping it'); ai++; load();
    };
    if ('mediaSession' in navigator) {
      const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (_) { /* unsupported */ } };
      set('play', toggle); set('pause', () => audio.pause()); set('previoustrack', prevStop); set('nexttrack', nextStop);
    }
    draw();
  }

  // ---------- screen 2 of the topic: every question of the topic in one session ----------
  // The topic version of a stop's Quiz: no audio and no lesson text here (that is screen 1, the topic lesson). The
  // queue is saved after every answer, so leaving and coming back resumes where it stopped.
  async function marathon(tid) {
    setTab('home');
    const back = `#/topic/${tid}`;
    app.innerHTML = bar(back, 'Topic questions') + `<div class="empty">Loading…</div>`;
    let d;
    try { d = await api(`/api/topics/${tid}/marathon?part=questions`); } catch (e) { app.innerHTML = errorCard(e, `#/marathon/${tid}`); return; }
    if (location.hash !== `#/marathon/${tid}`) return;           // left while loading
    const { stops, questions } = d, total = questions.length, title = d.topic.title_en;
    if (!total) { app.innerHTML = bar(back, 'Topic questions') + `<div class="empty">This topic has no questions yet.</div>`; return; }

    // --- session state, saved per user + topic ---
    const key = `strada_marathon:${state.user}:${tid}`;
    const qById = new Map(questions.map(q => [q.id, q]));
    let finished = false, queue = [], cleared = new Set(), firstTry = 0, answers = 0, missed = new Map(), unsent = [], current = null;
    const fresh = () => { queue = questions.map(q => ({ q, w: false, s: 0 })); cleared = new Set(); firstTry = 0; answers = 0; missed = new Map(); unsent = []; };
    const saved = (() => { try { const v = JSON.parse(localStorage.getItem(key)); return v && v.v === 1 ? v : null; } catch (_) { return null; } })();
    if (saved) {
      cleared = new Set((saved.c || []).filter(id => qById.has(id)));
      const inQ = new Set();
      for (const [id, w, s] of saved.q || []) if (qById.has(id) && !cleared.has(id) && !inQ.has(id)) { queue.push({ q: qById.get(id), w: !!w, s }); inQ.add(id); }
      for (const q of questions) if (!cleared.has(q.id) && !inQ.has(q.id)) queue.push({ q, w: false, s: 0 });   // questions added since
      firstTry = saved.ft || 0; answers = saved.n || 0; unsent = saved.u || [];
      missed = new Map((saved.m || []).filter(id => qById.has(id)).map(id => [id, qById.get(id)]));
    } else fresh();
    const save = () => {
      if (finished) return;
      try {
        localStorage.setItem(key, JSON.stringify({ v: 1, q: (current ? [current, ...queue] : queue).map(x => [x.q.id, x.w ? 1 : 0, x.s]),
          c: [...cleared], ft: firstTry, n: answers, m: [...missed.keys()], u: unsent }));
      } catch (_) { /* storage full or blocked: the answers are still saved on the server */ }
    };
    // an answer that could not reach the server waits in `unsent` and goes out in a batch after the next one that does
    async function flush() {
      const batch = unsent.splice(0);
      try { await api('/api/answers', { answers: batch.map(a => ({ user: state.user, ...a })) }); }
      catch (_) { unsent.unshift(...batch); unsent.splice(0, Math.max(0, unsent.length - 500)); }
      save();
    }
    async function send(question_id, correct) {
      try { await api('/api/answer', { question_id, correct }); if (unsent.length) flush(); }
      catch (_) { unsent.push({ question_id, correct }); save(); }
    }
    const pending = () => current ? [current, ...queue] : queue;
    const isNew = x => !x.w && !x.s;
    const seenCount = () => total - pending().filter(isNew).length;

    // --- intro ---
    const hasSaved = !!saved && (cleared.size > 0 || answers > 0 || queue.some(x => !isNew(x)));
    app.innerHTML = bar(back, 'Topic questions') + `
      <h1>${h(title)}</h1>
      <p class="muted">Topic questions · ${stops.length} stops · ${total} questions</p>
      <div class="card"><p style="margin:0">Every question in this topic, in stop order. Wrong ones come back until you get them twice. Every answer is saved, so you can stop whenever you like and pick up here.</p></div>${gap(12)}
      ${hasSaved ? `<div class="card"><strong>${seenCount()} of ${total} answered</strong><div class="small muted">${pending().length} still in the queue</div></div>${gap(12)}` : ''}
      <div class="stack"><button class="btn primary" id="mgo">${hasSaved ? 'Resume' : 'Start'} the questions</button>
        ${hasSaved ? '<button class="btn quiet" id="mreset">Start over</button>' : ''}
        <button class="btn quiet" data-go="#/read/${tid}">Back to the topic lesson</button>
        <button class="btn quiet" data-go="${back}">Back to topic</button></div>`;
    document.getElementById('mgo').onclick = begin;
    const reset = document.getElementById('mreset');
    if (reset) reset.onclick = () => { if (confirm('Start the topic questions over? Your place in the queue is cleared (answers already recorded stay).')) { try { localStorage.removeItem(key); } catch (_) { /* ignore */ } marathon(tid); } };

    // --- running screen ---
    let mq;
    function begin() {
      app.innerHTML = bar(back, `${title} · questions`) + `<div id="mstat"></div><div id="mq"></div>`;
      mq = document.getElementById('mq');
      next();
      if (unsent.length) flush();
    }

    // --- questions ---
    function drawStats() {
      const left = pending().length, repeats = left - pending().filter(isNew).length, seen = total - (left - repeats);
      document.getElementById('mstat').innerHTML = `
        <div class="row" style="align-items:baseline"><strong>${seen} of ${total} answered</strong><span class="muted small" style="text-align:right">${left} in queue</span></div>
        <div class="progress"><i style="width:${Math.round(100 * seen / total)}%"></i></div>
        <div class="row" style="align-items:center"><span class="small muted">${cleared.size} cleared · ${repeats} to repeat</span><span style="text-align:right"><button class="btn small quiet" data-go="${back}">Stop for now</button></span></div>${gap(10)}`;
    }
    function renderQuestion() {
      const q = current.q, st = stops[q.stop];
      mq.innerHTML = `<div class="kind">Stop ${q.stop + 1} of ${stops.length} · ${h(st.title_en)}${current.w ? ' · repeat' : ''}</div>
        ${q.image_url ? `<div class="figure"><img src="${h(q.image_url)}" alt=""></div>` : ''}
        <div class="statement">${highlight(q.q_it, q.trap_words, false, tid)}</div>${leanLegend(q.q_it, tid)}
        <label class="toggle"><input type="checkbox" id="hl" ${state.highlights ? 'checked' : ''}> highlight trap &amp; leaning words</label>${gap(16)}
        <div class="vf"><button class="btn" id="vero">Vero</button><button class="btn" id="falso">Falso</button></div>`;
      document.getElementById('vero').onclick = () => answer(true);
      document.getElementById('falso').onclick = () => answer(false);
      document.getElementById('hl').onchange = e => { state.highlights = e.target.checked; localStorage.setItem('strada_hl', state.highlights ? '1' : '0'); renderQuestion(); };
    }
    function answer(val) {
      const item = current, q = item.q, correct = val === q.answer;
      current = null; answers++;
      send(q.id, correct);
      if (correct) {
        item.s++;
        if (!item.w) { firstTry++; cleared.add(q.id); }
        else if (item.s >= 2) cleared.add(q.id);
        else queue.push(item);
      } else {
        item.w = true; item.s = 0; missed.set(q.id, q);
        queue.splice(Math.min(3, queue.length), 0, item);
      }
      save(); drawStats();
      const trap = (q.trap_words || []).length ? `Trap word: <mark>${h(q.trap_words.join(', '))}</mark>${q.trap_type ? ` <span class="muted small">(${h(q.trap_type)})</span>` : ''}` : '<span class="muted">No trap word — this one is about the rule itself.</span>';
      mq.innerHTML = `
        ${q.image_url ? `<div class="figure"><img src="${h(q.image_url)}" alt=""></div>` : ''}
        <div class="statement">${highlight(q.q_it, q.trap_words, true, tid)}</div>${leanLegend(q.q_it, tid, true)}
        <div class="feedback ${correct ? 'ok' : 'no'}">
          <div class="verdict">${correct ? '✓ Correct' : '✗ Wrong'} — it's ${q.answer ? 'Vero' : 'Falso'}${correct ? '' : ' (this one comes back until you get it twice)'}</div>
          ${q.q_en ? `<p class="en">${h(q.q_en)}</p>` : ''}${q.why_en ? `<p>${h(q.why_en)}</p>` : ''}
          <p style="margin:0">${trap}</p>
          ${q.reform_check ? '<p class="small muted" style="margin:8px 0 0">⚠ Rule may have changed in the Dec 2024 reform — double-check this one.</p>' : ''}
          <div id="tutorbox"></div>
        </div>${gap(14)}
        <div class="row">${state.health?.tutor ? `<button class="btn" id="ask">Ask tutor</button>` : ''}<button class="btn primary" id="mnx">Next</button></div>`;
      document.getElementById('mnx').onclick = next;
      const ask = document.getElementById('ask');
      if (ask) ask.onclick = () => askTutor(ask, q.id, val, document.getElementById('tutorbox'));
    }
    function next() {
      if (!queue.length) return finish();
      current = queue.shift(); drawStats(); renderQuestion(); window.scrollTo(0, 0);
    }
    function finish() {
      current = null; finished = true;
      try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
      post('/api/session', { kind: 'marathon', ref_id: tid, correct: firstTry, total, passed: true, detail: { answers, missed: [...missed.keys()] } });
      // score every stop on its own first-try answers, as if its quiz had been taken: this opens every stop and gives each its best %
      const perStop = stops.map((st, i) => {
        const mine = questions.filter(q => q.stop === i);
        return { st, subtopic_id: st.id, total: mine.length, correct: mine.filter(q => !missed.has(q.id)).length };
      }).filter(x => x.total);
      post(`/api/topics/${tid}/stop_results`, { stops: perStop.map(({ subtopic_id, total, correct }) => ({ subtopic_id, total, correct })) });
      const passPct = state.health?.stop_pass_pct ?? 90;
      const stopRows = perStop.map(x => { const pct = Math.round(100 * x.correct / x.total), ok = pct >= passPct;
        return `<button class="node ${ok ? 'done' : 'started'}" data-go="#/lesson/${x.subtopic_id}"><span class="dot">${ok ? '✓' : x.st.ord}</span>
          <div class="title">${h(x.st.title_en)}</div><div class="sub" style="color:${ok ? 'var(--green)' : 'var(--red)'}">${pct}% first-try · ${x.total - x.correct} wrong of ${x.total}${ok ? ' · passed' : ` · need ${passPct}%`}</div></button>`; }).join('');
      if (unsent.length) flush();
      drawStats();
      const list = [...missed.values()];
      mq.innerHTML = `<div class="result"><div class="big">${Math.round(100 * firstTry / total)}%</div><p class="muted">first-try · ${total} questions · ${answers} answers</p></div>
        <h3>By stop</h3>${gap(8)}<div class="road">${stopRows}</div>${gap(16)}
        ${list.length ? `<h3>Missed on first try</h3>${gap(8)}<div class="list">${missedHtml(list)}</div>` : `<div class="card"><strong>Clean run.</strong> Every question right first time.</div>`}${gap(16)}
        <button class="btn primary" data-go="${back}">Back to topic</button>`;
      window.scrollTo(0, 0);
    }
  }

  // ---------- router ----------
  // ---------- crash course: a plan to the exam date, then a sprint per topic ----------
  const EXAM_KEY = 'strada_exam_date';
  const examDate = () => { try { return localStorage.getItem(EXAM_KEY) || '2026-11-17'; } catch (_) { return '2026-11-17'; } };
  const daysLeft = () => { const d = new Date(examDate() + 'T00:00:00'), t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / 864e5); };

  async function crashView() {
    setTab('home');
    app.innerHTML = bar('#/', 'Crash course') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api('/api/crash'); } catch (e) { app.innerHTML = errorCard(e, '#/crash'); return; }
    if (location.hash !== '#/crash') return;
    const ts = d.topics, days = daysLeft(), studyDays = Math.max(1, days);     // the exam morning itself is not a study day
    const cov = t => t.questions ? t.seen / t.questions : 1;
    const todo = ts.filter(t => !t.sprints && cov(t) < 0.6).sort((a, b) => cov(a) - cov(b) || a.ord - b.ord);   // topics already mostly answered need no first sprint
    const perDay = Math.ceil(todo.length / studyDays);
    const today = todo.slice(0, perDay);
    const fixes = ts.filter(t => t.to_fix).sort((a, b) => b.to_fix - a.to_fix).slice(0, 3);
    const row = t => `<div class="node crash ${t.sprints ? 'done' : ''}">
        <span class="dot">${t.sprints ? '✓' : t.ord}</span>
        <div class="title">${h(t.title_en)}</div>
        <div class="sub">${h(t.title_it)} · seen ${t.seen} of ${t.questions}${t.accuracy != null ? ` · ${t.accuracy}% right` : ''}${t.to_fix ? ` · <b style="color:var(--red)">${t.to_fix} to fix</b>` : ''}${t.sprints ? ` · ${t.sprints} sprint${t.sprints > 1 ? 's' : ''}, last ${t.last_sprint_pct}%` : ''}</div>
        <div class="meter"><i style="width:${Math.round(100 * cov(t))}%"></i></div>
        <div class="row" style="margin-top:10px"><button class="btn small primary" data-go="#/sprint/${t.id}">Sprint · ${Math.min(d.sprint_size, t.questions)}</button><button class="btn small" data-go="#/cards/${t.id}">Cards</button><button class="btn small quiet" data-go="#/read/${t.id}">Lesson</button></div>
      </div>`;
    const when = days > 1 ? `${days} days to go` : days === 1 ? 'Exam tomorrow' : days === 0 ? 'Exam day' : 'Exam date passed';
    app.innerHTML = bar('#/', 'Crash course') + `
      <h1>Crash course</h1>
      <div class="card"><div class="row" style="align-items:center"><strong style="font-size:20px">${when}</strong>
        <label class="small muted" style="text-align:right">Exam <input type="date" id="exd" value="${h(examDate())}"></label></div>
        <p class="small muted" style="margin:8px 0 0">A sprint is ${d.sprint_size} questions from one topic: your unfixed mistakes first, then questions you have never seen, one per stop in turn, so each sprint sweeps the whole topic. Every answer shows the English and why. Wrong ones come back until you get them twice.</p></div>${gap(12)}
      <div class="card"><h3 style="margin-top:0">Today</h3>
        ${today.length ? `<p class="small muted" style="margin-top:0">${todo.length} topic${todo.length > 1 ? 's' : ''} you have barely seen, over ${studyDays} day${studyDays > 1 ? 's' : ''}: ${perDay} a day. A topic drops off once it has had a sprint or you have answered 60% of it.</p>` : '<p class="small muted" style="margin-top:0">Every topic has had a sprint or is mostly done. Now fix mistakes and run exams.</p>'}
        <ol class="plan">
          ${today.map(t => `<li><a href="#/sprint/${t.id}">Sprint: ${h(t.title_en)}</a></li>`).join('')}
          ${fixes.length ? `<li>Fix mistakes: ${fixes.map(t => `<a href="#/sprint/${t.id}">${h(t.title_en)} (${t.to_fix})</a>`).join(', ')}</li>` : ''}
          <li><a href="#/review">Review what's due</a></li>
          <li><a href="#/exam">One exam simulation</a>: 30 questions, 20 minutes, max 3 errors</li>
          <li><a href="#/signs">Sign cards</a>: one family of signs, cards then the check</li>
          <li><a href="#/numbers">Numbers sheet</a>: read one group, then drill it</li>
          <li><a href="#/trucchi">Trucchi</a>: 5 minutes on the tricks, for when you don't know</li>
        </ol></div>${gap(16)}
      <h3>All topics</h3><p class="small muted">Least seen first. The bar is how much of the topic you have answered at least once.</p>
      <div class="road">${[...ts].sort((a, b) => cov(a) - cov(b) || a.ord - b.ord).map(row).join('')}</div>`;
    document.getElementById('exd').onchange = e => { try { localStorage.setItem(EXAM_KEY, e.target.value); } catch (_) { /* ignore */ } crashView(); };
  }

  async function sprintView(tid) {
    setTab('home');
    app.innerHTML = bar('#/crash', 'Sprint') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api(`/api/crash/${tid}`); } catch (e) { app.innerHTML = errorCard(e, `#/sprint/${tid}`); return; }
    if (location.hash !== `#/sprint/${tid}`) return;
    if (!d.questions.length) { app.innerHTML = bar('#/crash', 'Sprint') + `<div class="empty">No questions in this topic.</div>`; return; }
    const title = d.topic.title_en;
    runDrill({
      questions: d.questions, back: '#/crash', crumb: `Sprint · ${title}`,
      onFinish: res => {
        post('/api/session', { kind: 'crash', ref_id: tid, correct: res.correct, total: res.total, passed: res.pct >= 90, detail: { missed: res.missed.map(q => q.id) } });
        app.innerHTML = bar('#/crash', `Sprint · ${title}`) + `
          <div class="result"><div class="big" style="color:${res.pct >= 90 ? 'var(--green)' : res.pct >= 75 ? 'var(--ink)' : 'var(--red)'}">${res.pct}%</div><p class="muted">first-try · ${res.total} questions${d.fixes ? ` · ${d.fixes} were old mistakes` : ''}</p></div>
          ${res.missed.length ? `<h3>Missed on first try</h3><p class="small muted">They come back first in your next sprint on this topic.</p>${gap(4)}<div class="list">${missedHtml(res.missed)}</div>` : '<div class="card"><strong>Clean sprint.</strong></div>'}${gap(16)}
          <div class="stack"><button class="btn primary" data-go="#/crash">Back to the plan</button>
          <button class="btn" id="again">Another sprint on ${h(title)}</button></div>`;
        document.getElementById('again').onclick = () => sprintView(tid);
      },
    });
  }

  // ---------- trucchi: the word tricks, with their real hit rate on the official bank ----------
  async function trucchiView() {
    setTab('home');
    app.innerHTML = bar('#/', 'Trucchi') + `<div class="empty">Loading…</div>`;
    let d, sg; try { [d, sg] = await Promise.all([api('/api/trucchi'), api('/api/signs').catch(() => null)]); } catch (e) { app.innerHTML = errorCard(e, '#/trucchi'); return; }
    if (location.hash !== '#/trucchi') return;
    const byTopic = sg ? sg.topics.filter(t => t.rules.length) : [];
    const rule = r => {
      const pf = r.pct_false, leanF = pf >= 50, sure = Math.max(pf, 100 - pf);
      return `<div class="card trucco">
        <div class="row" style="align-items:baseline"><div><span class="tword">${h(r.it)}</span> <span class="muted">${h(r.en)}</span></div>
          <span class="badge ${sure >= 75 ? (leanF ? 'red' : 'green') : 'blue'}">${sure >= 75 ? `${sure}% ${leanF ? 'Falso' : 'Vero'}` : 'coin flip'}</span></div>
        <div class="tbar" title="${100 - pf}% Vero, ${pf}% Falso"><i class="v" style="width:${100 - pf}%"></i><i class="f" style="width:${pf}%"></i></div>
        <div class="small muted">${r.n} statements · ${r.n - r.false} Vero · ${r.false} Falso</div>
        <p style="margin:8px 0">${h(r.tip)}</p>
        ${r.examples.length && sure >= 75 ? `<details><summary class="small"><b>${r.exceptions} exception${r.exceptions > 1 ? 's' : ''} to learn</b>: ${leanF ? 'true' : 'false'} despite the word</summary>
          <div class="list" style="margin-top:8px">${r.examples.map(q => `<div class="item"><div>${h(q.q_it)} <span class="small ${q.answer ? 'ok' : 'no'}">→ ${q.answer ? 'Vero' : 'Falso'}</span></div>${q.q_en ? `<div class="small muted">${h(q.q_en)}</div>` : ''}</div>`).join('')}</div></details>` : ''}
        <button class="btn small" data-go="#/trucco/${r.id}" style="margin-top:8px">Drill ${Math.min(r.n, 30)}${r.exceptions && sure >= 75 ? ' · exceptions first' : ''}</button>
      </div>`;
    };
    app.innerHTML = bar('#/', 'Trucchi') + `
      <h1>Trucchi</h1>
      <div class="card"><p style="margin-top:0">Words that tip a statement towards Vero or Falso. Every percentage is counted on all ${d.total.toLocaleString()} official statements, so you can see how far each trick really goes.</p>
        <p class="small muted" style="margin:0">Use them only when you don't know the rule: they are odds, not answers. The drill on each one puts the <b>exceptions</b> first. Those are the questions built to catch people who rely on the trick.</p></div>${gap(16)}
      ${d.groups.map(g => { const rs = d.rules.filter(r => r.group === g.id); return rs.length ? `<h2>${h(g.title)} <span class="badge ${g.id === 'soft' ? 'green' : g.id === 'myth' ? 'blue' : 'red'}">${h(g.verdict)}</span></h2><div class="stack">${rs.map(rule).join('')}</div>${gap(16)}` : ''; }).join('')}
      ${byTopic.length ? `<h2>Words that only work in one topic</h2>
        <p class="small muted">The same word can lean one way in one topic and mean nothing in another, so these count only inside the topic shown. Red leans Falso, green leans Vero; the % is how often.</p>
        <div class="stack">${byTopic.map(t => `<div class="card"><div class="tword" style="font-size:17px">${h(t.title_en)}</div><div class="small muted">${h(t.title_it)}</div>
          <div class="rchips">${t.rules.map(r => `<span class="rchip ${r.pct_false >= 50 ? 'lf' : 'lv'}"><b>${h(r.it)}</b> ${h(r.en)} · ${Math.max(r.pct_false, 100 - r.pct_false)}% ${r.pct_false >= 50 ? 'Falso' : 'Vero'} · ${r.n}</span>`).join('')}</div>
          <button class="btn small" data-go="#/famdrill/${t.id}">Drill these words</button></div>`).join('')}</div>${gap(16)}` : ''}
      ${ladderHtml()}${gap(16)}
      <h2>How to use them</h2>
      <div class="card stack">
        <div><b>Swap the absolute for the soft word.</b> "Il limite di velocità nei centri abitati è <u>sempre</u> di 50 km/h" is <b>Falso</b> (some urban roads allow 70). The same sentence with <u>ordinariamente</u> is <b>Vero</b>.</div>
        <div><b>A phrase to remember.</b> "<i>adesivo da apporre obbligatoriamente sulla spazzatura</i>": all four words appear only in false statements in the current bank (16 statements, 16 Falso).</div>
        <div><b>Sudden actions vs avoiding them.</b> "Frenare <u>energicamente</u>", "sterzare <u>rapidamente</u>": almost always Falso. "<u>Evitare</u> manovre brusche": always Vero.</div>
        <div><b>Read every word.</b> One "solo", "anche" or "non" flips a statement. If a sentence sounds right but has an absolute in it, read it again looking for the exception.</div>
      </div>`;
  }

  async function truccoDrill(rid) {
    setTab('home');
    app.innerHTML = bar('#/trucchi', 'Trucchi drill') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api(`/api/trucchi/${rid}/drill`); } catch (e) { app.innerHTML = errorCard(e, `#/trucco/${rid}`); return; }
    if (location.hash !== `#/trucco/${rid}`) return;
    runDrill({
      questions: d.questions, back: '#/trucchi', crumb: 'Trucchi drill',
      onFinish: res => {
        app.innerHTML = bar('#/trucchi', 'Trucchi drill') + `<div class="result"><div class="big">${res.pct}%</div><p class="muted">first-try · ${res.total} questions · ${d.exceptions} exceptions in this set</p></div>
          ${res.missed.length ? `<h3>Missed</h3>${gap(8)}<div class="list">${missedHtml(res.missed)}</div>` : ''}${gap(16)}
          <div class="stack"><button class="btn primary" data-go="#/trucchi">Back to trucchi</button><button class="btn" id="again">Another round</button></div>`;
        document.getElementById('again').onclick = () => truccoDrill(rid);
      },
    });
  }

  // ---------- when in doubt: the order to apply the rules ----------
  const ladderHtml = () => `<div class="card ladder"><h3 style="margin-top:0">When in doubt</h3><ol>
      <li><b>You know the sign or the rule?</b> Answer it. Ignore the tricks.</li>
      <li><b>Wrong family verb?</b> A triangle that "vieta" or "obbliga", a blue circle that "vieta", a rectangle that talks about "sorpasso": <span class="lf">Falso</span>.</li>
      <li><b>A red word?</b> mai, in ogni caso, solo, esclusivamente, non è obbligatorio, non è necessario, rapidamente: <span class="lf">Falso</span>.</li>
      <li><b>A green word?</b> moderare, prudenza, richiede, invita, potrebbero, assicurarsi, salvo: <span class="lv">Vero</span>.</li>
      <li><b>Does it make driving safer?</b> Slower, more careful, check first: <span class="lv">Vero</span>. Bolder, faster, "no need to": <span class="lf">Falso</span>.</li>
      <li><b>Still nothing?</b> Longer, detailed statements lean Vero; short blunt ones lean Falso. Answer and move on: never leave one blank.</li>
    </ol></div>`;

  // ---------- sign families: shape and colour, what the family can and cannot say ----------
  const svg = body => `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">${body}</svg>`;
  const FAMILY = {
    'segnali-pericolo': { icon: svg('<path d="M24 5 45 42H3Z" fill="#fff" stroke="#C8102E" stroke-width="5" stroke-linejoin="round"/>'), shape: 'Red triangle, point up', says: 'Warns of a danger ahead. It never orders or forbids anything.' },
    'segnali-precedenza': { icon: svg('<path d="M24 43 3 6h42Z" fill="#fff" stroke="#C8102E" stroke-width="5" stroke-linejoin="round"/>'), shape: 'Upside-down triangle, octagon STOP, yellow diamond', says: 'Says who goes first at a junction.' },
    'segnali-divieto': { icon: svg('<circle cx="24" cy="24" r="19" fill="#fff" stroke="#C8102E" stroke-width="6"/>'), shape: 'Circle with a red border', says: 'Forbids something, from the sign onwards. It does not warn.' },
    'segnali-obbligo': { icon: svg('<circle cx="24" cy="24" r="21" fill="#0B5AA8"/><path d="M24 36V14m-8 8 8-8 8 8" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'), shape: 'Blue circle', says: 'Orders you to do something. It does not forbid and does not warn.' },
    'segnali-indicazione': { icon: svg('<rect x="4" y="10" width="40" height="28" rx="4" fill="#0B5AA8"/><rect x="12" y="18" width="24" height="12" rx="2" fill="#fff"/>'), shape: 'Rectangle: blue, green (motorway), white (town), brown (tourist)', says: 'Gives information: places, directions, services. No orders, no bans.' },
    'segnali-temporanei-complementari': { icon: svg('<rect x="4" y="10" width="40" height="28" rx="4" fill="#F5C842" stroke="#1F2328" stroke-width="2"/><path d="M14 30 24 16l10 14" stroke="#1F2328" stroke-width="3" fill="none"/>'), shape: 'Yellow background (road works), posts and markers', says: 'Temporary signs for road works, and markers that show the edge of the road.' },
    'pannelli-integrativi': { icon: svg('<rect x="6" y="18" width="36" height="14" rx="2" fill="#fff" stroke="#1F2328" stroke-width="3"/><path d="M13 25h22" stroke="#1F2328" stroke-width="3"/>'), shape: 'Small white panel under another sign', says: 'Adds detail to the sign above it: distance, hours, which vehicles.' },
    'semafori-vigile': { icon: svg('<rect x="15" y="3" width="18" height="42" rx="6" fill="#2E3339"/><circle cx="24" cy="12" r="5" fill="#C8102E"/><circle cx="24" cy="24" r="5" fill="#F5C842"/><circle cx="24" cy="36" r="5" fill="#237A57"/>'), shape: 'Traffic lights and the officer', says: 'Lights and the officer’s gestures. The officer beats the lights, the lights beat the signs.' },
    'segnali-orizzontali': { icon: svg('<rect x="3" y="8" width="42" height="32" rx="4" fill="#2E3339"/><path d="M24 12v6m0 6v6m0 6v2" stroke="#fff" stroke-width="3"/><path d="M11 12v24M37 12v24" stroke="#fff" stroke-width="2"/>'), shape: 'Lines and symbols painted on the road', says: 'Continuous line: do not cross. Broken line: you may. Yellow: reserved or temporary.' },
  };
  const ruleChip = r => `<span class="rchip ${r.pct_false >= 50 ? 'lf' : 'lv'}"><b>${h(r.it)}</b> ${h(r.en)} · ${Math.max(r.pct_false, 100 - r.pct_false)}%</span>`;
  const cardsKey = tid => `strada_cards:${state.user}:${tid}`;
  const cardsAt = tid => { try { return +localStorage.getItem(cardsKey(tid)) || 0; } catch (_) { return 0; } };
  const CARD_BATCH = 4;

  async function signsView() {
    setTab('home');
    app.innerHTML = bar('#/', 'Sign cards') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api('/api/signs'); } catch (e) { app.innerHTML = errorCard(e, '#/signs'); return; }
    if (location.hash !== '#/signs') return;
    const fam = t => { const f = FAMILY[t.slug] || {}, at = Math.min(cardsAt(t.id), t.stops), red = t.rules.filter(r => r.pct_false >= 50), green = t.rules.filter(r => r.pct_false < 50);
      return `<div class="card fam">
        <div class="famhead">${f.icon || ''}<div><div class="tword">${h(t.title_en)}</div><div class="small muted">${h(t.title_it)} · ${t.stops} cards · ${t.questions} questions</div></div></div>
        ${f.shape ? `<p style="margin:8px 0 4px"><b>${h(f.shape)}.</b> ${h(f.says)}</p>` : ''}
        ${red.length ? `<div class="small muted">If the statement says this, it is almost always <b class="lf">Falso</b>:</div><div class="rchips">${red.map(ruleChip).join('')}</div>` : ''}
        ${green.length ? `<div class="small muted">If it says this, almost always <b class="lv">Vero</b>:</div><div class="rchips">${green.map(ruleChip).join('')}</div>` : ''}
        <div class="meter"><i style="width:${t.stops ? Math.round(100 * at / t.stops) : 0}%"></i></div>
        <div class="row" style="margin-top:10px"><button class="btn small primary" data-go="#/cards/${t.id}">${at >= t.stops ? 'Cards again' : at ? `Cards · resume at ${at + 1}` : 'Cards'}</button>${t.rules.length ? `<button class="btn small" data-go="#/famdrill/${t.id}">Drill the words</button>` : ''}</div>
      </div>`; };
    const signs = d.topics.filter(t => t.sign), others = d.topics.filter(t => !t.sign);
    app.innerHTML = bar('#/', 'Sign cards') + `
      <h1>Sign cards</h1>
      <div class="card"><p style="margin:0"><b>Half the exam bank is signs.</b> Each sign has about 5 true statements. Learn those from its card and everything else about that sign is Falso. Cards come ${CARD_BATCH} at a time, then a quick check on those ${CARD_BATCH}.</p></div>${gap(12)}
      <div class="stack">${signs.map(fam).join('')}</div>${gap(16)}
      <h2>Other topics</h2><p class="small muted">The same cards work without a picture: each stop's true statements, then a check.</p>
      <div class="stack">${others.map(fam).join('')}</div>`;
  }

  async function cardsView(tid) {
    setTab('home');
    app.innerHTML = bar('#/signs', 'Cards') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api(`/api/topics/${tid}/cards`); } catch (e) { app.innerHTML = errorCard(e, `#/cards/${tid}`); return; }
    if (location.hash !== `#/cards/${tid}`) return;
    const stops = d.stops, n = stops.length, f = FAMILY[d.topic.slug] || {};
    if (!n) { app.innerHTML = bar('#/signs', 'Cards') + `<div class="empty">No cards in this topic.</div>`; return; }
    let i = Math.min(cardsAt(tid), n - 1);
    if (cardsAt(tid) >= n) i = 0;
    const save = v => { try { localStorage.setItem(cardsKey(tid), v); } catch (_) { /* ignore */ } };
    const batchStart = k => k - (k % CARD_BATCH);

    function card() {
      const s = stops[i], lie = s.lies[(i * 7) % Math.max(1, s.lies.length)], end = Math.min(batchStart(i) + CARD_BATCH, n), last = i === end - 1;
      app.innerHTML = bar('#/signs', d.topic.title_en) + `
        <div class="row" style="align-items:baseline"><strong>Card ${i + 1} of ${n}</strong><span class="muted small" style="text-align:right">check after card ${end}</span></div>
        <div class="progress"><i style="width:${Math.round(100 * i / n)}%"></i></div>
        <div class="card tcard">
          ${s.image_url ? `<div class="figure"><img src="${h(s.image_url)}" alt=""></div>` : ''}
          <div class="famhead small">${f.icon ? f.icon.replace('width="48" height="48"', 'width="22" height="22"') : ''}<span class="muted">${h(f.shape || d.topic.title_en)}</span></div>
          <h2 style="margin:6px 0 2px">${h(s.title_en)}</h2>${s.title_it ? `<div class="small muted">${h(s.title_it)}</div>` : ''}
          <div class="truths">${s.truths.map(q => `<div class="truth"><span class="tick">✓</span><div><div>${highlight(q.q_it, q.trap_words, true, false)}</div>${q.q_en ? `<div class="small muted">${h(q.q_en)}</div>` : ''}</div><button class="say" data-say="${h(q.q_it)}" aria-label="Listen">🔊</button></div>`).join('')}</div>
          ${lie ? `<div class="lie"><span class="tick">✗</span><div><div class="small muted">A typical lie about this one (${s.lies.length} in the bank):</div><div>${highlight(lie.q_it, lie.trap_words, true, tid)}</div>${lie.q_en ? `<div class="small muted">${h(lie.q_en)}</div>` : ''}</div></div>` : ''}
        </div>${gap(12)}
        <div class="row"><button class="btn" id="cprev" ${i === batchStart(i) ? 'disabled' : ''}>‹ Back</button><button class="btn primary" id="cnext">${last ? `Check these ${end - batchStart(i)} ›` : 'Next ›'}</button></div>`;
      document.getElementById('cprev').onclick = () => { i--; card(); window.scrollTo(0, 0); };
      document.getElementById('cnext').onclick = () => { if (last) check(batchStart(i), end); else { i++; card(); window.scrollTo(0, 0); } };
    }
    function check(from, to) {
      const qs = [];
      for (const s of stops.slice(from, to)) { const t = shuffle(s.truths), l = shuffle(s.lies); qs.push(...t.slice(0, 2), ...l.slice(0, 2)); }
      runDrill({
        questions: shuffle(qs), back: `#/cards/${tid}`, crumb: `${d.topic.title_en} · check`,
        onFinish: res => {
          const done = to >= n;
          save(done ? n : to);
          app.innerHTML = bar('#/signs', `${d.topic.title_en} · check`) + `
            <div class="result"><div class="big" style="color:${res.pct >= 90 ? 'var(--green)' : res.pct >= 75 ? 'var(--ink)' : 'var(--red)'}">${res.pct}%</div><p class="muted">first-try · cards ${from + 1}–${to} of ${n}</p></div>
            ${res.missed.length ? `<h3>Missed</h3>${gap(8)}<div class="list">${missedHtml(res.missed)}</div>${gap(12)}` : '<div class="card"><strong>Clean.</strong></div>' + gap(12)}
            <div class="stack">${done ? `<button class="btn primary" data-go="#/signs">Family done · back to the families</button>` : `<button class="btn primary" id="cgo">Next ${Math.min(CARD_BATCH, n - to)} cards ›</button>`}
              <button class="btn" id="cre">See these ${to - from} cards again</button><button class="btn quiet" data-go="#/signs">Stop for now</button></div>`;
          const go = document.getElementById('cgo'); if (go) go.onclick = () => { i = to; card(); window.scrollTo(0, 0); };
          document.getElementById('cre').onclick = () => { i = from; card(); window.scrollTo(0, 0); };
        },
      });
    }
    card();
  }

  async function familyDrill(tid) {
    setTab('home');
    app.innerHTML = bar('#/signs', 'Word drill') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api(`/api/topic_rules/${tid}/drill`); } catch (e) { app.innerHTML = errorCard(e, `#/famdrill/${tid}`); return; }
    if (location.hash !== `#/famdrill/${tid}`) return;
    runDrill({
      questions: d.questions, back: '#/signs', crumb: 'Word drill',
      onFinish: res => {
        app.innerHTML = bar('#/signs', 'Word drill') + `<div class="result"><div class="big">${res.pct}%</div><p class="muted">first-try · ${res.total} questions · ${d.exceptions} went against the word</p></div>
          ${res.missed.length ? `<h3>Missed</h3>${gap(8)}<div class="list">${missedHtml(res.missed)}</div>` : ''}${gap(16)}
          <div class="stack"><button class="btn primary" data-go="#/signs">Back to the families</button><button class="btn" id="again">Another round</button></div>`;
        document.getElementById('again').onclick = () => familyDrill(tid);
      },
    });
  }

  // ---------- numbers: every figure on one sheet, then a numbers-only drill ----------
  async function numbersView() {
    setTab('home');
    app.innerHTML = bar('#/', 'Numbers') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api('/api/numbers'); } catch (e) { app.innerHTML = errorCard(e, '#/numbers'); return; }
    if (location.hash !== '#/numbers') return;
    const bold = (q) => h(q.q_it).replace(/(\d+(?:[.,]\d+)?\s*(?:km\/h|[\p{L}%\/]+\d?))/u, '<b class="num">$1</b>');
    const group = g => { let last = '';
      return `<details class="card numg" ${g.id === 'speed' ? 'open' : ''}><summary><b>${h(g.title)}</b> <span class="muted small">· ${g.facts.length} true facts · ${g.statements} statements</span></summary>
        <button class="btn small" data-go="#/numdrill/${g.id}" style="margin:10px 0">Drill ${h(g.title.toLowerCase())}</button>
        <div class="list">${g.facts.map(q => { const head = q.num !== last ? `<div class="numhead">${h(q.num)}</div>` : ''; last = q.num;
          return `${head}<div class="item">${q.image_url ? `<img class="thumb" src="${h(q.image_url)}" alt="" loading="lazy">` : ''}<div>${bold(q)}</div>${q.q_en ? `<div class="small muted">${h(q.q_en)}</div>` : ''}<div class="small muted">${h(q.topic)}</div></div>`; }).join('')}</div></details>`; };
    app.innerHTML = bar('#/', 'Numbers') + `
      <h1>Numbers</h1>
      <div class="card"><p style="margin:0">No trick works on a number: the same figure is true in one statement and false in the next. These are all the <b>true</b> ones, ${d.groups.reduce((a, g) => a + g.facts.length, 0)} facts. If the exam shows a different number for the same thing, it is Falso.</p></div>${gap(12)}
      <button class="btn primary" data-go="#/numdrill/all">Drill all numbers · 20 questions</button>${gap(12)}
      <div class="stack">${d.groups.map(group).join('')}</div>`;
  }
  async function numbersDrill(gid) {
    setTab('home');
    app.innerHTML = bar('#/numbers', 'Numbers drill') + `<div class="empty">Loading…</div>`;
    let d; try { d = await api(`/api/numbers/drill${gid && gid !== 'all' ? `?group=${encodeURIComponent(gid)}` : ''}`); } catch (e) { app.innerHTML = errorCard(e, `#/numdrill/${gid}`); return; }
    if (location.hash !== `#/numdrill/${gid}`) return;
    runDrill({
      questions: d.questions, back: '#/numbers', crumb: 'Numbers drill',
      onFinish: res => {
        app.innerHTML = bar('#/numbers', 'Numbers drill') + `<div class="result"><div class="big">${res.pct}%</div><p class="muted">first-try · ${res.total} questions</p></div>
          ${res.missed.length ? `<h3>Missed</h3>${gap(8)}<div class="list">${missedHtml(res.missed)}</div>` : ''}${gap(16)}
          <div class="stack"><button class="btn primary" data-go="#/numbers">Back to the sheet</button><button class="btn" id="again">Another round</button></div>`;
        document.getElementById('again').onclick = () => numbersDrill(gid);
      },
    });
  }

  async function route() {
    if (!state.user) return askUser();
    if (!state.health) { try { state.health = await fetch('/api/health').then(r => r.json()); } catch (_) { state.health = {}; } }
    if (!state.lean) api('/api/lean').then(d => { state.lean = d; leanCache.clear(); }).catch(() => {});   // colours appear from the next screen on
    const [path, arg] = location.hash.replace(/^#\/?/, '').split('/');
    window.scrollTo(0, 0);
    window.speechSynthesis?.cancel();
    stopTopicAudio();                                           // no screen keeps playing the topic narration after it is left
    switch (path) {
      case '': return home();
      case 'topic': return topic(arg);
      case 'lesson': return lesson(arg);
      case 'review-stage': return reviewStage(arg);
      case 'quiz': return quiz(arg);
      case 'topic-test': return topicTest(arg);
      case 'marathon': return marathon(arg);
      case 'read': return readView(arg);
      case 'repair': return repairView();
      case 'review': return reviewView();
      case 'words': return wordsView();
      case 'exam': return examView();
      case 'stats': return statsView();
      case 'crash': return crashView();
      case 'sprint': return sprintView(arg);
      case 'trucchi': return trucchiView();
      case 'trucco': return truccoDrill(arg);
      case 'signs': return signsView();
      case 'cards': return cardsView(arg);
      case 'famdrill': return familyDrill(arg);
      case 'numbers': return numbersView();
      case 'numdrill': return numbersDrill(arg);
      default: location.hash = '#/';
    }
  }
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // A screen is painted from the cache first; when the server's answer turns out to differ, redraw —
    // but only where redrawing costs nothing. A quiz, exam or review in progress keeps its state.
    const REDRAWABLE = ['', 'topic', 'stats'];
    const redrawn = {};
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type !== 'api-updated') return;
      if (!REDRAWABLE.includes(location.hash.replace(/^#\/?/, '').split('/')[0])) return;
      // redraw at most once a minute per screen: a response that differs every time it is fetched would
      // otherwise redraw, refetch, differ again, and the page would never settle under the reader's finger
      const now = Date.now();
      if (now - (redrawn[location.hash] || 0) < 60000) return;
      redrawn[location.hash] = now;
      route();
    });
  }
})();
