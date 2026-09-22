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
    playlist: null,
  };

  // ---------- utils ----------
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
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

  function highlight(text, words, force) {
    let out = h(text);
    if (!state.highlights && !force) return out;
    for (const w of words || []) {
      const re = new RegExp(`(^|[^\\p{L}])(${h(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}])`, 'iu');
      out = out.replace(re, '$1<mark>$2</mark>');
    }
    return out;
  }
  const narrationHtml = n => h(n).replace(/\[\[(.+?)\]\]/g, (_, t) => `<button class="term" data-say="${h(t)}">${h(t)}</button>`);

  function setTab(name) { tabs.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.tab === name)); }
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
  const missedHtml = list => list.map(q => `<div class="item"><div>${highlight(q.q_it, q.trap_words, true)} <span class="muted small">→ ${q.answer ? 'Vero' : 'Falso'}</span></div>${q.q_en ? `<div class="small muted">${h(q.q_en)}</div>` : ''}${q.why_en ? `<div class="small">${h(q.why_en)}</div>` : ''}</div>`).join('');
  const isLocked = (ord, prevPassed) => !state.unlockAll && ord > 1 && !prevPassed;

  app.addEventListener('click', e => {
    const lock = e.target.closest('[data-locked]');
    if (lock) { toast(lock.dataset.locked); return; }
    const go = e.target.closest('[data-go]');
    if (go) { location.hash = go.dataset.go; return; }
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
    let d;
    try { d = await api(`/api/topics/${tid}`); } catch (e) { app.innerHTML = errorCard(e, `#/topic/${tid}`); return; }
    const subs = d.subtopics;
    const nextId = (subs.find(s => !s.quiz_passed) || {}).id;
    const withAudio = subs.filter(s => s.audio_url).length;
    app.innerHTML = bar('#/', d.topic.title_it) + `
      <h1>${h(d.topic.title_en)}${d.mastered ? '<span class="badge green">mastered</span>' : ''}</h1>
      <p class="muted">${subs.filter(s => s.quiz_passed).length} of ${subs.length} stops passed. Stops unlock in order as you pass each quiz.</p>
      <div class="row">
        <button class="btn" data-go="#/topic-test/${tid}">Topic test</button>
        ${withAudio ? `<button class="btn" id="playall">Listen to all ${withAudio} stops</button>` : ''}
      </div>${gap(16)}
      <div class="road">${subs.map((s, i) => {
        const locked = isLocked(s.ord, i > 0 && subs[i - 1].quiz_passed);
        const cls = s.quiz_passed ? 'done' : s.lesson_done || s.review_done ? 'started' : '';
        const meta = [`${s.question_count} questions`, s.best_accuracy != null ? `best ${s.best_accuracy}%` : null, s.attempts > 1 ? `${s.attempts} tries` : null].filter(Boolean).join(' · ');
        return `<button class="node ${cls} ${locked ? 'locked' : ''} ${s.id === nextId && !locked ? 'next' : ''}" ${locked ? `data-locked="Pass stop ${s.ord - 1} first"` : `data-go="#/lesson/${s.id}"`}>
          <span class="dot">${s.quiz_passed ? '✓' : locked ? '🔒' : s.ord}</span>
          <div class="title">${h(s.title_en)}</div>
          <div class="sub">${h(s.title_it)} · ${meta}</div>
        </button>`; }).join('')}
      </div>`;
    const pa = document.getElementById('playall');
    if (pa) pa.onclick = () => startPlaylist(subs.filter(s => s.audio_url), d.topic.title_en);
  }

  // ---------- playlist mini-player ----------
  function startPlaylist(subs, title) {
    stopPlaylist();
    const audio = new Audio();
    let i = 0;
    const box = el(`<div id="player"><button id="pp">❚❚</button><div class="t"></div><button id="nx">⏭</button><button id="cl">✕</button></div>`);
    document.body.appendChild(box);
    const label = () => box.querySelector('.t').textContent = `${title} · ${i + 1}/${subs.length} · ${subs[i].title_en}`;
    const play = () => { if (i >= subs.length) return stopPlaylist(); audio.src = subs[i].audio_url; label(); audio.play(); };
    audio.onended = () => { post('/api/subtopic_progress', { subtopic_id: subs[i].id, lesson_done: true }); i++; play(); };
    audio.onplay = () => box.querySelector('#pp').textContent = '❚❚';
    audio.onpause = () => box.querySelector('#pp').textContent = '▶';
    box.querySelector('#pp').onclick = () => audio.paused ? audio.play() : audio.pause();
    box.querySelector('#nx').onclick = () => { i++; play(); };
    box.querySelector('#cl').onclick = stopPlaylist;
    state.playlist = { audio, box };
    play();
  }
  function stopPlaylist() {
    if (!state.playlist) return;
    state.playlist.audio.pause(); state.playlist.audio.src = '';
    state.playlist.box.remove(); state.playlist = null;
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
    if (isLocked(s.ord, d.prev_passed)) { app.innerHTML = lockedCard(d); return; }
    const terms = (d.terms || []).map(t => `<button data-say="${h(t.it)}"><span class="it">${h(t.it)}</span> — ${h(t.en)}${t.note ? `<div class="note">${h(t.note)}</div>` : ''}</button>`).join('');
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
      play.onclick = () => { if (audio.paused) { window.speechSynthesis?.cancel(); stopPlaylist(); audio.play(); } else audio.pause(); };
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
        <div class="statement">${highlight(q.q_it, q.trap_words)}</div>
        <div class="tools">
          <button class="btn small" data-say="${h(q.q_it)}">🔊 Listen</button>
          <label class="toggle"><input type="checkbox" id="hl" ${state.highlights ? 'checked' : ''}> highlight trap words</label>
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
        <div class="statement">${highlight(q.q_it, q.trap_words, true)}</div>
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
    if (isLocked(s.ord, d.prev_passed)) { app.innerHTML = lockedCard(d); return; }
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
        const item = el(`<div class="item"><div>${highlight(r.q.q_it, r.q.trap_words, true)} <span class="muted small">→ ${r.q.answer ? 'Vero' : 'Falso'}${r.given === null ? ' (skipped)' : ''}</span></div>
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

  // ---------- router ----------
  async function route() {
    if (!state.user) return askUser();
    if (!state.health) { try { state.health = await fetch('/api/health').then(r => r.json()); } catch (_) { state.health = {}; } }
    const [path, arg] = location.hash.replace(/^#\/?/, '').split('/');
    window.scrollTo(0, 0);
    window.speechSynthesis?.cancel();
    switch (path) {
      case '': return home();
      case 'topic': return topic(arg);
      case 'lesson': return lesson(arg);
      case 'review-stage': return reviewStage(arg);
      case 'quiz': return quiz(arg);
      case 'topic-test': return topicTest(arg);
      case 'repair': return repairView();
      case 'review': return reviewView();
      case 'words': return wordsView();
      case 'exam': return examView();
      case 'stats': return statsView();
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
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type !== 'api-updated') return;
      if (REDRAWABLE.includes(location.hash.replace(/^#\/?/, '').split('/')[0])) route();
    });
  }
})();
