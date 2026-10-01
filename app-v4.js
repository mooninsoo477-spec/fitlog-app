(() => {
  'use strict';

  const STATE_KEY = 'fitlog:dashboard:v3';
  const AI_KEY = 'fitlog-ai-settings';
  const SYNC_KEY = 'fitlog-sync';
  const aiReady = settings => Boolean(settings?.token || window.FitLogAuth?.signedIn());
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
  const pad = value => String(value).padStart(2, '0');
  const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const normalizeProjectUrl = value => String(value || '').trim().replace('woyrhbvvizsjgxtlaclq.supabase.co', 'woyrhbvvizsjgxtlaclg.supabase.co').replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedDate = dateKey(new Date());
  let photoData = null;
  let pendingMealItems = [];
  let editingMealId = null;

  function readState() {
    return parse(localStorage.getItem(STATE_KEY), { profile: {}, logs: {}, inbody: [] }) || { profile: {}, logs: {}, inbody: [] };
  }

  function writeState(state) {
    state.lastSaved = new Date().toISOString();
    const serialized = JSON.stringify(state);
    localStorage.setItem(STATE_KEY, serialized);
    try { window.dispatchEvent(new StorageEvent('storage', { key: STATE_KEY, newValue: serialized })); } catch { /* Older WebViews still keep the saved state. */ }
  }

  function migrateMonthlyLog() {
    const state = readState();
    let changed = false;
    for (const [key, monthly] of Object.entries(state.logs || {})) {
      if (!/^\d{4}-\d{2}$/.test(key) || !monthly || Array.isArray(monthly)) continue;
      for (const [day, log] of Object.entries(monthly)) {
        if (validDate(day) && !state.logs[day]) state.logs[day] = log;
      }
      delete state.logs[key];
      changed = true;
    }
    if (changed) writeState(state);
    return changed;
  }

  const icon = (name, color) => {
    const paths = {
      home: '<path d="M4 11.5 12 5l8 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-4v-5h-5v5h-4A1.5 1.5 0 0 1 4 18.5z"/>',
      workout: '<path d="M5 9v6m14-6v6M2.5 10.5v3m19-3v3M5 12h14"/>',
      report: '<path d="M5 19V9m7 10V5m7 14v-7"/><path d="m4 7 5-3 4 3 7-5"/>',
      more: '<circle cx="6" cy="7" r="1.5"/><circle cx="12" cy="7" r="1.5"/><circle cx="18" cy="7" r="1.5"/><path d="M5 12.5h14v6H5z"/>',
      plus: '<path d="M12 5v14M5 12h14"/>'
    };
    return `<span class="nav-bubble" style="--bubble:${color}"><svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg></span>`;
  };

  function refreshIcons() {
    const nav = $('.nav');
    if (!nav) return;
    const buttons = [...nav.querySelectorAll('button')];
    const specs = [
      ['home', '#ffe1d8', '오늘'], ['workout', '#d9f5e8', '운동'], ['plus', '#fff09c', '기록'],
      ['report', '#e5ddff', '리포트'], ['more', '#dcecff', '더보기']
    ];
    buttons.forEach((button, index) => {
      const [name, color, label] = specs[index];
      button.innerHTML = `${icon(name, color)}<span>${label}</span>`;
      button.setAttribute('aria-label', label);
    });
    const profileButton = $('.top [data-go="more"]');
    if (profileButton) profileButton.innerHTML = '<span aria-hidden="true">🐾</span>';
    const quick = $('.quick');
    if (quick) quick.innerHTML = `
      <button data-quick="meals"><span class="quick-icon peach">🍱</span><strong>식사</strong></button>
      <button data-quick="workout"><span class="quick-icon mint">🏃</span><strong>운동</strong></button>
      <button data-quick="more" data-open="inbodyPanel"><span class="quick-icon lilac">⚖️</span><strong>신체</strong></button>`;
  }

  function mascotMetrics() {
    const state = readState();
    const dates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - (6 - index));
      return dateKey(date);
    });
    const weekLogs = dates.map(date => state.logs?.[date] || null);
    const mealDays = weekLogs.filter(log => (log?.meals || []).length);
    const activeDays = weekLogs.filter(log => (log?.workouts || []).length).length;
    const avgKcal = mealDays.length ? Math.round(mealDays.reduce((sum, log) => sum + calories(log), 0) / mealDays.length) : 0;
    const targetKcal = +(state.profile?.targets?.kcal || 2200);
    const workoutGoal = +(state.profile?.workoutGoal || state.profile?.workoutDays || 5);
    const dataDays = weekLogs.filter(log => log && ((log.meals || []).length || (log.workouts || []).length)).length;
    const ratio = avgKcal ? avgKcal / targetKcal : 1;
    let level = 3;
    if (dataDays >= 3) {
      if (activeDays >= Math.max(4, workoutGoal - 1) && ratio <= 1.05) level = 5;
      else if (activeDays >= 3 && ratio <= 1.12) level = 4;
      else if (ratio > 1.28 && activeDays <= 1) level = 1;
      else if (ratio > 1.12 || activeDays < 2) level = 2;
    }
    return { level, avgKcal, activeDays, workoutGoal, dataDays, targetKcal };
  }

  function updateMascot() {
    const mascot = $('.welcome img');
    if (!mascot) return;
    const metrics = mascotMetrics();
    const states = {
      1: ['잠깐 재충전', '조금 쉬어가도 괜찮아요. 다음 한 번이면 표정이 달라져요!', '축 처져 앉아 있는 강아지'],
      2: ['몸이 조금 무거워요', '가볍게 한 번 움직이면 다시 신날 거예요.', '천천히 공을 따라 걷는 강아지'],
      3: ['균형을 잡는 중', '기록을 이어가며 내 페이스를 찾아가요.', '축구공 위에 발을 올린 강아지'],
      4: ['기세 좋은 러너', '식단과 운동 흐름이 좋아요. 한 단계만 더!', '공을 몰며 달리는 강아지'],
      5: ['불타는 질주', '이번 주 정말 뜨거워요. 공까지 날아가겠어요!', '불꽃과 함께 공을 차며 달리는 강아지']
    };
    const warmingUp = metrics.dataDays < 3;
    let [title, message, alt] = states[metrics.level];
    if (warmingUp) {
      title = `분석 준비 중 · ${metrics.dataDays}/3일`;
      message = metrics.dataDays ? `${3 - metrics.dataDays}일만 더 기록하면 컨디션을 읽어드릴게요.` : '식사나 운동을 3일 기록하면 컨디션을 읽어드릴게요.';
    }
    mascot.src = `fitlog-puppy-state-${metrics.level}.png`;
    mascot.alt = alt;
    const welcome = $('.welcome');
    welcome.className = welcome.className.replace(/\s*mascot-level-\d/g, '') + ` mascot-level-${metrics.level}`;
    let meter = $('#mascotMeter');
    if (!meter) {
      meter = document.createElement('section');
      meter.id = 'mascotMeter';
      meter.className = 'mascot-meter';
      welcome.insertAdjacentElement('afterend', meter);
    }
    const average = metrics.avgKcal ? `${metrics.avgKcal.toLocaleString()} kcal` : '–';
    const levels = warmingUp
      ? `<div class="mascot-levels warmup" aria-label="3일 중 ${metrics.dataDays}일 기록">${[1, 2, 3].map(day => `<i class="${day <= metrics.dataDays ? 'on' : ''}"></i>`).join('')}</div>`
      : `<div class="mascot-levels" aria-label="5단계 중 ${metrics.level}단계">${[1, 2, 3, 4, 5].map(level => `<i class="${level <= metrics.level ? 'on' : ''}"></i>`).join('')}</div>`;
    meter.innerHTML = `
      <div class="mascot-meter-head"><span>최근 7일 컨디션</span><strong>${title}</strong></div>
      ${levels}
      <p>${message}</p>
      <div class="mascot-stats"><span><b>${average}</b>평균 섭취</span><span><b>${metrics.activeDays}일</b>운동 완료</span><span><b>${metrics.dataDays}일</b>기록 반영</span></div>`;
  }

  function calories(log) {
    return (log?.meals || []).reduce((sum, meal) => sum + (+meal.kcal || 0), 0);
  }

  // ---- 운동 기록 해석: "티바로우 30kg 20 40kg 14/14/14/14" → 세트 목록 ----
  const RPE_LABELS = { 5: '여유 많음', 6: '4회 이상 더 가능', 7: '2~3회 더 가능', 8: '1~2회 더 가능', 9: '1회 더 가능', 10: '한계까지' };
  const CONDITIONS = { 1: ['😫', '나쁨'], 2: ['😕', '별로'], 3: ['🙂', '보통'], 4: ['😊', '좋음'], 5: ['🔥', '최고'] };
  const CARDIO_METS = [[/축구|풋살/, 7], [/러닝|달리기|조깅|run/i, 8.3], [/걷기|산책|walk/i, 3.5], [/사이클|자전거|스피닝|bike/i, 7], [/수영|swim/i, 7], [/줄넘기/, 11], [/등산|하이킹/, 6.5], [/인터벌|hiit|서킷/i, 8], [/계단|스텝밀|천국의/, 8], [/로잉|rowing/i, 7]];
  const BODY_PARTS = [
    ['코어', /플랭크|크런치|복근|레그\s*레이즈|싯업|윗몸|러시안|행잉|ab\s*롤|코어/i],
    ['하체', /스쿼트|레그|런지|힙|카프|글루트|핵|스텝업|루마니안|굿모닝|어덕션|앱덕션|하체/],
    ['가슴', /벤치|체스트|푸쉬업|푸시업|팔굽|딥스|플라이|펙덱|크로스오버|가슴/],
    ['등', /로우|풀다운|풀업|턱걸이|랫|데드|친업|풀오버|하이퍼|백\s*익스|등/],
    ['어깨', /숄더|오버헤드|밀리터리|레터럴|사이드|리어|페이스\s*풀|업라이트|프론트|아놀드|어깨/],
    ['팔', /컬|이두|삼두|트라이셉|푸쉬다운|푸시다운|해머|스컬|킥백|팔/]
  ];
  const PART_ORDER = ['가슴', '등', '어깨', '하체', '팔', '코어'];
  const exerciseKey = name => String(name || '').replace(/\s+/g, '').toLowerCase();
  const round5 = value => Math.round(value / 5) * 5;

  function cardioMet(name) {
    return CARDIO_METS.find(([pattern]) => pattern.test(name || ''))?.[1] || 0;
  }

  function exercisePart(name, group = '') {
    const found = BODY_PARTS.find(([, pattern]) => pattern.test(name || ''));
    if (found) return found[0];
    if (/밀기/.test(group)) return '가슴';
    if (/당기기/.test(group)) return '등';
    if (/하체/.test(group)) return '하체';
    return '기타';
  }

  function parseSetSpec(spec, weight) {
    const text = spec.replace(/[()]/g, ' ').trim();
    if (!text) return [];
    const repeat = (reps, sets) => Array.from({ length: Math.min(20, Math.max(1, sets)) }, () => ({ weight, reps }));
    const cross = text.match(/(\d+)\s*회?\s*[x×*]\s*(\d+)/i);
    if (cross) return repeat(+cross[1], +cross[2]);
    const setCount = text.match(/(\d+)\s*(?:세트|sets?)/i);
    if (setCount) {
      const reps = text.replace(setCount[0], ' ').match(/(\d+)/);
      return repeat(reps ? +reps[1] : 0, +setCount[1]);
    }
    return (text.match(/\d+/g) || []).slice(0, 20).map(value => ({ weight, reps: +value }));
  }

  function parseWorkoutLine(line, group) {
    const first = line.search(/\d/);
    const name = (first < 0 ? line : line.slice(0, first)).replace(/[:\-–·]+\s*$/, '').trim() || line.trim();
    let rest = first < 0 ? '' : line.slice(first);
    let minutes = 0;
    rest = rest.replace(/(\d+(?:\.\d+)?)\s*(km|킬로미터)/gi, ' ');
    rest = rest.replace(/(\d+(?:\.\d+)?)\s*(시간|분|mins?|minutes?)/gi, (_, value, unit) => { minutes += /시간/.test(unit) ? +value * 60 : +value; return ' '; });
    const tokens = [...rest.matchAll(/(\d+(?:\.\d+)?)\s*(kg|키로|킬로|lbs?|파운드)/gi)];
    let setList = [];
    if (!tokens.length) setList = parseSetSpec(rest, 0);
    tokens.forEach((token, index) => {
      const weight = Math.round((/lb|파운드/i.test(token[2]) ? +token[1] * 0.4536 : +token[1]) * 10) / 10;
      const start = token.index + token[0].length;
      const sets = parseSetSpec(rest.slice(start, tokens[index + 1]?.index ?? rest.length), weight);
      setList.push(...(sets.length ? sets : [{ weight, reps: 0 }]));
    });
    setList = setList.filter(set => set.reps > 0 || set.weight > 0);
    const top = setList.reduce((best, set) => (set.weight > best.weight || (set.weight === best.weight && set.reps > best.reps) ? set : best), { weight: 0, reps: 0 });
    const cardio = !setList.length && (minutes > 0 || cardioMet(name) > 0);
    return {
      name, weight: top.weight, reps: top.reps, sets: setList.length, setList,
      volume: Math.round(setList.reduce((sum, set) => sum + set.weight * set.reps, 0)),
      minutes: Math.round(minutes), cardio, part: cardio ? '유산소' : exercisePart(name, group)
    };
  }

  function parseWorkoutText(text, group = '') {
    return String(text || '').replace(/(\d)\s*,\s*(?=\d)/g, '$1/').split(/\n|;|,/).map(line => line.trim()).filter(Boolean).map(line => parseWorkoutLine(line, group));
  }

  // 예전 기록(세트 수만 있는 형식, 메모만 있는 형식)도 같은 구조로 맞춘다.
  function normalizeExercise(raw, group = '') {
    const setList = Array.isArray(raw.setList) && raw.setList.length ? raw.setList
      : raw.sets > 0 ? Array.from({ length: Math.min(20, +raw.sets) }, () => ({ weight: +raw.weight || 0, reps: +raw.reps || 0 })) : [];
    const volume = +raw.volume || Math.round(setList.reduce((sum, set) => sum + set.weight * set.reps, 0));
    return { ...raw, setList, sets: setList.length, volume, part: raw.part || (raw.cardio ? '유산소' : exercisePart(raw.name, group)) };
  }

  function workoutExercises(workout) {
    const group = workout.group || workout.type || '';
    if (Array.isArray(workout.exercises) && workout.exercises.length) return workout.exercises.map(item => normalizeExercise(item, group));
    return parseWorkoutText(workout.note || '', group);
  }

  function setSummary(exercise) {
    if (exercise.cardio || !exercise.setList?.length) return exercise.minutes ? `${exercise.minutes}분` : '기록만';
    const groups = [];
    exercise.setList.forEach(set => {
      const last = groups.at(-1);
      if (last && last.weight === set.weight) last.reps.push(set.reps); else groups.push({ weight: set.weight, reps: [set.reps] });
    });
    const text = groups.map(item => {
      const same = item.reps.every(rep => rep === item.reps[0]);
      const reps = same ? `${item.reps[0]}회${item.reps.length > 1 ? ` × ${item.reps.length}` : ''}` : `${item.reps.join('/')}회`;
      return item.weight ? `${item.weight}kg ${reps}` : reps;
    }).join(' · ');
    return exercise.minutes ? `${text} · ${exercise.minutes}분` : text;
  }

  function latestBodyWeight(state) {
    const dates = Object.keys(state.logs || {}).sort().reverse();
    for (const date of dates) if (+state.logs[date]?.weight > 20) return +state.logs[date].weight;
    const inbody = (state.inbody || []).filter(item => !item.excluded && +item.weight > 0).sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1);
    return +inbody?.weight || +state.profile?.recommendationContext?.weight || 70;
  }

  // MET × 체중 × 시간. 근력은 세트당 약 2.5분(수행+휴식), RPE가 높을수록 MET를 올린다.
  function estimateWorkout(exercises, { minutes = 0, rpe = null, groups = [], manualCardioKcal = 0, bodyWeight = 70 } = {}) {
    const strengthSets = exercises.filter(item => !item.cardio).reduce((sum, item) => sum + (item.sets || 0), 0);
    const cardioLines = exercises.filter(item => item.cardio);
    const cardioGroup = groups.some(group => /유산소|축구/.test(group));
    let cardioMin = cardioLines.reduce((sum, item) => sum + (item.minutes || 0), 0);
    let strengthMin = strengthSets * 2.5;
    if (minutes > 0) {
      if (!strengthSets && !cardioMin && cardioGroup) cardioMin = minutes;
      strengthMin = strengthSets || !cardioMin ? Math.max(0, minutes - cardioMin) : 0;
    }
    const strengthMet = rpe ? 3 + rpe * 0.3 : 5;
    const strengthKcal = strengthMet * bodyWeight * strengthMin / 60;
    let cardioKcal = cardioLines.reduce((sum, item) => sum + (cardioMet(item.name) || 6) * bodyWeight * (item.minutes || 0) / 60, 0);
    if (!cardioLines.some(item => item.minutes) && cardioMin) cardioKcal = (cardioMet(groups.join(' ')) || 7) * bodyWeight * cardioMin / 60;
    if (manualCardioKcal > 0) cardioKcal = manualCardioKcal;
    return {
      kcal: round5(strengthKcal + cardioKcal), strengthKcal: round5(strengthKcal), cardioKcal: round5(cardioKcal),
      minutes: Math.round(strengthMin + cardioMin), estimatedTime: !(minutes > 0), strengthSets, bodyWeight
    };
  }

  function exerciseHistory(state, uptoDate, excludeId) {
    const map = new Map();
    Object.keys(state.logs || {}).filter(validDate).sort().forEach(date => {
      if (date > uptoDate) return;
      (state.logs[date].workouts || []).forEach(workout => {
        if (workout.id === excludeId) return;
        workoutExercises(workout).forEach(exercise => {
          if (exercise.cardio || !exercise.sets) return;
          const key = exerciseKey(exercise.name);
          if (!map.has(key)) map.set(key, []);
          map.get(key).push({ date, rpe: workout.rpe, ...exercise });
        });
      });
    });
    return map;
  }

  function exerciseProgress(exercise, history) {
    if (exercise.cardio || !exercise.sets) return null;
    const past = history.get(exerciseKey(exercise.name)) || [];
    if (!past.length) return { first: true };
    const prev = past.at(-1);
    const totalReps = item => (item.setList || []).reduce((sum, set) => sum + set.reps, 0);
    const bestWeight = Math.max(...past.map(item => +item.weight || 0));
    return {
      prevDate: prev.date,
      weightDiff: Math.round(((+exercise.weight || 0) - (+prev.weight || 0)) * 10) / 10,
      volumePct: prev.volume > 0 && exercise.volume > 0 ? Math.round((exercise.volume - prev.volume) / prev.volume * 100) : null,
      repsDiff: !exercise.weight && !prev.weight ? totalReps(exercise) - totalReps(prev) : null,
      pr: exercise.weight > 0 && exercise.weight > bestWeight
    };
  }

  function progressBadges(progress) {
    if (!progress) return '';
    if (progress.first) return '<i class="badge">첫 기록</i>';
    const badges = [];
    if (progress.pr) badges.push('<i class="badge pr">🏆 PR</i>');
    if (progress.weightDiff) badges.push(`<i class="badge ${progress.weightDiff > 0 ? 'up' : 'down'}">${progress.weightDiff > 0 ? '+' : ''}${progress.weightDiff}kg ${progress.weightDiff > 0 ? '↑' : '↓'}</i>`);
    if (progress.volumePct) badges.push(`<i class="badge ${progress.volumePct > 0 ? 'up' : 'down'}">볼륨 ${progress.volumePct > 0 ? '+' : ''}${progress.volumePct}%</i>`);
    if (progress.repsDiff) badges.push(`<i class="badge ${progress.repsDiff > 0 ? 'up' : 'down'}">${progress.repsDiff > 0 ? '+' : ''}${progress.repsDiff}회</i>`);
    if (!badges.length) badges.push('<i class="badge">지난번과 동일</i>');
    return badges.join('');
  }

  const conditionText = value => CONDITIONS[value] ? `${CONDITIONS[value][0]} ${CONDITIONS[value][1]}` : (value ? String(value) : '');
  const addDays = (key, days) => { const date = new Date(`${key}T12:00:00`); date.setDate(date.getDate() + days); return dateKey(date); };
  const mondayKey = (date = new Date()) => dateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7)));
  const weekdayName = key => ['일', '월', '화', '수', '목', '금', '토'][new Date(`${key}T12:00:00`).getDay()];

  // ---- AI에 넘길 기록 요약 ----
  function recentLogText(state, days = 14, endKey = dateKey(new Date())) {
    const lines = [];
    for (let offset = days - 1; offset >= 0; offset--) {
      const date = addDays(endKey, -offset);
      const log = state.logs?.[date];
      if (!log) continue;
      const parts = [];
      if (+log.weight) parts.push(`공복 ${log.weight}kg`);
      if (+log.sleep) parts.push(`수면 ${log.sleep}h`);
      if (log.condition) parts.push(`컨디션 ${CONDITIONS[log.condition]?.[1] || log.condition}`);
      const meals = log.meals || [];
      if (meals.length) parts.push(`섭취 ${Math.round(calories(log))}kcal·단백질 ${Math.round(meals.reduce((sum, meal) => sum + (+meal.protein || 0), 0))}g`);
      (log.workouts || []).forEach(workout => {
        const exercises = workoutExercises(workout).map(item => `${item.name} ${setSummary(item)}`).join(', ');
        parts.push(`운동[${workout.group || '운동'}] ${exercises || workout.note || ''}${workout.minutes ? ` ${workout.minutes}분` : ''}${workout.rpe ? ` RPE${workout.rpe}` : ''}${workout.burnKcal ? ` 소모${workout.burnKcal}kcal` : ''}${workout.comment ? ` 메모:"${workout.comment}"` : ''}`);
      });
      if (parts.length) lines.push(`${date.slice(5)}(${weekdayName(date)}) ${parts.join(' / ')}`);
    }
    return lines.join('\n') || '기록 없음';
  }

  function exerciseHistoryText(state, sessions = 3) {
    const history = exerciseHistory(state, dateKey(new Date()));
    return [...history.values()].map(items => {
      const recent = items.slice(-sessions);
      return `${recent[0].name}: ${recent.map(item => `${item.date.slice(5)} ${setSummary(item)}${item.rpe ? ` RPE${item.rpe}` : ''}`).join(' | ')}`;
    }).slice(0, 25).join('\n') || '종목 기록 없음';
  }

  function partSets(state, endKey = dateKey(new Date()), days = 7) {
    const sets = Object.fromEntries(PART_ORDER.map(part => [part, 0]));
    for (let offset = 0; offset < days; offset++) {
      (state.logs?.[addDays(endKey, -offset)]?.workouts || []).forEach(workout => workoutExercises(workout).forEach(exercise => {
        if (!exercise.cardio && exercise.part in sets) sets[exercise.part] += exercise.sets || 0;
      }));
    }
    return sets;
  }

  function weeklyMetrics(state, endKey = dateKey(new Date()), days = 7) {
    const dates = Array.from({ length: days }, (_, index) => addDays(endKey, index - days + 1));
    const prevDates = dates.map(date => addDays(date, -days));
    const logs = dates.map(date => state.logs?.[date] || {});
    const volumeOf = list => list.reduce((sum, date) => sum + (state.logs?.[date]?.workouts || []).reduce((acc, workout) => acc + workoutVolume(workout), 0), 0);
    const mealLogs = logs.filter(log => (log.meals || []).length);
    const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const targets = state.profile?.targets || { kcal: 2200, protein: 153 };
    const weights = dates.map(date => +state.logs?.[date]?.weight).filter(value => value > 20);
    const plans = [state.profile?.weeklyPlan, ...(state.profile?.planHistory || [])].filter(Boolean);
    const plannedDays = dates.filter(date => date < dateKey(new Date()) || date === endKey).map(date => plans.map(plan => (plan.days || []).find(day => day.date === date)).find(Boolean)).filter(day => day && !day.rest);
    const volume = volumeOf(dates);
    const prevVolume = volumeOf(prevDates);
    const workouts = logs.flatMap(log => log.workouts || []);
    return {
      start: dates[0], end: endKey,
      workoutDays: logs.filter(log => (log.workouts || []).length).length,
      goal: +(state.profile?.workoutGoal || 4),
      planned: plannedDays.length,
      plannedDone: plannedDays.filter(day => (state.logs?.[day.date]?.workouts || []).length).length,
      volume, prevVolume, volumeChange: prevVolume > 0 ? Math.round((volume - prevVolume) / prevVolume * 100) : null,
      burnKcal: workouts.reduce((sum, workout) => sum + (+workout.burnKcal || 0), 0),
      rpe: average(workouts.map(workout => +workout.rpe).filter(Boolean)),
      mealDays: mealLogs.length,
      kcal: average(mealLogs.map(log => calories(log))),
      protein: average(mealLogs.map(log => (log.meals || []).reduce((sum, meal) => sum + (+meal.protein || 0), 0))),
      kcalTarget: +targets.kcal || 2200, proteinTarget: +targets.protein || 150,
      sleep: average(logs.map(log => +log.sleep).filter(Boolean)),
      condition: average(logs.map(log => +log.condition).filter(Boolean)),
      weightStart: weights[0] ?? null, weightEnd: weights.at(-1) ?? null,
      parts: partSets(state, endKey, days),
      legRule: trainingRules(state).legs
    };
  }

  function metricsText(metrics) {
    const fixed = (value, digits = 0) => value == null ? '기록 없음' : Number(value).toFixed(digits);
    return [
      `기간 ${metrics.start}~${metrics.end}`,
      `운동 ${metrics.workoutDays}일(목표 주 ${metrics.goal}회${metrics.planned ? `, 계획 ${metrics.planned}회 중 ${metrics.plannedDone}회 수행` : ''})`,
      `총 볼륨 ${Math.round(metrics.volume)}kg(지난주 ${Math.round(metrics.prevVolume)}kg${metrics.volumeChange != null ? `, ${metrics.volumeChange > 0 ? '+' : ''}${metrics.volumeChange}%` : ''})`,
      `운동 소모 ${metrics.burnKcal}kcal, 평균 RPE ${fixed(metrics.rpe, 1)}`,
      `식단 기록 ${metrics.mealDays}일, 평균 섭취 ${fixed(metrics.kcal)}kcal(목표 ${metrics.kcalTarget}), 평균 단백질 ${fixed(metrics.protein)}g(목표 ${metrics.proteinTarget})`,
      `평균 수면 ${fixed(metrics.sleep, 1)}h, 평균 컨디션 ${fixed(metrics.condition, 1)}/5`,
      `공복 체중 ${metrics.weightStart ?? '기록 없음'}→${metrics.weightEnd ?? '기록 없음'}kg`,
      `부위별 세트 ${PART_ORDER.map(part => `${part}${metrics.parts[part]}`).join(' ')}`
    ].join('\n');
  }

  function updatePlanHero() {
    const hero = $('.hero');
    if (!hero) return;
    const state = readState();
    const info = state.profile?.recommendationContext || {};
    const goal = info.goalStatement || info.goal || '';
    if (!goal && !state.profile?.targetUpdatedAt && !currentPlan(state)) {
      hero.className = 'hero onboard';
      hero.innerHTML = `<span class="tag">시작하기</span><h2>나에게 맞는 목표부터 정해요</h2>
        <ol><li>키·체중 같은 기본 정보</li><li>원하는 변화를 내 말로 한 줄</li><li>운동 가능한 요일과 시간</li></ol>
        <div class="hero-actions"><button class="primary" data-go="more" data-open="recommendationProfile">목표 설정하기</button><button class="ghost" data-go="workout">먼저 기록해보기</button></div>`;
      return;
    }
    const today = dateKey(new Date());
    const weeklyGoal = +(state.profile?.workoutGoal || 4);
    const monday = mondayKey();
    let doneDays = 0;
    for (let key = monday; key <= today; key = addDays(key, 1)) if ((state.logs?.[key]?.workouts || []).length) doneDays++;
    const todayWorkouts = state.logs?.[today]?.workouts || [];
    const burned = todayWorkouts.reduce((sum, workout) => sum + (+workout.burnKcal || 0), 0);
    const volume = todayWorkouts.reduce((sum, workout) => sum + workoutVolume(workout), 0);
    const day = planDay(state, today);
    const nextDay = (currentPlan(state)?.days || []).find(item => item.date > today && !item.rest);
    const progress = `<div class="hero-progress"><div class="track"><i style="width:${Math.min(100, doneDays / Math.max(1, weeklyGoal) * 100)}%"></i></div><b>이번 주 ${doneDays}/${weeklyGoal}회</b></div>`;
    hero.className = 'hero';
    if (todayWorkouts.length) {
      hero.innerHTML = `<span class="tag">오늘 운동 완료 ✓</span>
        <h2>${burned ? `약 ${burned.toLocaleString()}kcal 소모` : '오늘도 해냈어요'}</h2>
        <p>${[volume ? `총 볼륨 ${Math.round(volume).toLocaleString()}kg` : '', nextDay ? `다음 운동 ${weekdayName(nextDay.date)}요일 · ${nextDay.focus}` : '충분히 먹고 푹 자는 것도 훈련이에요.'].filter(Boolean).join(' · ')}</p>
        ${progress}<div class="hero-actions"><button class="ghost" data-go="workout">기록 보기</button></div>`;
    } else if (day && !day.rest) {
      hero.innerHTML = `<span class="tag">오늘의 운동 · ${esc(shortFocus(day))}</span>
        <h2>${esc(day.focus)}</h2>
        <ul class="hero-list">${day.exercises.slice(0, 3).map(exercise => `<li><span>${esc(exercise.name)}</span><b>${exercise.weight ? `${exercise.weight}kg · ` : ''}${esc(exercise.reps)}회 × ${exercise.sets}</b></li>`).join('')}${day.exercises.length > 3 ? `<li class="more">외 ${day.exercises.length - 3}종목</li>` : ''}</ul>
        ${progress}<div class="hero-actions"><button class="primary" data-plan-action="log" data-date="${today}">이 계획으로 기록하기</button><button class="ghost" data-go="workout">전체 계획</button></div>`;
    } else if (day?.rest) {
      hero.innerHTML = `<span class="tag">오늘은 회복일</span><h2>쉬는 것도 계획의 일부예요</h2><p>${esc(day.tip || '가벼운 걷기와 스트레칭으로 회복해요.')}</p>
        ${progress}<div class="hero-actions"><button class="ghost" data-go="workout">그래도 운동 기록하기</button></div>`;
    } else {
      hero.innerHTML = `<span class="tag">AI 코치 · ${esc(state.profile?.trainingIntensity || '중간')} 강도</span><h2>이번 주 ${doneDays}회 완료</h2>
        <p>AI 주간 계획을 받으면 오늘 할 종목과 무게를 알려드려요.</p>
        ${progress}<div class="hero-actions">${planBusy ? '<button class="primary" disabled>계획을 짜는 중…</button>' : '<button class="primary" data-plan-action="week">이번 주 계획 받기</button>'}<button class="ghost" data-go="workout">운동 기록</button></div>`;
    }
  }

  function removeLegacyDemoMeals() {
    const state = readState();
    let changed = false;
    Object.values(state.logs || {}).forEach(log => {
      const meals = log?.meals || [];
      const cleaned = meals.filter(item => !(
        (item.id === 'a' && item.name === '계란 3개, 햇반 1/2' && +item.kcal === 480) ||
        (item.id === 'b' && item.name === '나물비빔밥, 쇠고기무국' && +item.kcal === 710)
      ));
      if (cleaned.length !== meals.length) {
        log.meals = cleaned;
        changed = true;
      }
    });
    if (changed) writeState(state);
    return changed;
  }

  const FOOD_EMOJIS = [
    [/갈비|고기|소고기|돼지|삼겹|스테이크|불고기|제육|돈까스/, ['🍖', '🥩']],
    [/닭|치킨|닭가슴살/, ['🍗', '🐔']],
    [/생선|연어|고등어|참치|회|초밥/, ['🐟', '🍣']],
    [/국수|면|라면|파스타|우동|냉면/, ['🍜', '🍝']],
    [/밥|비빔밥|볶음밥|덮밥|죽/, ['🍚', '🍛']],
    [/김밥/, ['🍙', '🍘']],
    [/계란|달걀|오믈렛/, ['🍳', '🥚']],
    [/샐러드|나물|채소|야채|브로콜리/, ['🥗', '🥦']],
    [/국|탕|찌개|전골/, ['🍲', '🥘']],
    [/빵|토스트|샌드위치|베이글/, ['🍞', '🥪']],
    [/과일|사과|바나나|딸기|귤|포도/, ['🍎', '🍌', '🍓']],
    [/커피|라떼|음료|주스/, ['☕', '🥤']],
    [/간식|과자|쿠키|케이크|초콜릿/, ['🍪', '🍰', '🍫']]
  ];

  function stablePick(list, seed) {
    const score = [...String(seed || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return list[score % list.length];
  }

  function mealEmoji(items, mealType) {
    const ordered = [...items].sort((a, b) => (+b.kcal || 0) - (+a.kcal || 0));
    const names = ordered.map(item => item.name || '').join(' ');
    for (const [pattern, choices] of FOOD_EMOJIS) {
      const match = ordered.find(item => pattern.test(String(item.name || '')));
      if (match) return stablePick(choices, `${mealType}-${match.name}-${match.kcal}`);
    }
    return stablePick(mealType === '간식' ? ['🍎', '🥛', '🍪'] : ['🍽️', '🥣', '🍱'], `${mealType}-${names}`);
  }

  function groupedMeals(meals) {
    return ['아침', '점심', '저녁', '간식'].map(meal => ({ meal, items: meals.filter(item => item.meal === meal) })).filter(group => group.items.length);
  }

  function renderGroupedMeals() {
    const state = readState();
    const today = dateKey(new Date());
    const meals = state.logs?.[today]?.meals || [];
    const groups = groupedMeals(meals);
    const signature = meals.map(item => `${item.id}:${item.meal}:${item.name}:${item.kcal}`).join('|') || 'empty';
    const preview = $('#mealPreview');
    const list = $('#mealList');
    if (preview) {
      const markup = groups.length ? groups.map(group => {
        const kcal = group.items.reduce((sum, item) => sum + (+item.kcal || 0), 0);
        const protein = group.items.reduce((sum, item) => sum + (+item.protein || 0), 0);
        return `<button class="meal-row meal-group-row" data-go="meals"><span class="meal-emoji" aria-hidden="true">${mealEmoji(group.items, group.meal)}</span><span><strong>${esc(group.meal)}</strong><span>${esc(group.items.map(item => item.name).join(' · '))}</span><small>단백질 ${Math.round(protein)}g</small></span><em><b class="kcal-value">${Math.round(kcal).toLocaleString()}</b> kcal</em></button>`;
      }).join('') : `<button class="meal-row" data-go="meals"><span class="meal-emoji" aria-hidden="true">🍽️</span><span><strong>아직 기록이 없어요</strong><span>눌러서 식사를 추가하세요</span></span><em>＋</em></button>`;
      if (preview.dataset.mealSignature !== signature || !preview.querySelector('.meal-emoji')) {
        preview.dataset.mealSignature = signature;
        preview.innerHTML = markup;
      }
    }
    if (list) {
      const markup = groups.length ? groups.map(group => {
        const kcal = group.items.reduce((sum, item) => sum + (+item.kcal || 0), 0);
        return `<section class="meal-group"><header><span class="meal-emoji small" aria-hidden="true">${mealEmoji(group.items, group.meal)}</span><div><strong>${esc(group.meal)}</strong><span>${group.items.length}가지 음식</span></div><em><b class="kcal-value">${Math.round(kcal).toLocaleString()}</b> kcal</em></header><div class="meal-group-items">${group.items.map(item => `<article><div><strong>${esc(item.name)}</strong><span>${esc(item.amount || item.referenceAmount || '')} · 단백질 ${Math.round(+item.protein || 0)}g · 탄수 ${Math.round(+item.carbs || 0)}g · 지방 ${Math.round(+item.fat || 0)}g</span></div><b class="item-kcal">${Math.round(+item.kcal || 0)} kcal</b><button type="button" class="edit-meal" data-edit-meal="${esc(item.id)}">수정</button><button type="button" class="delete" data-del-meal="${esc(item.id)}">삭제</button></article>`).join('')}</div></section>`;
      }).join('') : '<div class="item"><div><strong>오늘의 식사를 추가해 주세요</strong><span>편하게 적으면 AI가 음식별로 나눠 계산해요.</span></div></div>';
      if (list.dataset.mealSignature !== signature || (groups.length ? !list.querySelector('.meal-group') : !list.querySelector('.item'))) {
        list.dataset.mealSignature = signature;
        list.innerHTML = markup;
      }
    }
  }

  function activityRing(log, target) {
    const kcal = calories(log);
    const kcalProgress = Math.min(100, Math.round(kcal / Math.max(1, target) * 100));
    const mealProgress = Math.min(100, (log?.meals || []).length * 25);
    const workoutProgress = (log?.workouts || []).length ? 100 : 0;
    return `<span class="activity-ring" style="--kcal:${kcalProgress * 3.6}deg;--meal:${mealProgress * 3.6}deg;--move:${workoutProgress * 3.6}deg"><i></i></span>`;
  }

  function renderCalendar() {
    const grid = $('#archiveCalendar');
    if (!grid) return;
    const state = readState();
    const logs = state.logs || {};
    const target = +(state.profile?.targets?.kcal || 2200);
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    $('#calendarTitle').textContent = `${year}년 ${month + 1}월`;
    const firstDay = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    const today = dateKey(new Date());
    const cells = [];
    for (let index = 0; index < firstDay; index++) cells.push('<span class="calendar-empty"></span>');
    for (let day = 1; day <= count; day++) {
      const key = `${year}-${pad(month + 1)}-${pad(day)}`;
      const log = logs[key];
      const hasData = Boolean(log && ((log.meals || []).length || (log.workouts || []).length || log.weight || log.bodyFat || log.sleep));
      cells.push(`<button class="calendar-day ${key === today ? 'today' : ''} ${key === selectedDate ? 'selected' : ''} ${hasData ? 'has-data' : ''}" data-calendar-date="${key}"><span>${day}</span>${hasData ? activityRing(log, target) : '<i class="empty-dot"></i>'}</button>`);
    }
    grid.innerHTML = cells.join('');
    renderDaySummary();
  }

  function renderDaySummary() {
    const target = $('#daySummary');
    if (!target) return;
    const state = readState();
    const log = state.logs?.[selectedDate];
    const pretty = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${selectedDate}T12:00:00`));
    if (!log) {
      target.innerHTML = `<div class="summary-empty"><strong>${pretty}</strong><span>아직 기록이 없어요.</span></div>`;
      return;
    }
    // 예전 운동 기록에 id가 없으면 붙여서 수정·삭제할 수 있게 한다.
    if ((log.workouts || []).some(workout => !workout.id)) { log.workouts.forEach(workout => { workout.id ||= crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`; }); writeState(state); }
    const meals = log.meals || [];
    const workouts = log.workouts || [];
    const kcal = Math.round(calories(log));
    const mealGroups = ['아침', '점심', '저녁', '간식'].map(group => {
      const names = meals.filter(item => item.meal === group).map(item => item.name).filter(Boolean);
      return names.length ? `<div><b>${group}</b><span>${esc(names.join(' · '))}</span></div>` : '';
    }).join('');
    const workoutBlocks = workouts.map(workout => {
      const history = exerciseHistory(state, selectedDate, workout.id);
      const exercises = workoutExercises(workout);
      const meta = [workout.minutes ? `${workout.minutesEstimated ? '약 ' : ''}${workout.minutes}분` : '', workout.rpe ? `RPE ${workout.rpe}` : '', workout.burnKcal ? `약 ${workout.burnKcal}kcal` : '', workoutVolume(workout) ? `볼륨 ${Math.round(workoutVolume(workout)).toLocaleString()}kg` : ''].filter(Boolean).join(' · ');
      return `<div class="day-workout"><b>${esc(workout.group || workout.type || '운동')}</b>${meta ? `<small>${meta}</small>` : ''}
        ${exercises.length ? `<ul>${exercises.map(exercise => `<li><span>${esc(exercise.name)} <em>${esc(setSummary(exercise))}</em></span><span class="badges">${progressBadges(exerciseProgress(exercise, history))}</span></li>`).join('')}</ul>` : `<p>${esc(workout.note || workout.name || '')}</p>`}
        ${workout.comment ? `<p class="day-comment">💬 ${esc(workout.comment)}</p>` : ''}
        <div class="day-workout-actions"><button type="button" class="link" data-workout-edit="${esc(workout.id)}">수정</button><button type="button" class="link danger" data-workout-del="${esc(workout.id)}">삭제</button></div></div>`;
    });
    const extras = [
      log.weight ? `공복 체중 ${log.weight}kg` : '', log.bodyFat ? `체지방 ${log.bodyFat}%` : '',
      log.sleep ? `수면 ${log.sleep}시간` : '', log.condition ? `컨디션 ${conditionText(log.condition)}` : '', log.stress ? `스트레스 ${log.stress}` : ''
    ].filter(Boolean);
    target.innerHTML = `
      <div class="summary-head"><div><span>${pretty}</span><strong>${kcal.toLocaleString()} kcal</strong></div><div class="summary-count"><span>🍽 ${meals.length}</span><span>🏃 ${workouts.length}</span></div></div>
      ${mealGroups ? `<section class="day-block"><h3>식단</h3>${mealGroups}</section>` : ''}
      ${workoutBlocks.length ? `<section class="day-block"><h3>운동</h3>${workoutBlocks.join('')}</section>` : ''}
      ${extras.length || log.workoutNote || log.eventNote ? `<section class="day-block"><h3>체크인·기타</h3><p>${esc([...extras, log.workoutNote, log.eventNote].filter(Boolean).join(' · '))}</p></section>` : ''}`;
  }

  let editingWorkout = null;

  function setWorkoutEditMode(info) {
    editingWorkout = info;
    const save = $('#saveWorkout');
    if (save) save.textContent = info ? '수정 저장' : '운동 저장';
    let banner = $('#workoutEditBanner');
    if (!info) { banner?.remove(); return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'workoutEditBanner';
      banner.className = 'edit-banner';
      $('#workoutForm')?.prepend(banner);
    }
    banner.innerHTML = `<span>✏️ ${shortDate(info.date)} 운동 기록 수정 중</span><button type="button" class="link" data-workout-edit-cancel>취소</button>`;
  }

  function startWorkoutEdit(date, id) {
    const state = readState();
    const workout = (state.logs?.[date]?.workouts || []).find(item => item.id === id);
    if (!workout) return;
    const exercises = workoutExercises(workout);
    $('#workoutNote').value = workout.note || exercises.map(exercise => exerciseLine(exercise)).join('\n');
    if ($('#workoutMinutes')) $('#workoutMinutes').value = workout.minutes && !workout.minutesEstimated ? workout.minutes : '';
    if ($('#workoutComment')) $('#workoutComment').value = workout.comment || '';
    if ($('#workoutKcal')) $('#workoutKcal').value = workout.kcal || '';
    setRpe(workout.rpe || null);
    setWorkoutEditMode({ date, id });
    renderWorkoutDraft();
    $('#workoutForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('기록을 불러왔어요. 고친 뒤 "수정 저장"을 눌러주세요.');
  }

  function installCalendar() {

    const legacy = $('#workoutList');
    if (!legacy || $('#calendarArchive')) return;
    legacy.classList.add('hidden');
    const heading = legacy.previousElementSibling?.querySelector('h2');
    if (heading) heading.textContent = '기록 보관함';
    const archive = document.createElement('section');
    archive.id = 'calendarArchive';
    archive.className = 'card calendar-card';
    archive.innerHTML = `
      <div class="calendar-head"><button type="button" id="prevMonth" aria-label="이전 달">‹</button><strong id="calendarTitle"></strong><button type="button" id="nextMonth" aria-label="다음 달">›</button></div>
      <div class="calendar-weekdays"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>
      <div class="calendar-grid" id="archiveCalendar"></div>
      <div class="ring-legend"><span><i class="red"></i>운동</span><span><i class="green"></i>식단</span><span><i class="orange"></i>칼로리</span></div>
      <div class="day-summary" id="daySummary"></div>`;
    legacy.insertAdjacentElement('afterend', archive);
    $('#prevMonth').onclick = () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1); renderCalendar(); };
    $('#nextMonth').onclick = () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1); renderCalendar(); };
    archive.addEventListener('click', event => {
      const editButton = event.target.closest('[data-workout-edit]');
      if (editButton) { startWorkoutEdit(selectedDate, editButton.dataset.workoutEdit); return; }
      const deleteButton = event.target.closest('[data-workout-del]');
      if (deleteButton) {
        if (!confirm('이 운동 기록을 삭제할까요?')) return;
        const state = readState();
        const log = state.logs?.[selectedDate];
        if (!log) return;
        log.workouts = (log.workouts || []).filter(workout => workout.id !== deleteButton.dataset.workoutDel);
        // 지운 기록은 여러 기기 동기화 때 되살아나지 않게 표시해 둔다.
        state.deletedIds = { ...(state.deletedIds || {}), [deleteButton.dataset.workoutDel]: new Date().toISOString() };
        writeState(state);
        window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
        renderCalendar();
        showToast('운동 기록을 삭제했어요.');
        return;
      }
      const button = event.target.closest('[data-calendar-date]');
      if (!button) return;
      selectedDate = button.dataset.calendarDate;
      renderCalendar();
    });
    renderCalendar();
  }

  function removeDuplicateArchive() {
    const panel = $('#syncPanel');
    if (!panel || panel.dataset.calendarMoved) return;
    const children = [...panel.children];
    const heading = children.find(el => el.classList.contains('section-head') && el.textContent.includes('기록 보관함'));
    if (heading?.nextElementSibling?.classList.contains('sync-card')) heading.nextElementSibling.remove();
    heading?.remove();
    panel.dataset.calendarMoved = 'true';
  }

  async function imagePayload(file) {
    if (!file) return null;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
    return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl };
  }

  function nutritionPrompt(mealType, text) {
    return `한국 식단의 실제 섭취량을 음식별로 분리해 분석한다. 입력에 음식이 여러 개면 절대 합쳐 이름을 만들지 말고 각각 별도 항목으로 반환한다. "밥 갈비 1/3"이면 밥과 갈비를 나누고 1/3은 갈비에 적용한다. 텍스트의 제품명·중량·개수를 사진보다 우선한다. 각 음식마다 급식 또는 일반 식사의 현실적인 추천 1인분 기준량과, 사용자가 먹은 양을 0.25 단위 servings로 추정한다. kcal과 영양소는 추천 1인분 기준값으로 반환한다. 끼니: ${mealType}. 기록: ${text || '사진만 제공'}.`;
  }

  function extractJson(text) {
    const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('AI 결과 형식을 읽지 못했어요.');
    return JSON.parse(cleaned.slice(start, end + 1));
  }

  async function analyzeWithAi(settings, prompt, mode = 'analyze', includeMealPhoto = true) {
    // 로그인했으면 계정 토큰으로, 아니면 예전처럼 기기에 저장한 AI 연결 토큰으로 부른다.
    const auth = window.FitLogAuth;
    const sync = auth ? auth.project() : parse(localStorage.getItem(SYNC_KEY), {}) || {};
    sync.url = normalizeProjectUrl(sync.url);
    if (!sync.url || !sync.key || !aiReady(settings)) throw new Error('더보기에서 이메일로 로그인해 주세요.');
    const headers = { 'Content-Type': 'application/json', apikey: sync.key };
    const jwt = auth?.signedIn() ? await auth.accessToken() : null;
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
    else if (!settings.token) throw new Error('로그인이 만료됐어요. 더보기에서 다시 로그인해 주세요.');
    else if (String(sync.key).startsWith('eyJ')) headers.Authorization = `Bearer ${sync.key}`;
    if (settings.token) headers['x-fitlog-token'] = settings.token;
    const functionName = settings.functionName || 'smart-endpoint';
    const projectOrigin = new URL(sync.url).origin;
    const endpoint = `${projectOrigin}/functions/v1/${encodeURIComponent(functionName)}`;
    const shouldAttachPhoto = includeMealPhoto && mode === 'analyze';
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mode,
          prompt,
          hasText: shouldAttachPhoto && Boolean($('#aiMealText')?.value.trim()),
          photo: shouldAttachPhoto && photoData ? { mimeType: photoData.mimeType, data: photoData.data } : null,
          model: settings.model || 'gpt-5.6-luna'
        })
      });
    } catch {
      throw new Error('AI 서버에 연결하지 못했어요. Supabase 함수 배포와 함수 이름을 확인해 주세요.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `GPT 분석에 실패했어요. (${response.status})`);
    return body;
  }

  const shortDate = value => {
    const parts = String(value || '').split('-');
    return parts.length === 3 ? `${+parts[1]}/${+parts[2]}` : String(value || '').slice(5).replace('-', '/');
  };

  function svgEmpty(message, hint = '기록을 추가하면 최근 10회 흐름이 자동으로 나타나요.', action = '') {
    return `<div class="chart-empty"><span aria-hidden="true">📊</span><strong>${message}</strong><small>${hint}</small>${action}</div>`;
  }

  // ---- 인바디 결과지형 신체 변화 ----
  const fatMassOf = record => +record.bodyFatMass || (+record.weight && +(record.pbf ?? record.bodyFat) ? Math.round(record.weight * (record.pbf ?? record.bodyFat) / 10) / 10 : null);
  const pbfOf = record => +(record.pbf ?? record.bodyFat) || null;

  // 변화 기록은 한 번에 한 지표만, 지표마다 자기 눈금으로 그린다.
  const BODY_METRICS = [
    { label: '체중', unit: 'kg', pick: record => +record.weight || null, good: 0, color: '#4f9be6' },
    { label: '골격근량', unit: 'kg', pick: record => +record.smm || null, good: 1, color: '#3fae84' },
    { label: '체지방량', unit: 'kg', pick: fatMassOf, good: -1, color: '#f07f62' },
    { label: '체지방률', unit: '%', pick: pbfOf, good: -1, color: '#e8923f' }
  ];
  let bodyMetricIndex = 0;

  function bodyTrend(records, metric) {
    const points = records.map((record, index) => ({ index, date: record.date, value: metric.pick(record) })).filter(point => point.value != null);
    if (points.length < 2) return `<p class="ib-trend-empty">${metric.label} 측정값이 2회 이상 있어야 변화를 보여드려요.</p>`;
    const values = points.map(point => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max((max - min) * .35, metric.unit === '%' ? .5 : .3);
    const lo = min - pad;
    const hi = max + pad;
    const left = 40; const right = 344; const top = 24; const bottom = 112;
    const inset = 14;
    const x = index => left + inset + index * (right - left - inset * 2) / (points.length - 1);
    const y = value => bottom - (value - lo) / (hi - lo) * (bottom - top);
    const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
    const ticks = [lo, (lo + hi) / 2, hi].map(value => `<line class="grid" x1="${left}" y1="${y(value)}" x2="${right}" y2="${y(value)}"/><text class="axis" x="${left - 6}" y="${y(value) + 3}" text-anchor="end">${value.toFixed(1)}</text>`).join('');
    const last = points.length - 1;
    const round = value => Math.round(value * 10) / 10;
    const delta = (from, to) => {
      const diff = round(to - from);
      const tone = !diff || !metric.good ? 'flat' : diff * metric.good > 0 ? 'good' : 'bad';
      return `<b class="${tone}">${diff > 0 ? '▲ +' : diff < 0 ? '▼ ' : ''}${diff === 0 ? '변화 없음' : `${diff}${metric.unit}`}</b>`;
    };
    const lowest = values.indexOf(min);
    const highest = values.indexOf(max);
    return `<svg class="chart ib-trend-chart" viewBox="0 0 360 134" role="img" aria-label="${metric.label} 변화">
        <defs><linearGradient id="trendFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${metric.color}" stop-opacity=".22"/><stop offset="1" stop-color="${metric.color}" stop-opacity="0"/></linearGradient></defs>
        ${ticks}
        <polygon points="${x(0)},${bottom} ${line} ${x(last)},${bottom}" fill="url(#trendFill)"/>
        <polyline points="${line}" fill="none" stroke="${metric.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${points.map((point, index) => {
          const isLast = index === last;
          const emphasis = isLast || index === lowest || index === highest || points.length <= 10;
          return `<circle cx="${x(index)}" cy="${y(point.value)}" r="${isLast ? 5 : 3.5}" fill="${isLast ? metric.color : '#fff'}" stroke="${metric.color}" stroke-width="2"><title>${point.date} ${point.value}${metric.unit}</title></circle>
            ${emphasis ? `<text x="${x(index)}" y="${y(point.value) - 9}" text-anchor="middle" class="trend-value ${isLast ? 'last' : ''}">${point.value}</text>` : ''}
            <text x="${x(index)}" y="${bottom + 16}" text-anchor="middle" class="${isLast ? 'trend-date last' : 'trend-date'}">${shortDate(point.date)}</text>`;
        }).join('')}
      </svg>
      <div class="ib-summary">
        <div><span>현재</span><strong>${points[last].value}<small>${metric.unit}</small></strong></div>
        <div><span>직전 대비 <em>${shortDate(points[last - 1].date)}</em></span>${delta(points[last - 1].value, points[last].value)}</div>
        <div><span>첫 측정 대비 <em>${shortDate(points[0].date)}</em></span>${delta(points[0].value, points[last].value)}</div>
      </div>`;
  }

  function bodyComposition(records, state) {
    if (!records.length) return svgEmpty('아직 인바디 기록이 없어요', '측정값을 입력하면 체중·골격근량·체지방을 결과지처럼 보여드려요.', '<button type="button" class="primary mint" data-go="more" data-open="inbodyPanel">인바디 입력하기</button>');
    const info = state.profile?.recommendationContext || {};
    const height = +(info.height || state.profile?.height) || 0;
    const sex = info.sex;
    const latest = records.at(-1);
    const first = records[0];
    const stdWeight = height ? 22 * (height / 100) ** 2 : 0;
    const pbfRange = sex === '여성' ? [18, 28] : sex === '남성' ? [10, 20] : [14, 24];
    const rows = [
      { label: '체중', unit: 'kg', value: +latest.weight || null, std: stdWeight, scale: [55, 205], normal: [85, 115], color: '#67aef2' },
      { label: '골격근량', unit: 'kg', value: +latest.smm || null, std: stdWeight * (sex === '여성' ? .415 : sex === '남성' ? .48 : .45), scale: [70, 170], normal: [90, 110], color: '#54bb93' },
      { label: '체지방량', unit: 'kg', value: fatMassOf(latest), std: stdWeight * (sex === '여성' ? .23 : sex === '남성' ? .15 : .19), scale: [40, 520], normal: [80, 160], color: '#ff9e82' }
    ];
    const bar = row => {
      if (row.value == null) return `<div class="ib-row"><span class="ib-label">${row.label}</span><div class="ib-track"></div><b class="ib-value">–</b></div>`;
      let fill = 0; let band = null; let status = '';
      if (row.std) {
        const percent = row.value / row.std * 100;
        const [lo, hi] = row.scale;
        fill = Math.min(100, Math.max(3, (percent - lo) / (hi - lo) * 100));
        band = [(row.normal[0] - lo) / (hi - lo) * 100, (row.normal[1] - row.normal[0]) / (hi - lo) * 100];
        status = percent < row.normal[0] ? '표준 이하' : percent > row.normal[1] ? '표준 이상' : '표준';
      } else {
        const values = records.map(record => row.label === '체지방량' ? fatMassOf(record) : +record[row.label === '체중' ? 'weight' : 'smm']).filter(Boolean);
        fill = row.value / (Math.max(...values) * 1.15) * 100;
      }
      return `<div class="ib-row"><span class="ib-label">${row.label}<small>${row.unit}</small></span><div class="ib-track">${band ? `<i class="ib-band" style="left:${band[0]}%;width:${band[1]}%"></i>` : ''}<i class="ib-fill" style="width:${fill}%;background:${row.color}"></i></div><b class="ib-value">${row.value}${status ? `<small class="${status === '표준' ? 'ok' : 'warn'}">${status}</small>` : ''}</b></div>`;
    };
    const pbf = pbfOf(latest);
    const pbfRow = pbf ? `<div class="ib-row"><span class="ib-label">체지방률<small>%</small></span><div class="ib-track"><i class="ib-band" style="left:${pbfRange[0] / 45 * 100}%;width:${(pbfRange[1] - pbfRange[0]) / 45 * 100}%"></i><i class="ib-fill" style="width:${Math.min(100, pbf / 45 * 100)}%;background:#f2a65a"></i></div><b class="ib-value">${pbf}<small class="${pbf < pbfRange[0] || pbf > pbfRange[1] ? 'warn' : 'ok'}">${pbf < pbfRange[0] ? '표준 이하' : pbf > pbfRange[1] ? '표준 이상' : '표준'}</small></b></div>` : '';

    const targetFat = +(state.profile?.bodyGoals?.targetBodyFat || state.profile?.targetFat) || 0;
    return `<div class="ib-section"><div class="ib-title"><strong>골격근·지방 분석</strong><span>${shortDate(latest.date)} 측정${stdWeight ? '' : ' · 키를 입력하면 표준 범위를 보여드려요'}</span></div>${rows.map(bar).join('')}${pbfRow}${stdWeight ? '<p class="ib-legend"><i></i>표준 범위 (키·성별 기준 추정)</p>' : ''}</div>
      ${records.length > 1 ? `<div class="ib-section"><div class="ib-title"><strong>변화 기록</strong><span>${records.length}회 측정</span></div>
        <div class="ib-tabs" role="tablist" aria-label="변화 기록 지표">${BODY_METRICS.map((metric, index) => `<button type="button" role="tab" aria-selected="${index === bodyMetricIndex}" class="${index === bodyMetricIndex ? 'on' : ''}" data-body-metric="${index}" style="--metric:${metric.color}">${metric.label}</button>`).join('')}</div>
        <div id="bodyTrend">${bodyTrend(records, BODY_METRICS[bodyMetricIndex])}</div></div>` : ''}
      ${targetFat && pbf ? `<p class="ib-target">🎯 목표 체지방률 ${targetFat}% · ${pbf > targetFat ? `${Math.round((pbf - targetFat) * 10) / 10}%p 남음` : '목표 달성!'}</p>` : ''}`;
  }

  function workoutVolume(workout) {
    const direct = +(workout.totalVolume ?? workout.volume ?? workout.trainingVolume);
    if (direct > 0) return direct;
    const exercises = workoutExercises(workout).reduce((sum, exercise) => sum + (exercise.volume || 0), 0);
    return exercises || (+workout.weight || 0) * (+workout.reps || 0) * (+workout.sets || 0);
  }

  function cardioCalories(workout) {
    if (+workout.cardioKcal > 0) return +workout.cardioKcal;
    const group = String(workout.group || workout.type || workout.name || '').toLowerCase();
    const cardio = /유산소|축구|러닝|달리기|걷기|사이클|수영|cardio|run|soccer/.test(group);
    return cardio ? +(workout.kcal ?? workout.calories ?? workout.burnedCalories ?? workout.calorie) || 0 : 0;
  }

  // ---- 막대 차트 (y축 눈금 포함) ----
  function niceMax(value) {
    const safe = Math.max(1, value);
    const exponent = 10 ** Math.floor(Math.log10(safe));
    const fraction = safe / exponent;
    return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(step => fraction <= step) || 10) * exponent;
  }

  const axisLabel = value => value >= 1000 ? `${Math.round(value / 100) / 10}k`.replace('.0k', 'k') : String(Math.round(value));

  function barChart(records, color, unit, target = 0) {
    if (!records.length) return svgEmpty('아직 표시할 기록이 없어요');
    const max = niceMax(Math.max(target, ...records.map(item => item.value)) * 1.08);
    const top = 16; const bottom = 98; const left = 44; const right = 350; const height = bottom - top;
    const y = value => bottom - value / max * height;
    const slot = (right - left) / records.length;
    const barWidth = Math.min(24, slot * .6);
    const ticks = [0, max / 2, max].map(value => `<line x1="${left}" y1="${y(value)}" x2="${right}" y2="${y(value)}" class="grid"/><text x="${left - 6}" y="${y(value) + 3}" text-anchor="end" class="axis">${axisLabel(value)}</text>`).join('');
    const showValues = records.length <= 7;
    return `<svg class="chart real-chart" viewBox="0 0 360 128" role="img" aria-label="${unit} 막대 차트">${ticks}
      ${target ? `<line x1="${left}" y1="${y(target)}" x2="${right}" y2="${y(target)}" stroke="#7f9d92" stroke-dasharray="4 4"/><text x="${right}" y="${y(target) - 4}" text-anchor="end" class="axis">목표 ${axisLabel(target)}</text>` : ''}
      ${records.map((item, index) => {
        const x = left + slot * index + (slot - barWidth) / 2;
        const h = Math.max(2, item.value / max * height);
        return `<rect x="${x}" y="${bottom - h}" width="${barWidth}" height="${h}" rx="5" fill="${item.over ? '#ff9e82' : color}"><title>${Math.round(item.value).toLocaleString()} ${unit}</title></rect>${showValues ? `<text x="${x + barWidth / 2}" y="${bottom - h - 4}" text-anchor="middle" class="bar-value">${axisLabel(item.value)}</text>` : ''}<text x="${x + barWidth / 2}" y="${bottom + 15}" text-anchor="middle">${shortDate(item.date)}</text>`;
      }).join('')}</svg>`;
  }

  function partSetsChart(state) {
    const sets = partSets(state);
    const total = Object.values(sets).reduce((sum, value) => sum + value, 0);
    if (!total) return svgEmpty('최근 7일 근력 기록이 없어요', '종목 이름으로 부위를 자동 분류해 주간 세트 수를 보여드려요.');
    const scale = Math.max(24, ...Object.values(sets));
    return `<div class="part-bars">${PART_ORDER.map(part => {
      const value = sets[part];
      const tone = value >= 10 && value <= 20 ? 'ok' : value > 20 ? 'over' : 'under';
      return `<div class="part-row"><span>${part}</span><div class="part-track"><i class="band" style="left:${10 / scale * 100}%;width:${10 / scale * 100}%"></i><i class="fill ${tone}" style="width:${value / scale * 100}%"></i></div><b>${value}세트</b></div>`;
    }).join('')}</div><div class="legend"><span><i class="band-dot"></i>권장 주 10~20세트</span><span><i style="background:#72d1ae"></i>적정</span><span><i style="background:#9fb7c9"></i>부족</span><span><i style="background:#ffb35f"></i>많음</span></div>`;
  }

  function renderRealReportCharts() {
    const report = $('[data-view="report"] .content');
    if (!report || !$('#bodyCard')) return;
    const state = readState();
    const inbody = (state.inbody || []).filter(item => !item.excluded && item.date).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-10);
    $('#bodyCard .chart-head').innerHTML = `<div><span>신체 변화</span><br><strong>${inbody.length ? `인바디 측정 ${inbody.length}회` : '최근 인바디'}</strong></div><button type="button" class="link" data-go="more" data-open="inbodyPanel">측정값 입력</button>`;
    const composition = $('#bodyComposition');
    composition.innerHTML = bodyComposition(inbody, state);
    if (!composition.dataset.tabs) {
      composition.dataset.tabs = 'true';
      composition.addEventListener('click', event => {
        const tab = event.target.closest('[data-body-metric]');
        if (!tab) return;
        bodyMetricIndex = +tab.dataset.bodyMetric;
        composition.querySelectorAll('[data-body-metric]').forEach(button => {
          const on = button === tab;
          button.classList.toggle('on', on);
          button.setAttribute('aria-selected', String(on));
        });
        const records = (readState().inbody || []).filter(item => !item.excluded && item.date).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-10);
        $('#bodyTrend').innerHTML = bodyTrend(records, BODY_METRICS[bodyMetricIndex]);
      });
    }
    const bodyComment = $('#bodyComment');
    if (bodyComment) {
      bodyComment.textContent = inbody.length > 1 ? '같은 시간대·조건에서 잰 값끼리 비교해야 정확해요. 한 번의 수치보다 흐름을 보세요.' : inbody.length ? '측정값이 더 쌓이면 변화 속도와 목표 방향을 함께 분석해요.' : '';
      bodyComment.classList.toggle('hidden', !inbody.length);
    }
    const logRows = Object.entries(state.logs || {}).filter(([date]) => validDate(date)).sort(([a], [b]) => a.localeCompare(b));
    const volumeRows = logRows.map(([date, log]) => ({ date, value: (log.workouts || []).reduce((sum, workout) => sum + workoutVolume(workout), 0) })).filter(item => item.value > 0).slice(-10);
    $('#volumeCard .chart-head').innerHTML = `<strong>근력운동 총 볼륨</strong><span>${volumeRows.length ? `최근 ${volumeRows.length}회 · ` : ''}kg</span>`;
    $('#volumeCard .chart-body').innerHTML = volumeRows.length ? `${barChart(volumeRows, '#67aef2', 'kg')}<div class="legend"><span><i style="background:#67aef2"></i>무게 × 횟수 합계</span></div>` : svgEmpty('아직 볼륨 기록이 없어요', '운동 내용을 “스쿼트 60kg 10회 5세트”처럼 적으면 자동으로 계산돼요.', '<button type="button" class="primary mint" data-go="workout">운동 기록하기</button>');
    $('#partSetsCard .chart-body').innerHTML = partSetsChart(state);
    const kcalTarget = +(state.profile?.targets?.kcal || 2200);
    const calorieRows = logRows.map(([date, log]) => ({ date, value: calories(log), meals: (log.meals || []).length })).filter(item => item.meals > 0).slice(-10).map(item => ({ ...item, over: item.value > kcalTarget * 1.05 }));
    $('#calorieCard .chart-head').innerHTML = `<strong>하루 섭취 칼로리</strong><span>${calorieRows.length ? `최근 ${calorieRows.length}일 · ` : ''}kcal</span>`;
    $('#calorieCard .chart-body').innerHTML = calorieRows.length ? `${barChart(calorieRows, '#72d1ae', 'kcal', kcalTarget)}<div class="legend"><span><i style="background:#72d1ae"></i>목표 이내</span><span><i style="background:#ff9e82"></i>목표 5% 초과</span></div>` : svgEmpty('아직 식단 기록이 없어요', '식사를 기록하면 목표 대비 하루 섭취량이 쌓여요.', '<button type="button" class="primary mint" data-go="meals">식사 기록하기</button>');
    let burnCard = $('#cardioReportCard');
    const burnRows = logRows.map(([date, log]) => ({ date, value: (log.workouts || []).reduce((sum, workout) => sum + (+workout.burnKcal || cardioCalories(workout)), 0) })).filter(item => item.value > 0).slice(-10);
    if (burnRows.length) {
      if (!burnCard) {
        burnCard = document.createElement('section');
        burnCard.id = 'cardioReportCard';
        burnCard.className = 'card chart-card';
        $('#calorieCard').insertAdjacentElement('afterend', burnCard);
      }
      burnCard.innerHTML = `<div class="chart-head"><strong>운동 소모 칼로리</strong><span>최근 ${burnRows.length}회 · kcal</span></div>${barChart(burnRows, '#ffb35f', 'kcal')}<div class="legend"><span><i style="background:#ffb35f"></i>체중·시간·강도 기준 추정치</span></div>`;
    } else if (burnCard) {
      burnCard.remove();
    }
    const header = report.querySelector('.eyebrow');
    if (header) header.textContent = '실제 기록 기준 · 최근 10회';
  }

  function remainingMealTypes(meals) {
    const hour = new Date().getHours();
    const recorded = new Set(meals.map(item => item.meal));
    const result = [];
    if (hour < 10 && !recorded.has('아침')) result.push('아침');
    if (hour < 15 && !recorded.has('점심')) result.push(hour >= 10 && !recorded.has('아침') ? '아점' : '점심');
    if (hour < 21 && !recorded.has('저녁')) result.push('저녁');
    if (!recorded.has('간식')) result.push('간식');
    return result.length ? result : ['가벼운 간식'];
  }

  function profileContextText(state) {
    const info = state.profile?.recommendationContext || {};
    const latest = (state.inbody || []).filter(item => !item.excluded).at(-1) || {};
    const goals = state.profile?.bodyGoals || {};
    return [
      info.sex && `성별 ${info.sex}`,
      info.birthYear && `출생연도 ${info.birthYear}`,
      (info.height || state.profile?.height) && `키 ${info.height || state.profile.height}cm`,
      (info.weight || latest.weight) && `체중 ${info.weight || latest.weight}kg`,
      (info.bodyFat || latest.pbf || latest.bodyFat) && `체지방률 ${info.bodyFat || latest.pbf || latest.bodyFat}%`,
      latest.smm && `골격근량 ${latest.smm}kg`,
      latest.bodyFatMass && `체지방량 ${latest.bodyFatMass}kg`,
      latest.bmi && `BMI ${latest.bmi}`,
      latest.visceralFat && `내장지방레벨 ${latest.visceralFat}`,
      latest.bmr && `기초대사량 ${latest.bmr}kcal`,
      goals.targetWeight && `목표 체중 ${goals.targetWeight}kg`,
      goals.targetSmm && `목표 골격근량 ${goals.targetSmm}kg`,
      goals.targetBodyFat && `목표 체지방률 ${goals.targetBodyFat}%`,
      goals.targetDate && `목표일 ${goals.targetDate}`,
      (info.goalStatement || info.goal) && `목표 ${info.goalStatement || info.goal}`,
      info.goalDeadline && `목표 기간 ${info.goalDeadline}`,
      info.goalPriority && `가장 중요한 기준 ${info.goalPriority}`,
      info.experience && `운동경력 ${info.experience}`,
      info.activity && `일상 활동량 ${info.activity}`,
      info.activityDetail && `직업·평소 움직임 ${info.activityDetail}`,
      info.schedule && `운동 가능 일정 ${info.schedule}`,
      info.trainingPreference && `선호 운동 ${info.trainingPreference}`,
      info.sleep && `평균 수면 ${info.sleep}`,
      info.injuries && `부상·주의사항 ${info.injuries}`,
      info.diet && `식사 패턴·알레르기 ${info.diet}`,
      info.eventContext && `특별 일정 ${info.eventContext}`
    ].filter(Boolean).join(', ') || '추가 정보 없음';
  }

  function clamp(value, min, max, fallback) {
    const number = +value;
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  }

  function targetPlanFromCoach(result, state) {
    const text = [result?.summary, ...(result?.adjustments || []), ...(result?.nextActions || [])].join(' ');
    const match = text.match(/\[TARGETS:([^\]]+)\]/i);
    if (!match) return null;
    const values = Object.fromEntries(match[1].split(';').map(part => part.split('=').map(value => value.trim())).filter(pair => pair.length === 2));
    const current = state.profile?.targets || { kcal: 2200, protein: 153, carbs: 260, fat: 61 };
    return {
      kcal: clamp(values.kcal, 1200, 4500, current.kcal),
      protein: clamp(values.protein, 40, 350, current.protein),
      carbs: clamp(values.carbs, 60, 650, current.carbs),
      fat: clamp(values.fat, 30, 180, current.fat),
      workouts: clamp(values.workouts, 1, 7, state.profile?.workoutGoal || 4),
      intensity: ['낮음', '중간', '높음'].includes(values.intensity) ? values.intensity : (state.profile?.trainingIntensity || '중간')
    };
  }

  function splitCoachText(value, count) {
    const parts = String(value || '').split(/\s*\|\|\s*/).map(item => item.trim()).filter(Boolean);
    while (parts.length < count) parts.push('기록을 이어가며 다음 분석의 정확도를 높여보세요.');
    return parts.slice(0, count);
  }

  async function analyzeCoachingSafely(settings, context, kind = 'weekly') {
    const format = kind === 'weekly'
      ? `items를 정확히 4개 반환한다. 1번: name=한줄제목과 요약, referenceAmount=운동강도(낮음/중간/높음 중 하나), servings=주간운동횟수, kcalPerServing=목표kcal, proteinPerServing=단백질g, carbsPerServing=탄수g, fatPerServing=지방g. 2번: name에 잘한 점 2개를 || 로 구분. 3번: name에 조정할 점 2개를 || 로 구분. 4번: name에 다음 행동 3개를 || 로 구분. 2~4번 숫자 필드는 0, referenceAmount는 기록분석, servings는 1로 쓴다. confidence는 모두 보통. `
      : `items를 정확히 1개 반환한다. name=계산 근거 요약, referenceAmount=운동강도(낮음/중간/높음 중 하나), servings=주간운동횟수, kcalPerServing=목표kcal, proteinPerServing=단백질g, carbsPerServing=탄수g, fatPerServing=지방g, confidence=보통. `;
    const raw = await analyzeWithAi(settings, `${format}${context}`, 'analyze', false);
    const items = Array.isArray(raw?.items) ? raw.items : [];
    if (!items.length) throw new Error('AI 목표 계산 결과를 읽지 못했어요.');
    const planItem = items[0];
    const result = {
      headline: String(planItem.name || '다음 목표를 계산했어요.'),
      summary: String(planItem.name || ''),
      strengths: splitCoachText(items[1]?.name, 2),
      adjustments: splitCoachText(items[2]?.name, 2),
      nextActions: splitCoachText(items[3]?.name, 3)
    };
    const plan = {
      kcal: planItem.kcalPerServing,
      protein: planItem.proteinPerServing,
      carbs: planItem.carbsPerServing,
      fat: planItem.fatPerServing,
      workouts: planItem.servings,
      intensity: String(planItem.referenceAmount || '').match(/낮음|중간|높음/)?.[0]
    };
    return { result, plan };
  }

  function saveAiTargets(state, plan, reason) {
    if (!plan) return false;
    state.profile ||= {};
    state.profile.targets = { kcal: plan.kcal, protein: plan.protein, carbs: plan.carbs, fat: plan.fat };
    state.profile.workoutGoal = plan.workouts;
    state.profile.trainingIntensity = plan.intensity;
    state.profile.targetUpdatedAt = new Date().toISOString();
    state.profile.targetReason = reason || 'AI 코칭 분석';
    return true;
  }

  function targetSummary(state) {
    const targets = state.profile?.targets || { kcal: 2200, protein: 153, carbs: 260, fat: 61 };
    return `<div class="ai-target-summary"><span><b>${(+targets.kcal || 0).toLocaleString()}</b> kcal</span><span><b>${+targets.protein || 0}g</b> 단백질</span><span><b>${+targets.carbs || 0}g</b> 탄수</span><span><b>${+targets.fat || 0}g</b> 지방</span><span><b>주 ${state.profile?.workoutGoal || 4}회</b> ${esc(state.profile?.trainingIntensity || '중간')} 강도</span></div>`;
  }

  function installBodyGoals() {
    const host = $('#recommendationProfile');
    if (!host || $('#inbodyPanel')) return;
    const state = readState();
    const latest = (state.inbody || []).filter(item => !item.excluded).at(-1) || {};
    const panel = document.createElement('details');
    panel.id = 'inbodyPanel';
    panel.className = 'card settings-fold';
    panel.innerHTML = `
      <summary><span class="fold-icon">⚖️</span><span><strong>인바디 기록</strong><small>${latest.date ? `최근 측정 ${esc(latest.date)}` : '측정값을 입력하면 추세와 코칭에 반영돼요'}</small></span><b>›</b></summary>
      <div class="fold-content body-profile-card">
        <div class="body-score"><div><span>BODY PROFILE</span><strong>${esc(latest.score || '기록 전')}</strong></div><small>${latest.date ? `최근 측정 ${esc(latest.date)}` : '첫 측정값을 입력해 주세요'}</small></div>
        <div class="body-input-grid">
          <label class="field"><span>측정일</span><input class="input" id="ibDate" type="date" value="${esc(latest.date || dateKey(new Date()))}"></label>
          <label class="field"><span>체중 kg</span><input class="input" id="ibWeight" inputmode="decimal" value="${esc(latest.weight || '')}"></label>
          <label class="field"><span>골격근량 kg</span><input class="input" id="ibSmm" inputmode="decimal" value="${esc(latest.smm || '')}"></label>
          <label class="field"><span>체지방량 kg</span><input class="input" id="ibFatMass" inputmode="decimal" value="${esc(latest.bodyFatMass || '')}"></label>
          <label class="field"><span>체지방률 %</span><input class="input" id="ibPbf" inputmode="decimal" value="${esc(latest.pbf || latest.bodyFat || '')}"></label>
          <label class="field"><span>BMI</span><input class="input" id="ibBmi" inputmode="decimal" value="${esc(latest.bmi || '')}"></label>
          <label class="field"><span>내장지방 레벨</span><input class="input" id="ibVisceral" inputmode="decimal" value="${esc(latest.visceralFat || '')}"></label>
          <label class="field"><span>기초대사량 kcal</span><input class="input" id="ibBmr" inputmode="numeric" value="${esc(latest.bmr || '')}"></label>
        </div>
        <button type="button" class="primary mint full" id="saveInbody">측정값 저장</button>
      </div>`;
    host.insertAdjacentElement('afterend', panel);
    $('#saveInbody').onclick = () => {
      const next = readState();
      next.inbody ||= [];
      const item = { date: $('#ibDate').value || dateKey(new Date()), weight: +$('#ibWeight').value || null, smm: +$('#ibSmm').value || null, bodyFatMass: +$('#ibFatMass').value || null, pbf: +$('#ibPbf').value || null, bmi: +$('#ibBmi').value || null, visceralFat: +$('#ibVisceral').value || null, bmr: +$('#ibBmr').value || null };
      const index = next.inbody.findIndex(value => value.date === item.date);
      if (index >= 0) next.inbody[index] = { ...next.inbody[index], ...item }; else next.inbody.push(item);
      next.inbody.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      writeState(next); window.dispatchEvent(new CustomEvent('fitlog:state-updated')); showToast('인바디 측정값을 저장했어요.');
    };
  }

  // ---- 주간 리포트 · 특별 일정 조언 ----
  function metricTiles(metrics) {
    const percent = (value, target) => value != null && target ? Math.round(value / target * 100) : null;
    const tile = (label, value, sub, tone = '') => `<div class="metric ${tone}"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
    const kcalPct = percent(metrics.kcal, metrics.kcalTarget);
    const proteinPct = percent(metrics.protein, metrics.proteinTarget);
    const doneRatio = metrics.workoutDays / Math.max(1, metrics.goal);
    const partValues = PART_ORDER.map(part => [part, metrics.parts[part]]);
    const balanced = partValues.filter(([, value]) => value >= 10 && value <= 20).length;
    const lacking = partValues.filter(([part, value]) => value < 10 && !(part === '하체' && metrics.legRule === 'alternate-soccer')).map(([part]) => part);
    const weightDiff = metrics.weightStart != null && metrics.weightEnd != null ? Math.round((metrics.weightEnd - metrics.weightStart) * 10) / 10 : null;
    return `<div class="metric-grid">
      ${tile('운동 수행', `${metrics.workoutDays}/${metrics.goal}회`, metrics.planned ? `AI 계획 ${metrics.plannedDone}/${metrics.planned}회 수행` : '주간 목표 대비', doneRatio >= .8 ? 'good' : 'warn')}
      ${tile('총 볼륨', metrics.volume ? `${Math.round(metrics.volume).toLocaleString()}kg` : '–', metrics.volumeChange != null ? `지난주 대비 ${metrics.volumeChange > 0 ? '+' : ''}${metrics.volumeChange}%` : '비교할 기록 없음', metrics.volumeChange == null ? '' : metrics.volumeChange >= 0 ? 'good' : 'warn')}
      ${tile('운동 소모', metrics.burnKcal ? `${metrics.burnKcal.toLocaleString()}kcal` : '–', metrics.rpe ? `평균 RPE ${metrics.rpe.toFixed(1)}` : '강도 기록 없음')}
      ${tile('부위 균형', `${balanced}/6 적정`, lacking.length ? `부족: ${lacking.slice(0, 3).join('·')}` : '모든 부위 적정', balanced >= 4 ? 'good' : 'warn')}
      ${tile('평균 섭취', metrics.kcal != null ? `${Math.round(metrics.kcal).toLocaleString()}kcal` : '–', kcalPct != null ? `목표의 ${kcalPct}% · ${metrics.mealDays}일 기록` : '식단 기록 없음', kcalPct == null ? '' : kcalPct >= 90 && kcalPct <= 105 ? 'good' : 'warn')}
      ${tile('단백질', metrics.protein != null ? `${Math.round(metrics.protein)}g` : '–', proteinPct != null ? `목표의 ${proteinPct}%` : '식단 기록 없음', proteinPct == null ? '' : proteinPct >= 90 ? 'good' : 'warn')}
      ${tile('수면·컨디션', metrics.sleep != null ? `${metrics.sleep.toFixed(1)}시간` : '–', metrics.condition != null ? `컨디션 ${metrics.condition.toFixed(1)}/5` : '체크인 기록 없음', metrics.sleep == null ? '' : metrics.sleep >= 7 ? 'good' : 'warn')}
      ${tile('공복 체중', metrics.weightEnd != null ? `${metrics.weightEnd}kg` : '–', weightDiff ? `주간 ${weightDiff > 0 ? '+' : ''}${weightDiff}kg` : '체크인에 체중을 적어주세요')}
    </div>`;
  }

  function fallbackReport(state, metrics, error) {
    const kcalPct = metrics.kcal != null ? Math.round(metrics.kcal / metrics.kcalTarget * 100) : null;
    const lacking = PART_ORDER.filter(part => metrics.parts[part] < 10);
    return {
      version: 2, fallback: true, error: error?.message || '',
      headline: metrics.workoutDays >= metrics.goal ? '목표 횟수를 채운 한 주' : '루틴을 다시 세우는 한 주',
      summary: `운동 ${metrics.workoutDays}일, 식단 ${metrics.mealDays}일을 기록했어요. AI 서버 연결이 원활하지 않아 저장된 수치로 기본 리포트를 만들었어요.`,
      training: { status: metrics.rpe >= 9 ? '회복' : metrics.volumeChange != null && metrics.volumeChange < -15 ? '조정' : '유지', analysis: `총 볼륨 ${Math.round(metrics.volume).toLocaleString()}kg${metrics.volumeChange != null ? `(지난주 대비 ${metrics.volumeChange > 0 ? '+' : ''}${metrics.volumeChange}%)` : ''}. ${lacking.length ? `${lacking.join('·')} 세트가 주 10세트에 못 미쳐요.` : '부위별 세트가 고르게 분포했어요.'}` },
      nutrition: kcalPct != null ? `기록한 날 평균 ${Math.round(metrics.kcal)}kcal로 목표의 ${kcalPct}%, 단백질은 평균 ${Math.round(metrics.protein || 0)}g이에요.` : '식단 기록이 없어 영양 분석을 하지 못했어요.',
      recovery: metrics.sleep != null ? `평균 수면 ${metrics.sleep.toFixed(1)}시간${metrics.condition != null ? `, 컨디션 ${metrics.condition.toFixed(1)}/5` : ''}이에요.` : '아침 체크인을 남기면 회복 상태까지 분석해요.',
      strengths: [metrics.workoutDays ? `${metrics.workoutDays}일 운동을 기록했어요.` : '기록을 시작한 것 자체가 좋은 출발이에요.', metrics.mealDays >= 4 ? `${metrics.mealDays}일 식단을 기록해 패턴이 보여요.` : '기록한 식단이 다음 계획의 기준이 돼요.'],
      adjustments: [kcalPct != null && kcalPct > 105 ? `평균 섭취가 목표보다 ${Math.round(metrics.kcal - metrics.kcalTarget)}kcal 많아요. 간식과 음료부터 줄여보세요.` : '매 끼니 단백질 30g 이상을 먼저 채워보세요.', lacking.length ? `${lacking[0]} 운동을 주 2회 넣어 세트를 늘려보세요.` : '지금 볼륨을 유지하며 무게를 조금씩 올려보세요.'],
      nextActions: ['운동 후 RPE와 메모를 남기기', '아침 체크인(공복 체중·수면·컨디션) 매일 기록하기', '같은 종목은 지난번보다 1회 또는 2.5kg 더 해보기']
    };
  }

  function reportMarkup(saved, state) {
    const end = saved.period?.end || dateKey(new Date(saved.createdAt || Date.now()));
    const metrics = weeklyMetrics(state, end);
    const statusTone = { 상향: 'up', 유지: 'keep', 조정: 'warn', 회복: 'rest' };
    const score = Math.max(0, Math.min(100, Math.round(+saved.score || 0)));
    const sections = saved.training ? `
      <div class="report-section"><h4>훈련 <i class="status ${statusTone[saved.training.status] || 'keep'}">다음 주 ${esc(saved.training.status || '유지')}</i></h4><p>${esc(saved.training.analysis || '')}</p></div>
      <div class="report-section"><h4>영양</h4><p>${esc(saved.nutrition || '')}</p></div>
      <div class="report-section"><h4>회복</h4><p>${esc(saved.recovery || '')}</p></div>` : '';
    return `<div class="report-top"><div class="coach-title"><span>${saved.auto ? '일요일 자동 주간 리포트' : 'WEEKLY REPORT'} · ${shortDate(metrics.start)}–${shortDate(metrics.end)}</span><strong>${esc(saved.headline || '이번 주 리포트')}</strong></div>${score ? `<div class="score-ring" style="--p:${score}"><b>${score}</b><small>점</small></div>` : ''}</div>
      <p class="report-summary">${esc(saved.summary || '')}</p>
      ${metricTiles(metrics)}
      ${sections}
      <div class="coach-columns"><div><b>잘한 점</b>${(saved.strengths || []).map(item => `<p>✓ ${esc(item)}</p>`).join('')}</div><div><b>조정할 점</b>${(saved.adjustments || []).map(item => `<p>• ${esc(item)}</p>`).join('')}</div></div>
      <div class="coach-plan"><b>다음 7일 실행 계획</b>${(saved.nextActions || []).map((item, index) => `<p><span>${index + 1}</span>${esc(item)}</p>`).join('')}</div>
      ${targetSummary(state)}
      <small class="coach-note">${saved.fallback ? `AI 연결 오류: ${esc(saved.error || '연결 실패')} · ` : saved.createdAt ? `${new Date(saved.createdAt).toLocaleString('ko-KR')} 작성 · ` : ''}기록 기반 일반 코칭이며 의료 진단을 대신하지 않아요.</small>
      <div class="coach-actions"><button type="button" class="link" data-coach-run>${saved.fallback ? 'AI 리포트 다시 시도' : '다시 분석'}</button><button type="button" class="link" data-go="workout">주간 운동 계획 보기 ›</button></div>`;
  }

  function adviceMarkup(state, open = false) {
    const advice = state.profile?.eventAdvice;
    const result = advice?.result;
    return `<details class="event-advice" ${open ? 'open' : ''}><summary>특별 일정 조언받기 <b>＋</b></summary><div>
      <textarea class="textarea compact" id="eventAdviceText" placeholder="예: 금요일 회식, 토요일 결혼식 뷔페가 있어요. 주말엔 운동을 못 해요.">${esc(advice?.text || '')}</textarea>
      <button type="button" class="primary mint full" id="runEventAdvice">코치 조언 받기</button><p class="notice" id="eventAdviceNotice"></p>
      ${result ? `<div class="advice-result"><strong>${esc(result.headline)}</strong><p>${esc(result.summary)}</p><ol>${(result.recommendations || []).map(item => `<li><b>${esc(item.title)}</b><span>${esc(item.detail)}</span></li>`).join('')}</ol>${(result.cautions || []).length ? `<div class="advice-cautions"><b>피하면 좋은 것</b>${result.cautions.map(item => `<p>• ${esc(item)}</p>`).join('')}</div>` : ''}<small>${new Date(advice.createdAt).toLocaleString('ko-KR')} 작성</small></div>` : ''}
    </div></details>`;
  }

  function installWeeklyCoach() {
    const anchor = $('#bodyComment') || $('#bodyCard');
    if (!anchor || $('#weeklyCoach')) return;
    const coach = document.createElement('section');
    coach.id = 'weeklyCoach';
    coach.className = 'card weekly-coach';
    anchor.insertAdjacentElement('afterend', coach);
    let busy = false;

    function render(temporary = null, adviceOpen = false) {
      const state = readState();
      const saved = temporary || state.profile?.weeklyCoach;
      coach.innerHTML = (saved ? reportMarkup(saved, state) : `<div class="coach-title"><span>FITLOG WEEKLY REPORT</span><strong>지난 7일을 함께 읽어볼까요?</strong><small>운동·식단·체크인·메모를 종합해 점수와 다음 주 기준을 알려드려요. 매주 일요일 밤 11시 이후 앱을 열면 자동으로 만들어져요.</small></div>${metricTiles(weeklyMetrics(state))}<button type="button" class="primary full" data-coach-run>지금 주간 리포트 받기</button>`) + adviceMarkup(state, adviceOpen);
      if (busy) coach.querySelectorAll('[data-coach-run]').forEach(button => { button.disabled = true; button.textContent = '기록을 분석하는 중…'; });
    }

    async function runWeeklyCoach(auto) {
      const state = readState();
      const settings = parse(localStorage.getItem(AI_KEY), {}) || {};
      if (!aiReady(settings)) { if (!auto) showToast('더보기에서 이메일로 로그인해 주세요.'); return; }
      const end = dateKey(new Date());
      const metrics = weeklyMetrics(state, end);
      if (!metrics.workoutDays && !metrics.mealDays && metrics.sleep == null) { if (!auto) showToast('이번 주 기록이 생기면 리포트를 만들 수 있어요.'); return; }
      busy = true;
      render();
      const current = state.profile?.targets || { kcal: 2200, protein: 153, carbs: 260, fat: 61 };
      const goal = +(state.profile?.workoutGoal || 4);
      const plan = currentPlan(state);
      const inbody = (state.inbody || []).filter(item => !item.excluded).slice(-3).map(item => `${item.date} 체중${item.weight} 골격근${item.smm} 체지방률${item.pbf ?? item.bodyFat}`).join(' | ');
      const prompt = [
        '지난 7일을 분석해 전문적인 주간 리포트를 작성한다.',
        `사용자: ${profileContextText(state)}`,
        `현재 목표: ${JSON.stringify(current)}, 주 ${goal}회, ${state.profile?.trainingIntensity || '중간'} 강도`,
        `주간 지표:\n${metricsText(metrics)}`,
        `일별 기록:\n${recentLogText(state, 7)}`,
        rulesPrompt(state, mondayKey()),
        `종목별 최근 수행(최근 4회):\n${exerciseHistoryText(state, 4)}`,
        plan ? `이번 주 계획: ${plan.title} / ${plan.principle} / ${plan.days.map(day => `${weekdayName(day.date)} ${day.rest ? '휴식' : day.focus}(${dayState(state, day) === 'done' ? '수행' : dayState(state, day) === 'missed' ? '놓침' : '예정'})`).join(', ')}` : '',
        inbody ? `최근 인바디: ${inbody}` : '',
        '작성 규칙: score는 0~100(운동 수행 35, 영양 30, 회복 20, 기록 충실도 15). training.status는 다음 주 부하 방향(상향/유지/조정/회복). training.analysis는 볼륨 변화·강도(RPE)·부위 균형·과부하 진행을 수치 근거로 2~3문장. nutrition과 recovery도 각각 수치를 근거로 2~3문장. strengths와 adjustments는 구체적인 행동 단위. nextActions는 다음 주에 바로 할 3가지. targets의 kcal은 현재에서 ±100 이내, workouts는 ±1 이내로 보수적으로. 미기록일은 0kcal로 보지 않는다. 의료 진단은 하지 않는다.'
      ].filter(Boolean).join('\n\n');
      try {
        const result = await analyzeWithAi(coachSettings(settings), prompt, 'report', false);
        if (!result?.training || !result?.targets) throw new Error('AI 서버 함수가 이전 버전이에요. Supabase에 새 함수를 배포해 주세요.');
        const next = readState();
        next.profile ||= {};
        const workouts = next.profile.workoutGoal || 4;
        saveAiTargets(next, {
          kcal: clamp(result.targets.kcal, current.kcal - 100, current.kcal + 100, current.kcal),
          protein: clamp(result.targets.protein, 40, 350, current.protein),
          carbs: clamp(result.targets.carbs, 60, 650, current.carbs),
          fat: clamp(result.targets.fat, 30, 180, current.fat),
          workouts: clamp(result.targets.workouts, Math.max(1, workouts - 1), Math.min(7, workouts + 1), workouts),
          intensity: ['낮음', '중간', '높음'].includes(result.targets.intensity) ? result.targets.intensity : (next.profile.trainingIntensity || '중간')
        }, '주간 리포트 자동 조정');
        next.profile.weeklyCoach = { ...result, version: 2, createdAt: new Date().toISOString(), auto, period: { start: metrics.start, end } };
        next.profile.weeklyCoachKey = scheduledCoachKey();
        writeState(next);
        busy = false;
        render();
        window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
      } catch (error) {
        busy = false;
        render({ ...fallbackReport(state, metrics, error), createdAt: new Date().toISOString(), period: { start: metrics.start, end } });
      }
    }

    async function runEventAdvice() {
      const text = $('#eventAdviceText')?.value.trim();
      const notice = $('#eventAdviceNotice');
      if (!text) { notice.textContent = '특별 일정이나 최근 상황을 적어주세요.'; return; }
      const settings = parse(localStorage.getItem(AI_KEY), {}) || {};
      if (!aiReady(settings)) { notice.textContent = '더보기에서 이메일로 로그인해 주세요.'; return; }
      const state = readState();
      const button = $('#runEventAdvice');
      button.disabled = true;
      button.textContent = '코치가 조언을 정리하는 중…';
      try {
        const plan = currentPlan(state);
        const prompt = [
          `특별 일정·상황: ${text}`,
          `오늘: ${dateKey(new Date())}(${weekdayName(dateKey(new Date()))})`,
          `사용자: ${profileContextText(state)}`,
          `현재 목표: ${JSON.stringify(state.profile?.targets || {})}, 주 ${state.profile?.workoutGoal || 4}회`,
          `최근 7일 지표:\n${metricsText(weeklyMetrics(state))}`,
          `최근 기록:\n${recentLogText(state, 7)}`,
          plan ? `남은 운동 계획: ${plan.days.filter(day => day.date >= dateKey(new Date())).map(day => `${weekdayName(day.date)} ${day.rest ? '휴식' : day.focus}`).join(', ')}` : '',
          '요구: 이 일정 전·당일·후에 식사, 운동, 수면·회복을 어떻게 조정할지 전문 코치로서 구체적으로 조언한다. recommendations는 3~5개, title은 한 줄 행동, detail은 이유와 방법을 메뉴·분량·시간 예시와 함께 2~3문장. cautions는 피해야 할 행동. 굶기나 과도한 보상 운동은 권하지 않고, 목표 kcal 숫자를 바꾸라는 대신 행동으로 제안한다.'
        ].filter(Boolean).join('\n\n');
        const result = await analyzeWithAi(coachSettings(settings), prompt, 'advice', false);
        if (!Array.isArray(result?.recommendations)) throw new Error('AI 서버 함수가 이전 버전이에요. Supabase에 새 함수를 배포해 주세요.');
        const next = readState();
        next.profile ||= {};
        next.profile.recommendationContext ||= {};
        next.profile.recommendationContext.eventContext = text;
        next.profile.eventAdvice = { text, result, createdAt: new Date().toISOString() };
        writeState(next);
        render(null, true);
      } catch (error) {
        notice.textContent = error.message || '조언을 만들지 못했어요.';
        button.disabled = false;
        button.textContent = '코치 조언 받기';
      }
    }

    coach.addEventListener('click', event => {
      if (event.target.closest('[data-coach-run]')) runWeeklyCoach(false);
      if (event.target.closest('#runEventAdvice')) runEventAdvice();
    });
    render();
    window.addEventListener('fitlog:state-updated', () => { if (!busy && !coach.contains(document.activeElement)) render(null, coach.querySelector('.event-advice')?.open); });

    function scheduledCoachKey(now = new Date()) {
      const due = new Date(now);
      due.setHours(23, 0, 0, 0);
      due.setDate(due.getDate() - due.getDay());
      if (due > now) due.setDate(due.getDate() - 7);
      return dateKey(due);
    }

    let scheduledRunning = false;
    async function maybeRunScheduledCoach() {
      const state = readState();
      const settings = parse(localStorage.getItem(AI_KEY), {}) || {};
      const dueKey = scheduledCoachKey();
      if (scheduledRunning || !aiReady(settings) || new Date() < new Date(`${dueKey}T23:00:00`)) return;
      if (state.profile?.weeklyCoachKey === dueKey && state.profile?.planScheduleKey === dueKey) return;
      // 실패하면 열 때마다 재시도하지 않도록 자동 실행은 한 시간에 한 번만 시도한다.
      const lastTry = +localStorage.getItem('fitlog:autoCoachTry') || 0;
      if (Date.now() - lastTry < 3600000) return;
      localStorage.setItem('fitlog:autoCoachTry', String(Date.now()));
      scheduledRunning = true;
      try {
        if (state.profile?.weeklyCoachKey !== dueKey && Object.keys(state.logs || {}).length) await runWeeklyCoach(true);
        await runScheduledPlan(dueKey);
      } finally {
        scheduledRunning = false;
      }
    }
    setTimeout(maybeRunScheduledCoach, 1200);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeRunScheduledCoach(); });
    const now = new Date();
    const nextSunday = new Date(now);
    nextSunday.setDate(now.getDate() + ((7 - now.getDay()) % 7));
    nextSunday.setHours(23, 0, 0, 0);
    if (nextSunday <= now) nextSunday.setDate(nextSunday.getDate() + 7);
    setTimeout(maybeRunScheduledCoach, Math.min(2147483000, nextSunday - now + 1500));
  }

  function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  // ---- 운동 기록 폼 ----
  let selectedRpe = null;
  let prefilledPlanDate = null;
  const goTo = view => $(`.nav [data-go="${view}"]`)?.click();
  // 체크 없이 적은 종목으로 밀기·당기기·하체·유산소를 판단한다.
  const ROUTINES = ['밀기', '당기기', '하체', '유산소'];

  function exerciseRoutine(exercise) {
    if (exercise.cardio) return '유산소';
    if (exercise.part === '팔') return /삼두|트라이셉|푸쉬다운|푸시다운|킥백|딥스|스컬|익스텐션/.test(exercise.name) ? '밀기' : '당기기';
    return { 가슴: '밀기', 어깨: '밀기', 등: '당기기', 하체: '하체' }[exercise.part] || null;
  }

  function routinesOf(exercises) {
    const found = ROUTINES.filter(routine => exercises.some(exercise => exerciseRoutine(exercise) === routine));
    return found.length ? found : exercises.length ? ['기타'] : [];
  }

  // 예전 기록은 저장된 분류(밀기·유산소(축구)·근력 등)와 실제 종목을 함께 본다.
  function workoutRoutines(workout) {
    const text = String(workout.group || workout.type || '');
    const fromGroup = ROUTINES.filter(routine => text.includes(routine) || (routine === '유산소' && /축구/.test(text)));
    return [...new Set([...routinesOf(workoutExercises(workout)).filter(routine => routine !== '기타'), ...fromGroup])];
  }

  function workoutDraft() {
    const state = readState();
    const exercises = parseWorkoutText($('#workoutNote')?.value);
    const groups = routinesOf(exercises);
    const cardio = groups.includes('유산소');
    const estimate = estimateWorkout(exercises, {
      minutes: +$('#workoutMinutes')?.value || 0, rpe: selectedRpe, groups,
      manualCardioKcal: cardio ? +$('#workoutKcal')?.value || 0 : 0, bodyWeight: latestBodyWeight(state)
    });
    return { state, groups, exercises, estimate, cardio };
  }

  function renderWorkoutDraft() {
    const target = $('#workoutParsed');
    if (!target) return;
    const { state, groups, exercises, estimate } = workoutDraft();
    syncCardioField();
    if (!exercises.length) { target.innerHTML = ''; return; }
    const history = exerciseHistory(state, dateKey(new Date()));
    const volume = exercises.reduce((sum, exercise) => sum + exercise.volume, 0);
    target.innerHTML = `<div class="parsed-head"><span><b class="routine-tag">${esc(groups.join('·'))}</b> 인식된 운동 ${exercises.length}개</span><b>약 ${estimate.kcal.toLocaleString()} kcal 소모</b></div>
      <ul>${exercises.map(exercise => `<li><div><strong>${esc(exercise.name)}</strong><span>${esc(setSummary(exercise))}</span></div><div class="badges">${progressBadges(exerciseProgress(exercise, history))}</div></li>`).join('')}</ul>
      <div class="parsed-foot">${volume ? `총 볼륨 <b>${volume.toLocaleString()}kg</b> · ` : ''}${estimate.strengthSets ? `${estimate.strengthSets}세트 · ` : ''}${estimate.minutes ? `${estimate.estimatedTime ? '약 ' : ''}${estimate.minutes}분 · ` : ''}체중 ${estimate.bodyWeight}kg 기준</div>`;
  }

  function syncCardioField() {
    const exercises = parseWorkoutText($('#workoutNote')?.value);
    $('#cardioField')?.classList.toggle('hidden', !exercises.some(exercise => exercise.cardio));
  }

  function setRpe(value) {
    selectedRpe = value;
    document.querySelectorAll('[data-rpe]').forEach(button => button.classList.toggle('on', +button.dataset.rpe === value));
    if ($('#rpeLabel')) $('#rpeLabel').textContent = value ? `${value} · ${RPE_LABELS[value]}` : '선택 안 함';
  }

  function workoutWarn(message) {
    const notice = $('#workoutNotice');
    notice.textContent = message;
    notice.classList.add('warn');
    const note = $('#workoutNote');
    note.classList.remove('shake'); void note.offsetWidth; note.classList.add('shake');
    note.focus();
  }

  function resetWorkoutForm() {
    if (typeof setWorkoutEditMode === 'function') setWorkoutEditMode(null);
    ['#workoutNote', '#workoutKcal', '#workoutMinutes', '#workoutComment'].forEach(selector => { if ($(selector)) $(selector).value = ''; });
    prefilledPlanDate = null;
    setRpe(null);
    renderWorkoutDraft();
    renderExerciseChips();
  }

  function saveWorkoutRecord() {
    const notice = $('#workoutNotice');
    const { state, groups, exercises, estimate, cardio } = workoutDraft();
    if (!exercises.length) return workoutWarn('운동 내용을 한 줄 이상 적어주세요. 예: 벤치프레스 60kg 10x5');
    const today = dateKey(new Date());
    const note = $('#workoutNote').value.trim();
    const history = exerciseHistory(state, today);
    const prs = exercises.filter(exercise => exerciseProgress(exercise, history)?.pr).length;
    const totalVolume = exercises.reduce((sum, exercise) => sum + exercise.volume, 0);
    const manualKcal = cardio ? +$('#workoutKcal').value || 0 : 0;
    const record = {
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      group: groups.join('·'), name: note.split('\n')[0] || groups.join('·'), note, exercises, totalVolume,
      minutes: estimate.minutes || null, minutesEstimated: estimate.estimatedTime, rpe: selectedRpe,
      comment: $('#workoutComment').value.trim(), burnKcal: estimate.kcal, cardioKcal: estimate.cardioKcal
    };
    if (manualKcal) record.kcal = manualKcal;
    if (editingWorkout) {
      const target = (state.logs?.[editingWorkout.date]?.workouts || []).find(item => item.id === editingWorkout.id);
      if (target) {
        Object.keys(target).forEach(key => { if (!['id', 'planDate'].includes(key)) delete target[key]; });
        Object.assign(target, { ...record, id: target.id, updatedAt: new Date().toISOString() });
        writeState(state);
        window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
        const editedDate = editingWorkout.date;
        resetWorkoutForm();
        notice.classList.remove('warn');
        notice.textContent = `${shortDate(editedDate)} 운동 기록을 수정했어요.`;
        selectedDate = editedDate;
        renderCalendar();
        setTimeout(() => { notice.textContent = ''; $('#calendarArchive')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 600);
        return;
      }
    }
    if (prefilledPlanDate) record.planDate = prefilledPlanDate;
    state.logs ||= {};
    state.logs[today] ||= { meals: [], workouts: [] };
    state.logs[today].workouts ||= [];
    state.logs[today].workouts.push(record);
    writeState(state);
    window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
    resetWorkoutForm();
    notice.classList.remove('warn');
    notice.textContent = [`${groups.join('·')} 저장했어요`, totalVolume ? `볼륨 ${totalVolume.toLocaleString()}kg` : '', estimate.kcal ? `약 ${estimate.kcal.toLocaleString()}kcal 소모` : '', prs ? `🏆 PR ${prs}개` : ''].filter(Boolean).join(' · ');
    setTimeout(() => { notice.textContent = ''; goTo('home'); }, 1400);
  }

  // ---- 빠른 입력: 지난 루틴 불러오기(한 단계 증량 제안) · 자주 한 운동 ----
  const kgText = value => `${Math.round(value * 10) / 10}kg`;

  // 세트 목록을 입력 형식으로 되돌린다. bump만큼 본세트(최고 무게) 무게를 올린다.
  function exerciseLine(exercise, bump = 0) {
    if (exercise.cardio || !exercise.setList?.length) return exercise.minutes ? `${exercise.name} ${exercise.minutes}분` : exercise.name;
    const top = Math.max(...exercise.setList.map(set => set.weight));
    const groups = [];
    exercise.setList.forEach(set => {
      const weight = top > 0 && set.weight === top ? top + bump : set.weight;
      const last = groups.at(-1);
      if (last && last.weight === weight) last.reps.push(set.reps); else groups.push({ weight, reps: [set.reps] });
    });
    return `${exercise.name} ${groups.map(group => `${group.weight ? `${kgText(group.weight)} ` : ''}${group.reps.join('/')}`).join(' ')}`;
  }

  // 지난번 본세트 횟수를 모두 채웠고 RPE 8 이하였다면 상체 +2.5kg, 하체 +5kg을 제안한다.
  function overloadStep(exercise, rpe) {
    if (exercise.cardio || !exercise.weight || rpe >= 9) return 0;
    const topReps = exercise.setList.filter(set => set.weight === exercise.weight).map(set => set.reps);
    return topReps.length > 1 && topReps.every(rep => rep === topReps[0]) ? (exercise.part === '하체' ? 5 : 2.5) : 0;
  }

  function lastWorkout(state, predicate) {
    for (const date of Object.keys(state.logs || {}).filter(validDate).sort().reverse()) {
      const found = [...(state.logs[date].workouts || [])].reverse().find(predicate);
      if (found) return { date, workout: found };
    }
    return null;
  }

  function loadRoutine(routine) {
    const state = readState();
    const hit = routine === '최근' ? lastWorkout(state, () => true) : lastWorkout(state, workout => workoutRoutines(workout).includes(routine));
    if (!hit) return showToast(routine === '최근' ? '불러올 운동 기록이 아직 없어요.' : `아직 ${routine} 기록이 없어요. 한 번 적어두면 다음부터 불러올 수 있어요.`);
    const all = workoutExercises(hit.workout);
    // 해당 루틴 종목과 복근·기타 보조 종목을 가져온다.
    const exercises = routine === '최근' ? all : all.filter(exercise => exerciseRoutine(exercise) === routine || (routine !== '유산소' && !exercise.cardio && !exerciseRoutine(exercise)));
    let bumped = 0;
    const lines = exercises.map(exercise => {
      const step = overloadStep(exercise, hit.workout.rpe);
      if (step) bumped++;
      return exerciseLine(exercise, step);
    });
    const note = $('#workoutNote');
    note.value = lines.length ? lines.join('\n') : (hit.workout.note || hit.workout.name || '');
    renderWorkoutDraft();
    note.focus();
    showToast(`${shortDate(hit.date)} ${routine === '최근' ? '최근' : routine} 기록을 불러왔어요.${bumped ? ` ${bumped}종목은 한 단계 무게를 올렸어요.` : ''} 실제로 한 대로 고쳐 저장하세요.`);
  }

  function renderExerciseChips() {
    const box = $('#exerciseChips');
    if (!box) return;
    const state = readState();
    const counts = new Map();
    const latest = new Map();
    Object.keys(state.logs || {}).filter(validDate).sort().forEach(date => (state.logs[date].workouts || []).forEach(workout => workoutExercises(workout).forEach(exercise => {
      const key = exerciseKey(exercise.name);
      counts.set(key, (counts.get(key) || 0) + 1);
      latest.set(key, { exercise, rpe: workout.rpe });
    })));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key]) => latest.get(key));
    renderExerciseChips.items = top;
    box.innerHTML = top.length ? `<span>자주 한 운동 · 누르면 지난 기록이 한 줄 추가돼요</span><div>${top.map((item, index) => `<button type="button" data-exercise-chip="${index}">${esc(item.exercise.name)}</button>`).join('')}</div>` : '';
  }

  function addExerciseLine(index) {
    const item = renderExerciseChips.items?.[index];
    if (!item) return;
    const note = $('#workoutNote');
    const line = exerciseLine(item.exercise, overloadStep(item.exercise, item.rpe));
    note.value = note.value.trim() ? `${note.value.replace(/\s+$/, '')}\n${line}` : line;
    renderWorkoutDraft();
    note.focus();
  }

  function prefillWorkout(day) {
    const cardioMatch = String(day.cardio || '').match(/([가-힣a-zA-Z ]+?)\s*(\d+)\s*분/);
    const lines = (day.exercises || []).map(exercise => {
      const reps = parseInt(exercise.reps, 10) || 0;
      const sets = Math.max(1, Math.round(+exercise.sets || 1));
      return `${exercise.name} ${+exercise.weight ? `${+exercise.weight}kg ` : ''}${reps ? Array(sets).fill(reps).join('/') : `${sets}세트`}`;
    });
    if (cardioMatch) lines.push(`${cardioMatch[1].trim()} ${cardioMatch[2]}분`);
    $('#workoutNote').value = lines.join('\n');
    prefilledPlanDate = day.date;
    renderWorkoutDraft();
    if (location.hash !== '#workout') goTo('workout');
    setTimeout(() => $('#workoutForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    showToast('계획을 채워뒀어요. 실제로 한 무게·횟수로 고쳐서 저장하세요.');
  }

  function installWorkoutForm() {
    const note = $('#workoutNote');
    if (!note || note.dataset.enhanced) return;
    note.dataset.enhanced = 'true';
    note.addEventListener('input', () => {
      renderWorkoutDraft();
      $('#workoutNotice').classList.remove('warn');
    });
    ['#workoutMinutes', '#workoutKcal'].forEach(selector => $(selector)?.addEventListener('input', renderWorkoutDraft));
    document.querySelectorAll('[data-rpe]').forEach(button => button.addEventListener('click', () => {
      setRpe(selectedRpe === +button.dataset.rpe ? null : +button.dataset.rpe);
      renderWorkoutDraft();
    }));
    $('#workoutForm')?.addEventListener('click', event => {
      const routine = event.target.closest('[data-routine]');
      if (routine) { loadRoutine(routine.dataset.routine); return; }
      const chip = event.target.closest('[data-exercise-chip]');
      if (chip) addExerciseLine(+chip.dataset.exerciseChip);
    });
    $('#saveWorkout').onclick = saveWorkoutRecord;
    $('#workoutForm')?.addEventListener('click', event => { if (event.target.closest('[data-workout-edit-cancel]')) { resetWorkoutForm(); showToast('수정을 취소했어요.'); } });
    setRpe(null);
    renderExerciseChips();
  }

  // ---- AI 주간 운동 계획 ----
  let planBusy = false;
  let selectedPlanDate = null;

  const currentPlan = (state = readState()) => state.profile?.weeklyPlan || null;
  const shortFocus = day => day.rest ? '휴식' : String(day.focus || '운동').split(/[\s·,/(]/)[0].slice(0, 4);

  function planDay(state, key) {
    for (const plan of [state.profile?.weeklyPlan, ...(state.profile?.planHistory || [])].filter(Boolean)) {
      const day = (plan.days || []).find(item => item.date === key);
      if (day) return day;
    }
    return null;
  }

  function dayState(state, day) {
    const today = dateKey(new Date());
    if ((state.logs?.[day.date]?.workouts || []).length) return 'done';
    if (day.rest) return 'rest';
    if (day.date < today) return 'missed';
    return day.date === today ? 'today' : 'planned';
  }

  function normalizePlanDay(day) {
    return {
      date: day.date,
      focus: String(day.focus || (day.rest ? '휴식' : '운동')),
      rest: Boolean(day.rest) || !(day.exercises || []).length && !/\d/.test(day.cardio || ''),
      exercises: (day.exercises || []).map(exercise => ({
        name: String(exercise.name || '운동'), weight: Math.max(0, Math.round((+exercise.weight || 0) * 10) / 10),
        sets: Math.min(10, Math.max(1, Math.round(+exercise.sets || 3))), reps: String(exercise.reps || '10'), note: String(exercise.note || '')
      })),
      cardio: String(day.cardio || '없음'),
      tip: String(day.tip || '')
    };
  }

  // ---- 개인 운동 규칙: 하체 빈도·축구 주 ----
  // 기본값은 "하체는 격주 1회, 축구를 못 하는 주에만"(사용자 요청). 더보기 → 목표 설정에서 바꿀 수 있다.
  const LEG_RULES = { 'alternate-soccer': '하체는 격주 1회 · 축구 없는 주에만', weekly: '하체 매주 1~2회', free: 'AI가 알아서' };
  const COACH_MODELS = [['gpt-5.6-terra', 'Terra · 균형(추천)'], ['gpt-5.6-sol', 'Sol · 고성능(느리고 비쌈)'], ['gpt-5.6-luna', 'Luna · 절약']];
  const trainingRules = state => ({ legs: 'alternate-soccer', custom: '', ...(state.profile?.trainingRules || {}) });
  const coachSettings = settings => ({ ...settings, model: settings.coachModel || 'gpt-5.6-terra' });
  const weekDates = weekStart => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const isLegExercise = exercise => !exercise.cardio && exercisePart(exercise.name) === '하체';

  function legDoneInWeek(state, weekStart) {
    return weekDates(weekStart).some(date => (state.logs?.[date]?.workouts || []).some(workout => workoutExercises(workout).some(isLegExercise)));
  }

  function soccerLoggedInWeek(state, weekStart) {
    return weekDates(weekStart).some(date => (state.logs?.[date]?.workouts || []).some(workout => /축구|풋살/.test(`${workout.group || ''} ${workout.note || ''}`)));
  }

  // 이번 주가 축구하는 주인지: 직접 고른 값 > 이번 주 축구 기록 > 지난주에 하체를 했으면 축구 주(격주)
  function soccerWeek(state, weekStart) {
    const saved = state.profile?.soccerWeeks?.[weekStart];
    if (typeof saved === 'boolean') return { soccer: saved, source: '직접 선택' };
    if (soccerLoggedInWeek(state, weekStart)) return { soccer: true, source: '축구 기록' };
    return { soccer: legDoneInWeek(state, addDays(weekStart, -7)), source: '격주 추정' };
  }

  function rulesPrompt(state, weekStart) {
    const rules = trainingRules(state);
    const lines = [];
    if (rules.legs === 'alternate-soccer') {
      const { soccer } = soccerWeek(state, weekStart);
      lines.push(soccer
        ? '이번 주는 축구하는 주다. 하체 근력운동(스쿼트·레그프레스·런지·레그컬·레그익스텐션 등)은 한 종목도 넣지 않는다. 축구가 하체 자극을 대신하므로 축구 전날은 상체도 가볍게 한다.'
        : '이번 주는 축구가 없는 주다. 하체 근력운동은 정확히 하루만 넣는다. 격주 1회라서 그날 하체 볼륨은 10~12세트로 충분히 주고, 지난 하체 기록을 기준으로 점진적 과부하를 적용한다.');
    } else if (rules.legs === 'weekly') lines.push('하체 근력운동을 매주 1~2회 넣는다.');
    if (rules.custom) lines.push(`사용자가 정한 고정 규칙: ${rules.custom}`);
    const history = [1, 2, 3, 4].map(back => {
      const start = addDays(weekStart, -7 * back);
      return `${shortDate(start)}주 축구${soccerLoggedInWeek(state, start) ? 'O' : 'X'}·하체${legDoneInWeek(state, start) ? 'O' : 'X'}`;
    }).join(', ');
    return lines.length ? `반드시 지킬 개인 규칙(다른 규칙보다 우선한다):\n- ${lines.join('\n- ')}\n최근 4주: ${history}` : '';
  }

  // AI가 규칙을 어겨도 앱이 바로잡는다.
  function enforceRules(days, state, weekStart) {
    const notes = [];
    if (trainingRules(state).legs !== 'alternate-soccer') return notes;
    const { soccer } = soccerWeek(state, weekStart);
    const stripLegs = (day, reason) => {
      const before = day.exercises.length;
      day.exercises = day.exercises.filter(exercise => !isLegExercise(exercise));
      if (day.exercises.length === before) return;
      notes.push(`${weekdayName(day.date)}요일 하체 종목을 뺐어요(${reason}).`);
      if (!day.exercises.length && !/\d/.test(day.cardio || '')) Object.assign(day, { rest: true, focus: '휴식', tip: day.tip || '가볍게 걷고 스트레칭으로 회복해요.' });
      else day.focus = day.focus.replace(/하체\s*[·,]?\s*/g, '').trim() || '상체';
    };
    if (soccer || legDoneInWeek(state, weekStart)) days.forEach(day => stripLegs(day, soccer ? '축구 주' : '이번 주 하체 완료'));
    else days.filter(day => day.exercises.some(isLegExercise)).slice(1).forEach(day => stripLegs(day, '하체는 주 1회'));
    if (!soccer && !legDoneInWeek(state, weekStart) && !days.some(day => day.exercises.some(isLegExercise))) notes.push('축구 없는 주인데 하체 운동일이 빠졌어요. 다시 짜기를 눌러보세요.');
    return notes;
  }

  async function generatePlan({ weekStart, dates, basePlan = null, reason = '직접 요청', auto = false }) {
    if (planBusy) return null;
    const settings = parse(localStorage.getItem(AI_KEY), {}) || {};
    if (!aiReady(settings)) { showToast('더보기에서 이메일로 로그인해 주세요.'); return null; }
    if (!dates.length) { showToast('이번 주에 남은 날이 없어요. 다음 주 계획을 받아보세요.'); return null; }
    planBusy = true;
    renderPlanCard();
    updatePlanHero();
    try {
      const state = readState();
      const info = state.profile?.recommendationContext || {};
      const coach = state.profile?.weeklyCoach;
      const pastDays = basePlan ? (basePlan.days || []).filter(day => day.date < dates[0]) : [];
      const prompt = [
        `다음 날짜의 운동 계획을 짠다: ${dates.map(date => `${date}(${weekdayName(date)})`).join(', ')}. days는 이 날짜들만 날짜마다 1개씩 순서대로 반환한다.`,
        `사용자: ${profileContextText(state)}`,
        `주간 운동 목표 ${state.profile?.workoutGoal || 4}회, 강도 ${state.profile?.trainingIntensity || '중간'}, 운동 가능 일정 ${info.schedule || '정보 없음'}, 부상·주의 ${info.injuries || '없음'}, 선호 ${info.trainingPreference || '정보 없음'}.`,
        `최근 14일 기록(체크인·식단·운동·메모):\n${recentLogText(state, 14)}`,
        rulesPrompt(state, weekStart),
        `종목별 최근 수행(최근 4회):\n${exerciseHistoryText(state, 4)}`,
        `최근 7일 지표:\n${metricsText(weeklyMetrics(state))}`,
        coach ? `지난 주간 리포트: ${coach.headline || ''} / 조정할 점: ${(coach.adjustments || []).join(' ')} / 다음 행동: ${(coach.nextActions || []).join(' ')}` : '',
        pastDays.length ? `이번 주 이미 지난 날: ${pastDays.map(day => `${weekdayName(day.date)} ${day.rest ? '휴식' : day.focus} → ${(state.logs?.[day.date]?.workouts || []).length ? '수행함' : '못 함'}`).join(', ')}. 못 한 운동의 핵심 부위를 남은 날에 우선 배치하되 같은 부위를 연달아 두지 말고 하루 운동량을 과하게 늘리지 않는다.` : '',
        '규칙: 1) 점진적 과부하 — 직전 수행에서 목표 횟수를 채우고 RPE 8 이하였다면 상체 +2.5kg, 하체 +5kg 또는 세트당 1~2회 증가. RPE 9 이상, 수면 6시간 미만, 컨디션 나쁨, 통증 메모가 있으면 유지하거나 5~10% 낮춘다. 3~4주 연속 증량했고 피로 신호가 있으면 디로드한다. 2) 기록이 없는 종목은 보수적인 시작 무게. 3) 부위별 주간 세트 10~20, 같은 부위는 48시간 휴식. 4) 운동 가능 요일에 맞추고 나머지는 rest=true, exercises는 빈 배열, focus는 휴식, tip에 회복 활동. 5) 각 종목 note에 과부하 근거를 짧게(예: 지난주 40kg×14×4 RPE8 → +2.5kg). weight는 kg 숫자(맨몸 0), reps는 8 또는 8-10 형식. 6) cardio는 유산소가 있으면 러닝 20분처럼, 없으면 없음. 7) principle에 이번 주 과부하 전략을 한두 문장으로. 8) title은 12자 이내.'
      ].filter(Boolean).join('\n\n');
      const result = await analyzeWithAi(coachSettings(settings), prompt, 'plan', false);
      if (!Array.isArray(result?.days) || !result.days.length) throw new Error('AI 서버 함수가 이전 버전이에요. Supabase에 새 함수를 배포해 주세요.');
      const days = dates.map((date, index) => {
        const found = result.days.find(day => day.date === date) || result.days[index];
        return found ? normalizePlanDay({ ...found, date }) : normalizePlanDay({ date, rest: true, exercises: [] });
      });
      const ruleNotes = enforceRules(days, readState(), weekStart);
      const next = readState();
      next.profile ||= {};
      const previous = next.profile.weeklyPlan;
      if (previous && previous.weekStart !== weekStart) next.profile.planHistory = [previous, ...(next.profile.planHistory || [])].slice(0, 4);
      const kept = basePlan?.weekStart === weekStart ? (basePlan.days || []).filter(day => day.date < dates[0]) : [];
      const now = new Date().toISOString();
      next.profile.weeklyPlan = {
        weekStart, title: String(result.title || '이번 주 계획'), summary: String(result.summary || ''), principle: String(result.principle || ''),
        days: [...kept, ...days].sort((a, b) => a.date.localeCompare(b.date)),
        createdAt: kept.length ? basePlan.createdAt : now, updatedAt: now, reason, auto,
        soccer: soccerWeek(next, weekStart).soccer, ruleNotes
      };
      writeState(next);
      selectedPlanDate = null;
      window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
      showToast(kept.length ? '남은 요일 계획을 다시 짰어요.' : 'AI 주간 계획이 준비됐어요.');
      return next.profile.weeklyPlan;
    } catch (error) {
      if (!auto) showToast(error.message || '계획을 만들지 못했어요.');
      return null;
    } finally {
      planBusy = false;
      renderPlanCard();
      updatePlanHero();
    }
  }

  function planThisWeek() {
    const state = readState();
    const weekStart = mondayKey();
    const today = dateKey(new Date());
    const plan = currentPlan(state);
    const doneToday = (state.logs?.[today]?.workouts || []).length > 0;
    const dates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)).filter(date => date > today || (date === today && !doneToday));
    return generatePlan({ weekStart, dates, basePlan: plan?.weekStart === weekStart ? plan : null, reason: plan?.weekStart === weekStart ? '남은 요일 재조정' : '직접 요청' });
  }

  function planNextWeek(auto = false) {
    const weekStart = addDays(mondayKey(), 7);
    return generatePlan({ weekStart, dates: Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), reason: auto ? '일요일 자동 계획' : '다음 주 미리 받기', auto });
  }

  async function runScheduledPlan(dueKey) {
    const state = readState();
    const weekStart = addDays(dueKey, 1);
    const today = dateKey(new Date());
    if (state.profile?.planScheduleKey === dueKey) return;
    const markDone = () => { const next = readState(); next.profile ||= {}; next.profile.planScheduleKey = dueKey; writeState(next); };
    if (state.profile?.weeklyPlan?.weekStart === weekStart) return markDone();
    const dates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)).filter(date => date >= today);
    const plan = await generatePlan({ weekStart, dates, reason: '일요일 자동 계획', auto: true });
    if (plan) markDone();
  }

  function planDayMarkup(day, state) {
    const status = dayState(state, day);
    const today = dateKey(new Date());
    if (day.rest) return `<div class="plan-detail rest"><strong>${weekdayName(day.date)}요일 · 휴식</strong><p>${esc(day.tip || '가벼운 걷기와 스트레칭으로 회복해요.')}</p></div>`;
    return `<div class="plan-detail">
      <div class="plan-detail-head"><strong>${weekdayName(day.date)}요일 · ${esc(day.focus)}</strong>${status === 'done' ? '<i class="badge up">완료</i>' : status === 'missed' ? '<i class="badge down">놓침</i>' : ''}</div>
      <ol class="plan-exercises">${day.exercises.map(exercise => `<li><div><strong>${esc(exercise.name)}</strong>${exercise.note ? `<small>${esc(exercise.note)}</small>` : ''}</div><b>${exercise.weight ? `${exercise.weight}kg · ` : ''}${esc(exercise.reps)}회 × ${exercise.sets}</b></li>`).join('')}</ol>
      ${day.cardio && day.cardio !== '없음' ? `<p class="plan-note">🏃 ${esc(day.cardio)}</p>` : ''}
      ${day.tip ? `<p class="plan-note">💡 ${esc(day.tip)}</p>` : ''}
      ${day.date === today && status !== 'done' ? `<button class="primary mint full" data-plan-action="log" data-date="${day.date}">이 계획으로 기록하기</button>` : ''}
    </div>`;
  }

  function soccerRow(state, weekStart, plan) {
    const rules = trainingRules(state);
    if (rules.legs !== 'alternate-soccer') return `<p class="plan-rule">🦵 ${LEG_RULES[rules.legs]}${rules.custom ? ` · ${esc(rules.custom)}` : ''}</p>`;
    const { soccer, source } = soccerWeek(state, weekStart);
    const stale = plan && plan.weekStart === weekStart && typeof plan.soccer === 'boolean' && plan.soccer !== soccer;
    return `<div class="soccer-row"><span>⚽ ${shortDate(weekStart)}주 축구 <small>${source}</small></span><div><button type="button" class="${soccer ? 'on' : ''}" data-soccer="${weekStart}" data-value="1">있음</button><button type="button" class="${soccer ? '' : 'on'}" data-soccer="${weekStart}" data-value="0">없음</button></div></div>
      <p class="plan-rule">🦵 ${soccer ? '축구 주 → 하체 근력운동은 쉬어요' : '축구 없는 주 → 하체 1회'}${stale ? ' · <b>계획과 달라요. 다시 짜기를 눌러주세요</b>' : ''}</p>`;
  }

  function renderPlanCard() {
    const card = $('#planCard');
    if (!card) return;
    if (planBusy) {
      card.innerHTML = '<div class="plan-loading"><span class="spinner dark"></span><strong>AI 코치가 계획을 짜는 중…</strong><small>지난 운동량과 컨디션을 반영하고 있어요. 30초쯤 걸려요.</small></div>';
      return;
    }
    const state = readState();
    const plan = currentPlan(state);
    const today = dateKey(new Date());
    const thisWeek = mondayKey();
    if (!plan || !(plan.days || []).some(day => day.date >= thisWeek)) {
      card.innerHTML = `<div class="plan-empty"><span class="plan-eyebrow">AI 주간 계획</span><strong>이번 주 운동 계획이 없어요</strong><small>지난 운동량·컨디션·메모와 나만의 운동 규칙을 바탕으로 점진적 과부하 계획을 짜드려요. 매주 일요일 밤 11시에는 다음 주 계획이 자동으로 만들어져요.</small>${soccerRow(state, thisWeek, null)}<button class="primary" data-plan-action="week">이번 주 계획 받기</button></div>`;
      return;
    }
    if (!plan.days.some(day => day.date === selectedPlanDate)) selectedPlanDate = (plan.days.find(day => day.date >= today) || plan.days[0]).date;
    const day = plan.days.find(item => item.date === selectedPlanDate);
    const isCurrent = plan.weekStart === thisWeek;
    const missed = isCurrent ? plan.days.filter(item => dayState(state, item) === 'missed') : [];
    const week = Array.from({ length: 7 }, (_, index) => addDays(plan.weekStart, index));
    card.innerHTML = `
      <div class="plan-head"><div><span class="plan-eyebrow">AI 주간 계획 · ${shortDate(plan.weekStart)}~${shortDate(addDays(plan.weekStart, 6))}</span><strong>${esc(plan.title)}</strong></div>${isCurrent ? '<button class="link" data-plan-action="week">다시 짜기</button>' : '<span class="badge">다음 주</span>'}</div>
      ${soccerRow(state, plan.weekStart, plan)}
      ${plan.principle ? `<p class="plan-principle">📈 ${esc(plan.principle)}</p>` : ''}
      ${(plan.ruleNotes || []).length ? `<p class="plan-rule-note">✂️ ${plan.ruleNotes.map(esc).join(' ')}</p>` : ''}
      ${missed.length ? `<div class="plan-alert"><span>${missed.map(item => weekdayName(item.date)).join('·')}요일 운동을 놓쳤어요.</span><button type="button" data-plan-action="week">남은 요일 다시 짜기</button></div>` : ''}
      <div class="plan-strip">${week.map(date => {
        const item = plan.days.find(entry => entry.date === date);
        const status = item ? dayState(state, item) : (state.logs?.[date]?.workouts || []).length ? 'done' : 'none';
        const mark = status === 'done' ? '✓' : status === 'missed' ? '!' : +date.slice(8);
        return `<button type="button" class="plan-day ${status} ${date === selectedPlanDate ? 'selected' : ''} ${date === today ? 'is-today' : ''}" data-plan-day="${date}" ${item ? '' : 'disabled'}><span>${weekdayName(date)}</span><b>${mark}</b><small>${item ? esc(shortFocus(item)) : ''}</small></button>`;
      }).join('')}</div>
      ${day ? planDayMarkup(day, state) : ''}
      ${new Date().getDay() === 0 && isCurrent ? '<button class="ghost full" data-plan-action="next">다음 주 계획 미리 받기</button>' : ''}`;
  }

  function installPlanActions() {
    if (document.body.dataset.planActions) return;
    document.body.dataset.planActions = 'true';
    document.addEventListener('click', event => {
      const soccerButton = event.target.closest('[data-soccer]');
      if (soccerButton) {
        const next = readState();
        next.profile ||= {};
        next.profile.soccerWeeks = { ...(next.profile.soccerWeeks || {}), [soccerButton.dataset.soccer]: soccerButton.dataset.value === '1' };
        writeState(next);
        renderPlanCard();
        showToast(soccerButton.dataset.value === '1' ? '축구 주로 표시했어요. 하체 근력운동은 빼고 짜요.' : '축구 없는 주로 표시했어요. 하체를 1회 넣어 짜요.');
        return;
      }
      const dayButton = event.target.closest('[data-plan-day]');
      if (dayButton) { selectedPlanDate = dayButton.dataset.planDay; renderPlanCard(); return; }
      const action = event.target.closest('[data-plan-action]');
      if (!action) return;
      const kind = action.dataset.planAction;
      if (kind === 'week') planThisWeek();
      if (kind === 'next') planNextWeek(false);
      if (kind === 'log') {
        const day = planDay(readState(), action.dataset.date || dateKey(new Date()));
        if (day) prefillWorkout(day);
      }
    });
  }

  // ---- 아침 체크인 ----
  let checkinEditing = false;

  function renderCheckin() {
    const card = $('#checkin');
    if (!card) return;
    const state = readState();
    const log = state.logs?.[dateKey(new Date())] || {};
    const complete = +log.weight && +log.sleep && log.condition;
    if (complete && !checkinEditing) {
      card.className = 'card checkin done';
      card.innerHTML = `<span class="checkin-title">☀️ 오늘 체크인</span><b>${log.weight}kg · ${log.sleep}시간 · ${conditionText(log.condition)}</b><button type="button" class="link" data-checkin-edit>수정</button>`;
      return;
    }
    card.className = 'card checkin';
    card.innerHTML = `
      <div class="checkin-head"><strong>☀️ 아침 체크인</strong><small>AI 코칭에 반영돼요</small><span class="checkin-saved" id="checkinSaved"></span></div>
      <div class="checkin-grid">
        <label><span>공복 체중</span><div class="unit-input"><input id="ciWeight" inputmode="decimal" value="${esc(log.weight || '')}" placeholder="${latestBodyWeight(state)}"><b>kg</b></div></label>
        <label><span>수면</span><div class="unit-input"><input id="ciSleep" inputmode="decimal" value="${esc(log.sleep || '')}" placeholder="7"><b>시간</b></div></label>
      </div>
      <div class="condition-chips" role="radiogroup" aria-label="컨디션">${Object.entries(CONDITIONS).map(([value, [emoji, label]]) => `<button type="button" data-condition="${value}" class="${+log.condition === +value ? 'on' : ''}" aria-label="컨디션 ${label}"><span>${emoji}</span><small>${label}</small></button>`).join('')}</div>
      <button type="button" class="primary mint small full checkin-save" data-checkin-save>체크인 저장</button>`;
  }

  const parseSleep = raw => {
    const text = String(raw || '').trim();
    const clock = text.match(/^(\d{1,2})[:시]\s*(\d{1,2})?/);
    return clock ? +clock[1] + (+clock[2] || 0) / 60 : +text.replace(',', '.');
  };

  // 저장 버튼: 적은 칸을 한 번에 저장하고 요약으로 접는다.
  function saveCheckinForm() {
    const card = $('#checkin');
    const weightRaw = $('#ciWeight')?.value.trim();
    const sleepRaw = $('#ciSleep')?.value.trim();
    const condition = +card.querySelector('[data-condition].on')?.dataset.condition || null;
    const patch = {};
    if (weightRaw) {
      const weight = +weightRaw.replace(',', '.');
      if (!(weight >= 20 && weight <= 300)) return showToast('체중을 kg 단위로 적어주세요.');
      patch.weight = Math.round(weight * 10) / 10;
    }
    if (sleepRaw) {
      const hours = parseSleep(sleepRaw);
      if (!(hours > 0 && hours <= 16)) return showToast('수면 시간을 숫자로 적어주세요. 예: 7.5');
      patch.sleep = Math.round(hours * 10) / 10;
    }
    if (condition) patch.condition = condition;
    if (!Object.keys(patch).length) return showToast('공복 체중·수면·컨디션 중 하나 이상 적어주세요.');
    saveCheckin(patch);
    checkinEditing = false;
    renderCheckin();
    updateMascot();
    window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
    showToast('아침 체크인을 저장했어요.');
  }

  function saveCheckin(patch) {
    const state = readState();
    const today = dateKey(new Date());
    state.logs ||= {};
    state.logs[today] ||= { meals: [], workouts: [] };
    Object.assign(state.logs[today], patch);
    writeState(state);
    const saved = $('#checkinSaved');
    if (saved) saved.textContent = '저장됨 ✓';
    const log = state.logs[today];
    if (+log.weight && +log.sleep && log.condition) {
      checkinEditing = false;
      setTimeout(() => { renderCheckin(); updateMascot(); }, 700);
    }
  }

  function installCheckin() {
    const card = $('#checkin');
    if (!card || card.dataset.enhanced) return;
    card.dataset.enhanced = 'true';
    card.addEventListener('click', event => {
      if (event.target.closest('[data-checkin-edit]')) { checkinEditing = true; renderCheckin(); return; }
      if (event.target.closest('[data-checkin-save]')) { saveCheckinForm(); return; }
      const chip = event.target.closest('[data-condition]');
      if (!chip) return;
      card.querySelectorAll('[data-condition]').forEach(button => button.classList.toggle('on', button === chip));
      saveCheckin({ condition: +chip.dataset.condition });
    });
    card.addEventListener('change', event => {
      if (event.target.id === 'ciWeight') {
        const weight = +String(event.target.value).replace(',', '.');
        if (weight >= 20 && weight <= 300) saveCheckin({ weight: Math.round(weight * 10) / 10 });
        else if (event.target.value) showToast('체중을 kg 단위로 적어주세요.');
      }
      if (event.target.id === 'ciSleep') {
        const raw = String(event.target.value).trim();
        const clock = raw.match(/^(\d{1,2})[:시]\s*(\d{1,2})?/);
        const hours = clock ? +clock[1] + (+clock[2] || 0) / 60 : +raw.replace(',', '.');
        if (hours > 0 && hours <= 16) saveCheckin({ sleep: Math.round(hours * 10) / 10 });
        else if (raw) showToast('수면 시간을 숫자로 적어주세요. 예: 7.5');
      }
    });
    renderCheckin();
  }

  function installUserContext() {
    const more = $('[data-view="more"] .content');
    const firstCard = more?.querySelector('.card.form');
    if (!more || !firstCard || $('#recommendationProfile')) return;
    const state = readState();
    const info = state.profile?.recommendationContext || {};
    firstCard.classList.add('hidden');
    const section = document.createElement('details');
    section.id = 'recommendationProfile';
    section.className = 'card settings-fold recommendation-profile';
    section.innerHTML = `
      <summary><span class="fold-icon">🎯</span><span><strong>목표 설정과 나의 정보</strong><small>한 번 입력하면 AI가 식단·운동 기준을 계산해요</small></span><b>›</b></summary>
      <div class="fold-content">
        <section class="profile-step"><span>1</span><div><strong>기본 정보</strong><small>필요한 계산에만 사용해요.</small></div></section>
        <div class="profile-detail-grid">
          <label class="field full-field"><span>이름</span><input class="input" id="ctxName" value="${esc(state.profile?.name || '')}"></label>
          <label class="field"><span>성별</span><select class="select" id="ctxSex"><option value="">선택 안 함</option><option ${info.sex === '남성' ? 'selected' : ''}>남성</option><option ${info.sex === '여성' ? 'selected' : ''}>여성</option><option ${info.sex === '기타·비공개' ? 'selected' : ''}>기타·비공개</option></select></label>
          <label class="field"><span>출생연도</span><input class="input" id="ctxBirth" inputmode="numeric" value="${esc(info.birthYear || '')}" placeholder="예: 1995"></label>
          <label class="field"><span>키 cm</span><input class="input" id="ctxHeight" inputmode="decimal" value="${esc(info.height || '')}" placeholder="예: 175"></label>
          <label class="field"><span>현재 체중 kg</span><input class="input" id="ctxWeight" inputmode="decimal" value="${esc(info.weight || '')}" placeholder="예: 72.5"></label>
        </div>
        <section class="profile-step"><span>2</span><div><strong>원하는 변화</strong><small>선택하지 말고 본인의 말로 구체적으로 적어주세요.</small></div></section>
        <label class="field"><span>목표</span><textarea class="textarea goal-text" id="ctxGoal" placeholder="예: 근육량 증가와 체지방 감소를 동시에 하고 싶어요. 체중보다 허리둘레와 운동 수행능력이 중요해요.">${esc(info.goalStatement || info.goal || '')}</textarea></label>
        <div class="profile-detail-grid">
          <label class="field"><span>목표 기간</span><input class="input" id="ctxDeadline" value="${esc(info.goalDeadline || '')}" placeholder="예: 12주"></label>
          <label class="field"><span>가장 중요한 기준</span><input class="input" id="ctxPriority" value="${esc(info.goalPriority || '')}" placeholder="예: 체지방률"></label>
        </div>
        <section class="profile-step"><span>3</span><div><strong>생활과 운동 조건</strong><small>실제로 지킬 수 있는 계획을 만드는 기준이에요.</small></div></section>
        <label class="field"><span>직업·평소 움직임</span><input class="input" id="ctxActivityDetail" value="${esc(info.activityDetail || '')}" placeholder="예: 사무직, 하루 평균 7천 보"></label>
        <label class="field"><span>운동 경력</span><input class="input" id="ctxExperience" value="${esc(info.experience || '')}" placeholder="예: 웨이트 2년, 축구 주 1회"></label>
        <label class="field"><span>운동 가능한 요일·시간</span><input class="input" id="ctxSchedule" value="${esc(info.schedule || '')}" placeholder="예: 월·화·목·금, 회당 60분"></label>
        <label class="field"><span>선호 운동·싫어하는 운동</span><input class="input" id="ctxTrainingPreference" value="${esc(info.trainingPreference || '')}" placeholder="예: 머신 선호, 장거리 달리기는 어려움"></label>
        <label class="field"><span>평균 수면과 회복</span><input class="input" id="ctxSleep" value="${esc(info.sleep || '')}" placeholder="예: 6시간 30분, 평일 피로가 큼"></label>
        <label class="field"><span>부상·통증·주의사항</span><textarea class="textarea compact" id="ctxInjuries" placeholder="예: 오른쪽 무릎 통증">${esc(info.injuries || '')}</textarea></label>
        <label class="field"><span>평소 식사 패턴·알레르기·피하는 음식</span><textarea class="textarea compact" id="ctxDiet" placeholder="예: 평일 점심은 급식, 유제품 알레르기, 생선 선호">${esc(info.diet || '')}</textarea></label>
        <section class="profile-step"><span>4</span><div><strong>나만의 운동 규칙</strong><small>AI 주간 계획이 매주 반드시 지켜요.</small></div></section>
        <label class="field"><span>하체 운동</span><select class="select" id="ctxLegRule">${Object.entries(LEG_RULES).map(([value, label]) => `<option value="${value}" ${trainingRules(state).legs === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="field"><span>그 밖의 고정 규칙</span><textarea class="textarea compact" id="ctxCustomRules" placeholder="예: 수요일은 운동 안 함, 데드리프트는 빼기, 한 번에 60분 이내">${esc(trainingRules(state).custom || '')}</textarea></label>
        <label class="field"><span>AI 코칭 모델 <small>주간 계획·리포트·조언에 사용</small></span><select class="select" id="ctxCoachModel">${COACH_MODELS.map(([value, label]) => `<option value="${value}" ${(parse(localStorage.getItem(AI_KEY), {}) || {}).coachModel === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <button type="button" class="primary mint full" id="saveRecommendationProfile">정보 저장</button>
        <div id="currentAiTargets">${targetSummary(state)}</div>
        <button type="button" class="primary full" id="analyzeMyGoal">AI가 목표 영양·운동 기준 계산</button>
        <p class="notice" id="goalAnalysisNotice">입력한 목표와 최신 인바디를 함께 분석해요.</p>
      </div>`;
    firstCard.insertAdjacentElement('afterend', section);
    const saveProfileFields = () => {
      const next = readState();
      next.profile ||= {};
      next.profile.name = $('#ctxName').value.trim();
      next.profile.recommendationContext = {
        sex: $('#ctxSex').value,
        birthYear: $('#ctxBirth').value.trim(),
        height: $('#ctxHeight').value.trim(),
        weight: $('#ctxWeight').value.trim(),
        goalStatement: $('#ctxGoal').value.trim(),
        goalDeadline: $('#ctxDeadline').value.trim(),
        goalPriority: $('#ctxPriority').value.trim(),
        activityDetail: $('#ctxActivityDetail').value.trim(),
        experience: $('#ctxExperience').value.trim(),
        schedule: $('#ctxSchedule').value.trim(),
        trainingPreference: $('#ctxTrainingPreference').value.trim(),
        sleep: $('#ctxSleep').value.trim(),
        injuries: $('#ctxInjuries').value.trim(),
        diet: $('#ctxDiet').value.trim()
      };
      next.profile.trainingRules = { legs: $('#ctxLegRule').value, custom: $('#ctxCustomRules').value.trim() };
      writeState(next);
      // 코칭 모델은 AI 설정에 저장한다(로그인하면 계정으로 동기화된다). 기록 저장 뒤에 해야 덮어쓰지 않는다.
      const aiSettings = parse(localStorage.getItem(AI_KEY), {}) || {};
      aiSettings.coachModel = $('#ctxCoachModel').value;
      localStorage.setItem(AI_KEY, JSON.stringify(aiSettings));
      window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
      return next;
    };
    $('#saveRecommendationProfile').onclick = () => {
      saveProfileFields();
      showToast('추천용 나의 정보를 저장했어요.');
    };
    $('#analyzeMyGoal').onclick = async () => {
      const state = saveProfileFields();
      const goal = state.profile?.recommendationContext?.goalStatement;
      const notice = $('#goalAnalysisNotice');
      const button = $('#analyzeMyGoal');
      if (!goal) return notice.textContent = '먼저 원하는 목표를 본인의 말로 적어주세요.';
      const settings = parse(localStorage.getItem(AI_KEY), {}) || {};
      button.disabled = true;
      button.textContent = 'AI 코치가 기준을 계산하는 중…';
      notice.textContent = '목표·생활패턴·인바디를 함께 분석하고 있어요.';
      try {
        const prompt = `대한민국 최고 수준의 스포츠영양·피트니스 코치처럼 안전하고 현실적으로 설계한다. 사용자 정보: ${profileContextText(state)}. 현재 목표값: ${JSON.stringify(state.profile?.targets || {})}, 주간 운동 ${state.profile?.workoutGoal || 4}회. 현재 상태와 자유롭게 적은 목표에 맞는 하루 kcal, 단백질g, 탄수g, 지방g, 주간 운동횟수, 운동강도를 결정한다. 급격한 감량과 의학적 진단은 피한다. 최근 기록: ${recentLogText(state, 7).slice(0, 900)}`;
        const coaching = await analyzeCoachingSafely(settings, prompt, 'goal');
        const result = coaching.result;
        const latest = readState();
        const plan = coaching.plan ? {
          kcal: clamp(coaching.plan.kcal, 1200, 4500, latest.profile?.targets?.kcal || 2200),
          protein: clamp(coaching.plan.protein, 40, 350, latest.profile?.targets?.protein || 153),
          carbs: clamp(coaching.plan.carbs, 60, 650, latest.profile?.targets?.carbs || 260),
          fat: clamp(coaching.plan.fat, 30, 180, latest.profile?.targets?.fat || 61),
          workouts: clamp(coaching.plan.workouts, 1, 7, latest.profile?.workoutGoal || 4),
          intensity: ['낮음', '중간', '높음'].includes(coaching.plan.intensity) ? coaching.plan.intensity : (latest.profile?.trainingIntensity || '중간')
        } : null;
        if (!plan) throw new Error('AI 목표 숫자를 읽지 못했어요. 다시 시도해 주세요.');
        saveAiTargets(latest, plan, result.summary || 'AI 목표 분석');
        writeState(latest);
        $('#currentAiTargets').innerHTML = targetSummary(latest);
        notice.textContent = result.summary || '목표 기준을 새로 계산했어요.';
        window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
      } catch (error) {
        notice.textContent = error.message || '목표를 계산하지 못했어요.';
      } finally {
        button.disabled = false;
        button.textContent = 'AI가 목표 영양·운동 기준 다시 계산';
      }
    };
  }

  function installMealRecommendation() {
    const trigger = $('#recommend');
    const mealPhoto = $('[data-view="meals"] .photo');
    if (!trigger || !mealPhoto || $('#mealRecommendation')) return;
    const panel = document.createElement('section');
    panel.id = 'mealRecommendation';
    panel.className = 'card meal-recommendation';
    panel.innerHTML = '<div class="recommend-loading"><strong>남은 끼니 추천</strong><span>홈에서 추천받기를 눌러주세요.</span></div>';
    mealPhoto.insertAdjacentElement('afterend', panel);

    trigger.onclick = async () => {
      location.hash = 'meals';
      document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.dataset.view === 'meals'));
      document.querySelectorAll('.nav [data-go]').forEach(button => button.classList.toggle('active', button.dataset.go === 'home'));
      const state = readState();
      const today = dateKey(new Date());
      const meals = state.logs?.[today]?.meals || [];
      const eaten = meals.reduce((sum, item) => ({
        kcal: sum.kcal + (+item.kcal || 0), protein: sum.protein + (+item.protein || 0),
        carbs: sum.carbs + (+item.carbs || 0), fat: sum.fat + (+item.fat || 0)
      }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
      const targets = state.profile?.targets || { kcal: 2200, protein: 153, carbs: 260, fat: 61 };
      const types = remainingMealTypes(meals);
      const settings = parse(localStorage.getItem(AI_KEY), {}) || {};
      panel.classList.add('show');
      panel.innerHTML = '<div class="recommend-loading"><span class="spinner dark"></span><strong>남은 끼니를 맞추는 중…</strong><span>오늘 기록과 목표를 함께 계산하고 있어요.</span></div>';
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      try {
        const prompt = `사용자 정보: ${profileContextText(state)}. 현재 시간 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}. 오늘 먹은 음식: ${meals.map(item => `${item.meal} ${item.name} ${item.kcal}kcal`).join(', ') || '없음'}. 섭취 합계: ${Math.round(eaten.kcal)}kcal, 단백질 ${Math.round(eaten.protein)}g, 탄수 ${Math.round(eaten.carbs)}g, 지방 ${Math.round(eaten.fat)}g. 하루 목표: ${targets.kcal}kcal, 단백질 ${targets.protein}g, 탄수 ${targets.carbs}g, 지방 ${targets.fat}g. 추천할 남은 끼니: ${types.join(', ')}. 오늘·어제 체크인과 운동: ${recentLogText(state, 2)}. 운동한 날은 회복용 단백질·탄수화물을 충분히 넣고, 목표, 알레르기, 부상과 취향을 지키면서 목표를 과하게 넘지 않는 현실적인 한국식 메뉴를 끼니별로 추천한다.`;
        const result = await analyzeWithAi(settings, prompt, 'recommend');
        const suggestions = Array.isArray(result.meals) ? result.meals : [];
        panel.innerHTML = `<div class="recommend-head"><div><span>오늘의 남은 끼니</span><strong>${esc(result.title || '가볍고 든든하게')}</strong></div><small>${esc(result.summary || '')}</small></div>
          <div class="recommend-list">${suggestions.map((item, index) => `<article><div><span>${esc(item.mealType)}</span><strong>${esc(item.name)}</strong><small>${esc(item.portion)} · ${Math.round(+item.kcal || 0)} kcal</small></div><button type="button" data-use-recommend="${index}">입력</button><p>${esc(item.reason || '')}</p></article>`).join('')}</div>`;
        panel.querySelectorAll('[data-use-recommend]').forEach(button => {
          button.onclick = () => {
            const item = suggestions[+button.dataset.useRecommend];
            const text = $('#aiMealText');
            if (text) text.value = `${item.name} ${item.portion}`;
            const radio = $(`[name="aiMealType"][value="${item.mealType}"]`);
            if (radio) radio.checked = true;
            $('#aiMealComposer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          };
        });
      } catch (error) {
        panel.innerHTML = `<div class="recommend-loading bad"><strong>추천을 불러오지 못했어요.</strong><span>${esc(error.message || '잠시 후 다시 시도해 주세요.')}</span><button type="button" id="retryRecommend">다시 시도</button></div>`;
        $('#retryRecommend').onclick = () => trigger.click();
      }
    };
  }

  function normalizedMealItems(result) {
    const source = Array.isArray(result?.items) ? result.items : [result];
    return source.filter(Boolean).map((item, index) => ({
      key: `${Date.now()}-${index}`,
      name: String(item.name || `음식 ${index + 1}`),
      referenceAmount: String(item.referenceAmount || item.amount || '추천 1인분'),
      servings: Math.max(.25, Math.round((+item.servings || 1) * 4) / 4),
      kcalPerServing: Math.max(0, +item.kcalPerServing || +item.kcal || 0),
      proteinPerServing: Math.max(0, +item.proteinPerServing || +item.protein || 0),
      carbsPerServing: Math.max(0, +item.carbsPerServing || +item.carbs || 0),
      fatPerServing: Math.max(0, +item.fatPerServing || +item.fat || 0),
      confidence: item.confidence || '보통'
    }));
  }

  const actualNutrition = item => ({
    kcal: Math.round(item.kcalPerServing * item.servings),
    protein: Math.round(item.proteinPerServing * item.servings * 10) / 10,
    carbs: Math.round(item.carbsPerServing * item.servings * 10) / 10,
    fat: Math.round(item.fatPerServing * item.servings * 10) / 10
  });

  function renderMealPreview() {
    const preview = $('#aiMealPreview');
    if (!preview) return;
    if (!pendingMealItems.length) {
      preview.classList.remove('show');
      preview.innerHTML = '';
      return;
    }
    preview.classList.add('show');
    preview.innerHTML = `
      <div class="analysis-head"><div><span>음식별 분석 결과</span><strong>${pendingMealItems.length}개 음식</strong></div><small>각 항목을 수정한 뒤 저장하세요.</small></div>
      <div class="analysis-items">${pendingMealItems.map((item, index) => {
        const value = actualNutrition(item);
        return `<article class="analysis-item" data-analysis-index="${index}">
          <label><span>음식 이름</span><input class="input" data-meal-field="name" value="${esc(item.name)}"></label>
          <label><span>추천 기준량</span><input class="input" data-meal-field="referenceAmount" value="${esc(item.referenceAmount)}"></label>
          <div class="portion-row"><div><span>먹은 양</span><strong>${item.servings}인분</strong></div><div class="portion-stepper"><button type="button" data-portion="-.25">−</button><button type="button" data-portion=".25">＋</button></div></div>
          <div class="nutrition-edit">
            <label><span>1인분 kcal</span><input inputmode="decimal" data-meal-field="kcalPerServing" value="${item.kcalPerServing}"></label>
            <label><span>단백질 g</span><input inputmode="decimal" data-meal-field="proteinPerServing" value="${item.proteinPerServing}"></label>
            <label><span>탄수 g</span><input inputmode="decimal" data-meal-field="carbsPerServing" value="${item.carbsPerServing}"></label>
            <label><span>지방 g</span><input inputmode="decimal" data-meal-field="fatPerServing" value="${item.fatPerServing}"></label>
          </div>
          <p class="analysis-total">현재 양 기준 <b>${value.kcal} kcal</b> · 단백질 ${value.protein}g · 탄수 ${value.carbs}g · 지방 ${value.fat}g</p>
        </article>`;
      }).join('')}</div>
      <button type="button" class="primary mint full" id="saveAnalyzedMeals">${editingMealId ? '수정 내용 저장' : `${pendingMealItems.length}개 음식 저장`}</button>`;
  }

  function mealRecord(item, meal, id) {
    const value = actualNutrition(item);
    return {
      id: id || crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      meal,
      name: item.name,
      amount: `${item.servings}인분 · ${item.referenceAmount}`,
      servings: item.servings,
      referenceAmount: item.referenceAmount,
      kcalPerServing: item.kcalPerServing,
      proteinPerServing: item.proteinPerServing,
      carbsPerServing: item.carbsPerServing,
      fatPerServing: item.fatPerServing,
      ...value,
      src: 'ai',
      confidence: item.confidence || '보통'
    };
  }

  function enhanceMealList() {
    $('#mealList')?.querySelectorAll('[data-del-meal]').forEach(button => {
      if (button.parentElement.querySelector('[data-edit-meal]')) return;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'edit-meal';
      edit.dataset.editMeal = button.dataset.delMeal;
      edit.textContent = '수정';
      button.before(edit);
    });
  }

  function installMealComposer() {
    const oldForm = $('#saveMeal')?.closest('.form');
    if (!oldForm || $('#aiMealComposer')) return;
    oldForm.id = 'aiMealComposer';
    const hour = new Date().getHours();
    const defaultMeal = hour >= 4 && hour < 10 ? '아침' : hour >= 10 && hour < 15 ? '점심' : hour >= 15 && hour < 21 ? '저녁' : '간식';
    oldForm.innerHTML = `
      <div class="meal-type-tabs" role="radiogroup" aria-label="끼니 선택">
        ${['아침', '점심', '저녁', '간식'].map(type => `<label><input type="radio" name="aiMealType" value="${type}" ${type === defaultMeal ? 'checked' : ''}><span>${type}</span></label>`).join('')}
      </div>
      <label class="field"><span>먹은 내용을 편하게 적어주세요</span><textarea class="textarea meal-free-text" id="aiMealText" placeholder="예: 햇반 반 공기, 계란후라이 2개, 닭가슴살 150g\n양이나 제품명을 적으면 더 정확해요."></textarea></label>
      <div class="photo-analyzer">
        <label class="photo-picker" for="mealPhoto"><span>📷</span><strong>사진으로 분석</strong><small>음식 전체가 보이게 찍어주세요</small></label>
        <input class="hidden" id="mealPhoto" type="file" accept="image/*" capture="environment">
        <img id="mealPhotoPreview" alt="선택한 식사 사진 미리보기">
      </div>
      <button class="primary ai-save full" id="analyzeMeal"><span>✦</span> AI로 음식별 분석</button>
      <p class="notice ai-notice" id="aiMealNotice">설명과 사진을 함께 쓰면 양을 더 정확하게 계산해요.</p>`;
    oldForm.insertAdjacentHTML('afterend', '<section class="card analysis-preview" id="aiMealPreview"></section>');

    if ($('#focusMeal')) $('#focusMeal').onclick = () => $('#aiMealText')?.focus();

    $('#mealPhoto').onchange = async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        photoData = await imagePayload(file);
        $('#mealPhotoPreview').src = photoData.preview;
        $('#mealPhotoPreview').classList.add('show');
        $('.photo-picker').classList.add('has-photo');
      } catch {
        $('#aiMealNotice').textContent = '사진을 읽지 못했어요. 다른 사진을 선택해 주세요.';
      }
    };

    $('#analyzeMeal').onclick = async () => {
      const button = $('#analyzeMeal');
      const notice = $('#aiMealNotice');
      const text = $('#aiMealText').value.trim();
      const meal = $('[name="aiMealType"]:checked')?.value || '아침';
      notice.classList.remove('warn');
      if (!text && !photoData) {
        const input = $('#aiMealText');
        notice.textContent = '먹은 내용을 적거나 사진을 추가해 주세요.';
        notice.classList.add('warn');
        input.classList.add('invalid');
        input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake');
        input.focus();
        input.addEventListener('input', () => { input.classList.remove('invalid'); notice.classList.remove('warn'); }, { once: true });
        return;
      }
      const settings = parse(localStorage.getItem(AI_KEY), {}) || {};
      if (!aiReady(settings)) {
        notice.innerHTML = 'AI를 쓰려면 로그인이 필요해요. <button class="inline-link" data-go="more">더보기에서 로그인하기</button>';
        return;
      }
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> 사진과 설명을 함께 분석 중…';
      notice.textContent = '양과 조리법까지 반영해 계산하고 있어요.';
      try {
        const result = await analyzeWithAi(settings, nutritionPrompt(meal, text));
        editingMealId = null;
        pendingMealItems = normalizedMealItems(result);
        renderMealPreview();
        notice.textContent = `${pendingMealItems.length}개 음식으로 나눴어요. 양과 수치를 확인해 주세요.`;
        button.disabled = false;
        button.innerHTML = '<span>✦</span> 다시 분석';
        $('#aiMealPreview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) {
        notice.textContent = error.message || '분석하지 못했어요. 잠시 후 다시 시도해 주세요.';
        button.disabled = false;
        button.innerHTML = '<span>✦</span> AI로 음식별 분석';
      }
    };

    $('#aiMealPreview').addEventListener('click', event => {
      const card = event.target.closest('[data-analysis-index]');
      const portion = event.target.closest('[data-portion]');
      if (card && portion) {
        const item = pendingMealItems[+card.dataset.analysisIndex];
        item.servings = Math.min(5, Math.max(.25, Math.round((item.servings + +portion.dataset.portion) * 4) / 4));
        renderMealPreview();
        return;
      }
      if (event.target.closest('#saveAnalyzedMeals')) {
        const state = readState();
        const today = dateKey(new Date());
        const meal = $('[name="aiMealType"]:checked')?.value || '아침';
        state.logs ||= {};
        state.logs[today] ||= { meals: [], workouts: [] };
        state.logs[today].meals ||= [];
        if (editingMealId) {
          const index = state.logs[today].meals.findIndex(item => item.id === editingMealId);
          if (index >= 0) state.logs[today].meals[index] = mealRecord(pendingMealItems[0], meal, editingMealId);
        } else {
          pendingMealItems.forEach(item => state.logs[today].meals.push(mealRecord(item, meal)));
        }
        writeState(state);
        sessionStorage.setItem('fitlog:notice', editingMealId ? '식사 기록을 수정했어요.' : `${pendingMealItems.length}개 음식을 각각 저장했어요.`);
        location.reload();
      }
    });

    $('#aiMealPreview').addEventListener('input', event => {
      const card = event.target.closest('[data-analysis-index]');
      const field = event.target.dataset.mealField;
      if (!card || !field) return;
      const item = pendingMealItems[+card.dataset.analysisIndex];
      item[field] = ['name', 'referenceAmount'].includes(field) ? event.target.value : Math.max(0, +event.target.value || 0);
      const total = card.querySelector('.analysis-total');
      const value = actualNutrition(item);
      total.innerHTML = `현재 양 기준 <b>${value.kcal} kcal</b> · 단백질 ${value.protein}g · 탄수 ${value.carbs}g · 지방 ${value.fat}g`;
    });

    document.addEventListener('click', event => {
      const button = event.target.closest('[data-edit-meal]');
      if (!button) return;
      const state = readState();
      const today = dateKey(new Date());
      const meal = state.logs?.[today]?.meals?.find(item => item.id === button.dataset.editMeal);
      if (!meal) return;
      editingMealId = meal.id;
      const servings = Math.max(.25, +meal.servings || 1);
      pendingMealItems = normalizedMealItems({
        ...meal,
        servings,
        referenceAmount: meal.referenceAmount || meal.amount || '기록 기준 1인분',
        kcalPerServing: +meal.kcalPerServing || (+meal.kcal || 0) / servings,
        proteinPerServing: +meal.proteinPerServing || (+meal.protein || 0) / servings,
        carbsPerServing: +meal.carbsPerServing || (+meal.carbs || 0) / servings,
        fatPerServing: +meal.fatPerServing || (+meal.fat || 0) / servings
      });
      const radio = $(`[name="aiMealType"][value="${meal.meal}"]`);
      if (radio) radio.checked = true;
      renderMealPreview();
      $('#aiMealPreview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    enhanceMealList();
    const mealList = $('#mealList');
    if (mealList) new MutationObserver(enhanceMealList).observe(mealList, { childList: true, subtree: true });
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      :root{--red:#f25f5c;--soft-red:#ffe1d8;--violet:#8f7ee7}.welcome{background:linear-gradient(135deg,#fff0eb,#fff9dc 62%,#ddf7ed);padding-right:148px}.welcome img{width:145px;height:145px;right:-2px;bottom:-8px;transform-origin:55% 85%}.welcome.mascot-level-5{background:linear-gradient(135deg,#fff0d2,#ffe0d2 55%,#fff5b5)}.welcome.mascot-level-5 img{animation:mascotKick .62s ease-in-out infinite alternate}.welcome.mascot-level-4 img{animation:mascotRun .85s ease-in-out infinite alternate}.welcome.mascot-level-3 img{animation:mascotBreathe 2.4s ease-in-out infinite}.welcome.mascot-level-2 img{animation:mascotSlow 2.2s ease-in-out infinite}.welcome.mascot-level-1 img{animation:mascotDroop 3s ease-in-out infinite}.mascot-meter{margin-top:9px;padding:12px 14px;border:1px solid var(--line);border-radius:18px;background:#fff;box-shadow:0 7px 20px #2666500d}.mascot-meter-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.mascot-meter-head span{color:var(--sub);font-size:12px}.mascot-meter-head strong{font-size:13px}.mascot-levels{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin:8px 0}.mascot-levels i{height:6px;border-radius:9px;background:#e6eeeb}.mascot-levels i.on:nth-child(1){background:#aebac0}.mascot-levels i.on:nth-child(2){background:#9dc9bd}.mascot-levels i.on:nth-child(3){background:#72d1ae}.mascot-levels i.on:nth-child(4){background:#ffb45f}.mascot-levels i.on:nth-child(5){background:#f25f5c}.mascot-meter p{margin:0 0 10px;color:var(--sub);font-size:12px}.mascot-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.mascot-stats span{padding:7px 5px;border-radius:11px;background:#f5faf8;color:var(--sub);font-size:11px;text-align:center}.mascot-stats b{display:block;margin-bottom:2px;color:var(--ink);font-size:12px}@keyframes mascotKick{from{transform:translate(-3px,2px) rotate(-2deg) scale(.98)}to{transform:translate(4px,-5px) rotate(2deg) scale(1.03)}}@keyframes mascotRun{from{transform:translateX(-3px) rotate(-1deg)}to{transform:translate(4px,-3px) rotate(2deg)}}@keyframes mascotBreathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-2px) scale(1.015)}}@keyframes mascotSlow{0%,100%{transform:translateX(-1px) rotate(-1deg)}50%{transform:translateX(2px) rotate(1deg)}}@keyframes mascotDroop{0%,100%{transform:translateY(1px) rotate(0)}50%{transform:translateY(4px) rotate(-1deg)}}.bottom{border-top:1px solid #e5ece9;box-shadow:0 -8px 25px #17372c0b}.nav button{gap:3px}.nav button>span:last-child{font-size:11px}.nav-bubble{width:35px;height:35px;border-radius:13px;background:var(--bubble);display:grid;place-items:center;transition:.2s transform}.nav-bubble svg{width:20px;height:20px;fill:none;stroke:#29483e;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.nav button.active .nav-bubble{transform:translateY(-2px);box-shadow:0 5px 12px #17372c18}.nav .plus .nav-bubble{width:46px;height:46px;margin-top:-20px;border-radius:17px;background:#fff09c;box-shadow:0 8px 18px #c7a92435}.quick button{display:grid;place-items:center;gap:7px}.quick-icon{width:43px;height:43px;display:grid;place-items:center;border-radius:15px;font-size:21px}.quick-icon.peach{background:#ffe1d8}.quick-icon.mint{background:#d9f5e8}.quick-icon.lilac{background:#e5ddff}.quick button strong{font-size:12px}
      .calendar-card{padding:15px}.calendar-head{display:grid;grid-template-columns:38px 1fr 38px;align-items:center;text-align:center}.calendar-head button{width:34px;height:34px;border:0;border-radius:12px;background:#f2f7f5;font-size:24px}.calendar-weekdays,.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}.calendar-weekdays{margin:13px 0 6px;color:var(--sub);font-size:11px;text-align:center}.calendar-day{position:relative;min-width:0;height:55px;padding:4px 0;border:0;border-radius:13px;background:transparent;display:grid;place-items:center;align-content:start;gap:2px}.calendar-day>span{font-size:12px}.calendar-day.today>span{width:20px;height:20px;display:grid;place-items:center;border-radius:8px;background:#17372c;color:#fff}.calendar-day.selected{background:#f3f8f6;box-shadow:inset 0 0 0 2px #98d9c2}.activity-ring{position:relative;width:29px;height:29px;border-radius:50%;background:conic-gradient(var(--red) var(--move),#f2dddd 0);display:grid;place-items:center}.activity-ring:before{content:"";width:22px;height:22px;border-radius:50%;background:conic-gradient(#65cba5 var(--meal),#deeee8 0)}.activity-ring:after{content:"";position:absolute;width:15px;height:15px;border-radius:50%;background:conic-gradient(#ffb35f var(--kcal),#f3e7d7 0)}.activity-ring i{position:absolute;z-index:1;width:8px;height:8px;border-radius:50%;background:#fff}.empty-dot{width:4px;height:4px;margin-top:8px;border-radius:50%;background:#dce9e4}.ring-legend{display:flex;justify-content:center;gap:12px;margin:12px 0;color:var(--sub);font-size:11px}.ring-legend i{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:4px}.ring-legend .red{background:var(--red)}.ring-legend .green{background:#65cba5}.ring-legend .orange{background:#ffb35f}.day-summary{padding:14px;border-radius:17px;background:#f7fbf9}.summary-head{display:flex;justify-content:space-between;align-items:center}.summary-head span,.summary-head strong{display:block}.summary-head span{color:var(--sub);font-size:12px}.summary-head strong{font-size:19px;margin-top:2px}.summary-count{display:flex;gap:5px}.summary-count span{padding:6px 8px;border-radius:10px;background:#fff;color:var(--ink)}.day-block{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}.day-block h3{margin:0 0 6px;font-size:12px}.day-block div{display:grid;grid-template-columns:35px 1fr;gap:6px;margin:5px 0}.day-block b,.day-block span,.day-block p{font-size:12px}.day-block span,.day-block p{margin:0;color:var(--sub);line-height:1.5}.summary-empty strong,.summary-empty span{display:block}.summary-empty span{margin-top:3px;color:var(--sub);font-size:12px}
      .meal-type-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:13px}.meal-type-tabs input{position:absolute;opacity:0}.meal-type-tabs span{min-height:42px;border:1px solid var(--line);border-radius:13px;background:#f7fbf9;display:grid;place-items:center;font-size:12px;font-weight:850}.meal-type-tabs input:checked+span{background:#17372c;color:#fff;border-color:#17372c}.meal-free-text{min-height:112px;line-height:1.55}.photo-analyzer{position:relative;margin:10px 0;min-height:82px}.photo-picker{min-height:82px;padding:12px;border:1px dashed #9ecdbc;border-radius:17px;background:#f0faf6;display:grid;grid-template-columns:42px 1fr;align-items:center;column-gap:9px;cursor:pointer}.photo-picker>span{grid-row:1/3;width:42px;height:42px;border-radius:14px;background:#fff;display:grid;place-items:center;font-size:20px}.photo-picker strong,.photo-picker small{display:block}.photo-picker strong{font-size:12px}.photo-picker small{color:var(--sub);font-size:11px}.photo-picker.has-photo{padding-right:92px}.photo-analyzer img{display:none;position:absolute;right:7px;top:7px;width:68px;height:68px;object-fit:cover;border-radius:13px}.photo-analyzer img.show{display:block}.ai-save{background:linear-gradient(135deg,#f26b63,#ff9a6d);box-shadow:0 8px 18px #e2644930}.ai-save span{margin-right:5px}.ai-save:disabled{opacity:.7}.ai-notice{line-height:1.5}.inline-link{border:0;background:transparent;color:#2f8467;font-weight:900;text-decoration:underline}.spinner{display:inline-block;width:14px;height:14px;border:2px solid #ffffff66;border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
      .analysis-preview{display:none;margin-top:10px;padding:14px}.analysis-preview.show{display:block}.analysis-head{display:flex;justify-content:space-between;align-items:end;gap:8px;margin-bottom:10px}.analysis-head span,.analysis-head strong{display:block}.analysis-head span,.analysis-head small{color:var(--sub);font-size:11px}.analysis-head strong{margin-top:2px;font-size:15px}.analysis-item{padding:12px;margin-bottom:9px;border-radius:16px;background:#f5faf8;border:1px solid #dcebe5}.analysis-item>label{display:block;margin-bottom:8px}.analysis-item>label span,.nutrition-edit span,.portion-row span{display:block;margin-bottom:4px;color:var(--sub);font-size:11px}.analysis-item .input{padding:9px 10px;font-size:13px}.portion-row{display:flex;align-items:center;justify-content:space-between;margin:9px 0}.portion-row strong{font-size:17px}.portion-stepper{display:grid;grid-template-columns:42px 42px;gap:6px}.portion-stepper button{height:36px;border:0;border-radius:12px;background:#fff;font-size:20px;font-weight:900}.nutrition-edit{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}.nutrition-edit input{width:100%;min-width:0;padding:8px 4px;border:1px solid var(--line);border-radius:10px;background:#fff;text-align:center;font-size:12px}.analysis-total{margin:9px 0 0;color:var(--sub);font-size:12px}.analysis-total b{color:var(--ink)}.edit-meal{align-self:center;border:0;border-radius:11px;background:#e7f6f0;color:#28765d;padding:6px 9px;font-weight:800}.item:has(.edit-meal){grid-template-columns:1fr auto auto}
      .meal-recommendation{display:none;margin:10px 0;padding:14px;background:linear-gradient(145deg,#fff8df,#eefaf5)}.meal-recommendation.show{display:block}.recommend-loading{min-height:92px;display:grid;place-items:center;align-content:center;gap:6px;text-align:center}.recommend-loading strong,.recommend-loading span{display:block}.recommend-loading span{color:var(--sub);font-size:12px}.recommend-loading.bad strong{color:#a65341}.recommend-loading button{border:0;border-radius:11px;background:#17372c;color:#fff;padding:8px 12px;font-weight:800}.spinner.dark{border-color:#17372c33;border-top-color:#17372c}.recommend-head{display:flex;justify-content:space-between;align-items:end;gap:10px;margin-bottom:10px}.recommend-head span,.recommend-head strong{display:block}.recommend-head span{color:#6d827b;font-size:11px}.recommend-head strong{margin-top:2px;font-size:16px}.recommend-head small{max-width:48%;color:#6d827b;font-size:11px;text-align:right}.recommend-list article{display:grid;grid-template-columns:1fr auto;gap:6px;padding:11px;margin-top:7px;border-radius:15px;background:#fff}.recommend-list span,.recommend-list strong,.recommend-list small{display:block}.recommend-list span{color:#378d70;font-size:11px;font-weight:900}.recommend-list strong{margin:2px 0;font-size:13px}.recommend-list small,.recommend-list p{color:var(--sub);font-size:11px}.recommend-list p{grid-column:1/-1;margin:0;line-height:1.45}.recommend-list button{border:0;border-radius:11px;background:#e1f8ef;color:#25755a;padding:7px 10px;font-weight:900}
      .recommendation-profile>.section-head{margin-top:18px}.recommendation-profile .section-head small{display:block;margin-top:3px;color:var(--sub);font-size:11px}.profile-detail-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:0 8px}.profile-detail-grid .full-field{grid-column:1/-1}.textarea.compact{min-height:68px}
      .nutrition .cal-line strong{display:flex;align-items:baseline;gap:5px}.nutrition #kcal{font-size:34px;line-height:1;font-weight:950;letter-spacing:-1.5px}.nutrition .cal-line strong{font-size:20px}.nutrition .cal-line strong+span,.nutrition .cal-line>div>span{color:var(--sub);font-size:12px}.body-profile-card,.body-goal-card,.weekly-coach{padding:16px;margin-top:10px}.body-score,.goal-heading{display:flex;justify-content:space-between;align-items:end;margin-bottom:13px}.body-score span,.goal-heading span{display:block;color:#3a8b70;font-size:11px;font-weight:950;letter-spacing:.8px}.body-score strong,.goal-heading strong{display:block;margin-top:3px;font-size:18px}.body-score small{color:var(--sub);font-size:11px}.body-input-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:0 8px}.body-profile-card .primary,.body-goal-card .primary{margin-top:5px}.body-goal-card{background:linear-gradient(145deg,#f1fff9,#fff9df)}.goal-heading{display:block}.weekly-coach{margin:12px 0;background:linear-gradient(145deg,#eef9ff,#f2fff7 55%,#fff7dc)}.coach-title span,.coach-title strong,.coach-title small{display:block}.coach-title span{color:#477e9d;font-size:11px;font-weight:950;letter-spacing:.8px}.coach-title strong{margin:5px 0;font-size:18px}.coach-title small,.coach-note{color:var(--sub);font-size:11px;line-height:1.5}.weekly-coach>.primary{margin-top:13px}.coach-columns{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:13px}.coach-columns>div,.coach-plan{padding:11px;border-radius:14px;background:#fff}.coach-columns b,.coach-plan b{font-size:12px}.coach-columns p,.coach-plan p{margin:7px 0 0;color:var(--sub);font-size:12px;line-height:1.45}.coach-plan{margin-top:7px}.coach-plan p{display:grid;grid-template-columns:20px 1fr;gap:5px}.coach-plan p span{width:18px;height:18px;border-radius:7px;background:#dff4ec;color:#28765d;display:grid;place-items:center;font-weight:900}.coach-note{display:block;margin-top:9px}
      .kcal-value{font-size:19px;line-height:1;font-weight:950;letter-spacing:-.4px;color:var(--ink)}.meal-row em{display:flex;align-items:baseline;gap:3px;white-space:nowrap;font-size:12px}.meal-row .meal-emoji{width:56px;height:56px;border-radius:17px;background:linear-gradient(145deg,#fff3df,#e9f8f1);display:grid;place-items:center;font-size:31px;box-shadow:inset 0 0 0 1px #e2ede8}.meal-group-row>span:nth-child(2)>span{font-size:12px;line-height:1.45;color:#526a61}.meal-group-row small{display:block;margin-top:4px;color:var(--sub);font-size:11px}.meal-group{padding:5px 0;border-bottom:1px solid var(--line)}.meal-group:last-child{border-bottom:0}.meal-group>header{display:grid;grid-template-columns:42px 1fr auto;gap:9px;align-items:center;padding:9px 0}.meal-emoji.small{width:42px;height:42px;border-radius:14px;background:#f1faf6;display:grid;place-items:center;font-size:23px}.meal-group header strong,.meal-group header span{display:block}.meal-group header span{color:var(--sub);font-size:11px}.meal-group header em{display:flex;align-items:baseline;gap:3px;font-style:normal;font-size:12px}.meal-group-items{margin-left:51px}.meal-group-items article{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:6px;align-items:center;padding:9px 0;border-top:1px dashed #e4efeb}.meal-group-items article strong,.meal-group-items article span{display:block}.meal-group-items article strong{font-size:12px}.meal-group-items article span{margin-top:3px;color:var(--sub);font-size:11px;line-height:1.4}.item-kcal{font-size:16px;white-space:nowrap}.meal-group-items .edit-meal,.meal-group-items .delete{padding:6px 7px;font-size:12px}.analysis-total b,.recommend-list small{font-size:15px;color:var(--ink);font-weight:900}.photo strong #mealKcal{font-size:36px;letter-spacing:-1.5px}.photo strong{display:flex;align-items:baseline;gap:5px}#mealRemain,#kcalMsg{font-size:13px;font-weight:800}.kcal-input-wrap{position:relative}.kcal-input-wrap input{padding-right:55px}.kcal-input-wrap b{position:absolute;right:13px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--sub)}.cardio-kcal-field small{font-size:11px;color:#8a9a94}
      .settings-fold{margin:10px 0;overflow:hidden}.settings-fold>summary{list-style:none;min-height:72px;padding:12px 15px;display:grid;grid-template-columns:44px 1fr auto;align-items:center;gap:10px;cursor:pointer}.settings-fold>summary::-webkit-details-marker{display:none}.settings-fold>summary .fold-icon{width:44px;height:44px;border-radius:15px;background:#f0faf6;display:grid;place-items:center;font-size:21px}.settings-fold>summary strong,.settings-fold>summary small{display:block}.settings-fold>summary strong{font-size:14px}.settings-fold>summary small{margin-top:3px;color:var(--sub);font-size:11px;line-height:1.4}.settings-fold>summary>b{font-size:21px;transition:.2s transform}.settings-fold[open]>summary>b{transform:rotate(90deg)}.fold-content{padding:3px 15px 16px;border-top:1px solid var(--line)}.body-profile-card{padding:13px 0 0;margin:0;box-shadow:none;border:0}.profile-step{display:grid;grid-template-columns:28px 1fr;gap:8px;align-items:center;margin:15px 0 10px}.profile-step>span{width:27px;height:27px;border-radius:10px;background:#17372c;color:#fff;display:grid;place-items:center;font-weight:900;font-size:12px}.profile-step strong,.profile-step small{display:block}.profile-step strong{font-size:13px}.profile-step small{color:var(--sub);font-size:11px;margin-top:2px}.goal-text{min-height:105px;line-height:1.5}.ai-target-summary{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin:12px 0;padding:11px;border-radius:16px;background:#f4faf7}.ai-target-summary span{padding:7px 8px;border-radius:11px;background:#fff;color:var(--sub);font-size:11px}.ai-target-summary span:last-child{grid-column:1/-1}.ai-target-summary b{display:block;margin-bottom:2px;color:var(--ink);font-size:14px}.event-advice{margin-top:11px;border-top:1px solid #dcebe5}.event-advice>summary{list-style:none;padding:12px 2px 2px;color:#3a8069;font-size:12px;font-weight:900;cursor:pointer}.event-advice>summary::-webkit-details-marker{display:none}.event-advice>summary b{float:right}.event-advice>div{padding-top:8px}.event-advice .primary{font-size:12px}.chart-card#cardioReportCard{background:linear-gradient(145deg,#effbf6,#fff)}
      .mascot-levels.warmup{grid-template-columns:repeat(3,1fr)}.mascot-levels.warmup i.on{background:#72d1ae}
      .ghost{min-height:44px;border:1px solid #17372c33;border-radius:14px;background:#ffffffb3;padding:0 14px;font-weight:800;color:var(--ink)}.ghost.full{width:100%;margin-top:12px}
      .badge{display:inline-flex;align-items:center;padding:3px 7px;border-radius:99px;background:#eef3f1;color:#5d736b;font-size:11px;font-style:normal;font-weight:800;white-space:nowrap}.badge.up{background:#dcf5eb;color:#23775a}.badge.down{background:#ffece6;color:#b05243}.badge.pr{background:#fff1c7;color:#8a6200}.badges{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
      .input-hint{margin:6px 2px 0;color:var(--sub);font-size:12px;line-height:1.5}.input-hint b{color:var(--ink)}
      .day-workout-actions{display:flex;justify-content:flex-end;gap:4px;margin-top:4px}.day-workout-actions .link{padding:4px 6px;font-size:12px}.edit-banner{display:flex;justify-content:space-between;align-items:center;margin:-2px 0 10px;padding:8px 10px;border-radius:12px;background:#fff4dc;font-size:13px;font-weight:800}.edit-banner .link{padding:2px 4px;font-size:12px}
      .parsed{margin:0 0 12px;padding:12px;border-radius:15px;background:#f3f9f6;color:var(--sub);font-size:12px}.parsed-head{display:flex;justify-content:space-between;align-items:center;gap:8px}.parsed-head b{color:#c2573c;font-size:14px}.parsed ul{margin:8px 0 0;padding:0;list-style:none}.parsed li{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 0;border-top:1px dashed #dcebe5}.parsed li strong,.parsed li span{display:block}.parsed li strong{color:var(--ink);font-size:13px}.parsed li span{margin-top:2px;font-size:12px}.parsed-foot{margin-top:6px;padding-top:8px;border-top:1px solid #dcebe5;font-size:12px}.parsed-foot b{color:#2f8467}
      .routine-bar{margin-bottom:12px}.routine-bar>span{display:block;margin-bottom:6px;color:var(--sub);font-size:12px;font-weight:800}.routine-bar>span small{font-weight:600;color:#2f8467}.routine-chips{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.routine-chips button{min-height:54px;border:1px solid var(--line);border-radius:14px;background:#f3f9f6;display:grid;place-items:center;align-content:center;gap:2px;padding:4px 2px}.routine-chips b{font-size:14px}.routine-chips small{color:var(--sub);font-size:10px;line-height:1.2}.routine-chips button:active{background:#dcf5eb;border-color:#72d1ae}.exercise-chips{margin-top:8px}.exercise-chips>span{display:block;margin-bottom:5px;color:var(--sub);font-size:11px}.exercise-chips>div{display:flex;flex-wrap:wrap;gap:5px}.exercise-chips button{padding:6px 10px;border:1px solid var(--line);border-radius:99px;background:#fff;font-size:12px;font-weight:700}.routine-tag{margin-right:4px;padding:2px 7px;border-radius:99px;background:#17372c;color:#fff;font-size:11px}#workoutNote.shake{animation:shake .35s;border-color:#f0a494}
      .workout-meta{display:grid;grid-template-columns:112px 1fr;gap:10px}.workout-meta .field>span small{color:#2f8467;font-weight:800}.rpe-chips{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}.rpe-chips button{height:44px;border:1px solid var(--line);border-radius:12px;background:#f9fcfb;font-weight:900}.rpe-chips button.on{background:#17372c;border-color:#17372c;color:#fff}
      .plan-card{margin-bottom:12px;padding:15px}.plan-card:empty{display:none}.plan-eyebrow{display:block;color:#477e9d;font-size:11px;font-weight:950;letter-spacing:.3px}.plan-empty{display:grid;gap:6px}.plan-empty strong{font-size:17px}.plan-empty small{color:var(--sub);font-size:12px;line-height:1.55}.plan-empty .primary{margin-top:6px}.plan-loading{min-height:120px;display:grid;place-items:center;align-content:center;gap:6px;text-align:center}.plan-loading small{color:var(--sub);font-size:12px}
      .soccer-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;padding:8px 10px;border-radius:12px;background:#f3f9f6}.soccer-row span{font-size:13px;font-weight:800}.soccer-row span small{margin-left:4px;color:var(--sub);font-size:11px;font-weight:600}.soccer-row div{display:flex;gap:4px}.soccer-row button{min-width:52px;height:32px;border:1px solid var(--line);border-radius:10px;background:#fff;font-size:12px;font-weight:800}.soccer-row button.on{background:#17372c;border-color:#17372c;color:#fff}.plan-rule{margin:6px 2px 0;color:var(--sub);font-size:12px}.plan-rule b{color:#c2573c}.plan-rule-note{margin:8px 0 0;padding:8px 10px;border-radius:12px;background:#fff4f0;color:#8d5a4d;font-size:12px;line-height:1.5}
      .plan-head{display:flex;justify-content:space-between;align-items:start;gap:8px}.plan-head strong{display:block;margin-top:3px;font-size:18px}.plan-principle{margin:10px 0 0;padding:10px 12px;border-radius:13px;background:#eef7ff;color:#335f79;font-size:12px;line-height:1.55}.plan-alert{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding:10px 12px;border-radius:13px;background:#fff1ec;color:#a4492f;font-size:12px;font-weight:800}.plan-alert button{flex:none;border:0;border-radius:10px;background:#c2573c;color:#fff;padding:8px 10px;font-size:12px;font-weight:900}
      .plan-strip{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin:12px 0}.plan-day{min-width:0;padding:7px 0 6px;border:1px solid transparent;border-radius:13px;background:#f3f8f6;display:grid;justify-items:center;gap:3px}.plan-day span{color:var(--sub);font-size:11px}.plan-day b{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#fff;font-size:12px}.plan-day small{max-width:100%;overflow:hidden;color:var(--sub);font-size:10px;white-space:nowrap}.plan-day.done b{background:var(--mint);color:#fff}.plan-day.missed b{background:#ffd9cf;color:#b05243}.plan-day.rest{background:#fafcfb}.plan-day.rest b{background:transparent;color:#a3b3ad}.plan-day.is-today span{color:var(--ink);font-weight:900}.plan-day.selected{border-color:#17372c;background:#fff}.plan-day:disabled{opacity:.4}
      .plan-detail{padding:12px;border-radius:15px;background:#f7fbf9}.plan-detail.rest p{margin:6px 0 0;color:var(--sub);font-size:13px;line-height:1.55}.plan-detail-head{display:flex;justify-content:space-between;align-items:center;gap:8px}.plan-detail-head strong{font-size:14px}.plan-exercises{margin:8px 0 0;padding:0;list-style:none;counter-reset:ex}.plan-exercises li{display:flex;justify-content:space-between;align-items:start;gap:10px;padding:8px 0;border-top:1px dashed #dcebe5}.plan-exercises li strong{display:block;font-size:13px}.plan-exercises li small{display:block;margin-top:2px;color:#2f8467;font-size:11px;line-height:1.45}.plan-exercises li b{flex:none;font-size:13px}.plan-note{margin:8px 0 0;color:var(--sub);font-size:12px;line-height:1.5}.plan-detail .primary{margin-top:10px}
      .hero-list{margin:6px 0 12px;padding:0;list-style:none}.hero-list li{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #17372c12;font-size:13px}.hero-list li b{white-space:nowrap}.hero-list li.more{color:var(--sub);border:0}
      .checkin{margin-top:9px;padding:12px 14px}.checkin-head{display:flex;align-items:baseline;gap:7px;margin-bottom:9px}.checkin-head strong{font-size:14px}.checkin-head small{color:var(--sub);font-size:11px}.checkin-saved{margin-left:auto;color:#2f8467;font-size:11px;font-weight:800}.checkin-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.checkin-grid label>span{display:block;margin-bottom:4px;color:var(--sub);font-size:11px}.unit-input{position:relative}.unit-input input{width:100%;height:40px;border:1px solid var(--line);border-radius:12px;background:#f9fcfb;padding:0 42px 0 11px;font-size:16px}.unit-input b{position:absolute;right:11px;top:50%;transform:translateY(-50%);color:var(--sub);font-size:12px}.condition-chips{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin-top:9px}.condition-chips button{height:48px;border:1px solid var(--line);border-radius:12px;background:#f9fcfb;display:grid;place-items:center;align-content:center;gap:1px}.condition-chips span{font-size:18px;line-height:1}.condition-chips small{color:var(--sub);font-size:10px}.condition-chips button.on{border-color:#72d1ae;background:#dcf5eb}.checkin.done{display:flex;align-items:center;gap:8px}.checkin.done .checkin-title{color:var(--sub);font-size:12px;white-space:nowrap}.checkin.done b{flex:1;font-size:13px}.checkin.done .link{padding:4px}.checkin-save{margin-top:10px}
      .chart .axis{fill:#8a9c95;font-size:10px}.chart .bar-value{fill:#33514a;font-size:10px;font-weight:800}
      .ib-section{margin-top:12px}.ib-section+.ib-section{padding-top:12px;border-top:1px solid var(--line)}.ib-title{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px}.ib-title strong{font-size:14px}.ib-title span{color:var(--sub);font-size:11px;text-align:right}.ib-row{display:grid;grid-template-columns:62px 1fr 74px;align-items:center;gap:8px;padding:7px 0}.ib-label{font-size:13px;font-weight:800}.ib-label small{margin-left:2px;color:var(--sub);font-size:10px;font-weight:600}.ib-track{position:relative;height:14px;border-radius:4px;background:repeating-linear-gradient(90deg,#eef4f1 0 calc(10% - 1px),#fff calc(10% - 1px) 10%)}.ib-band{position:absolute;top:-3px;bottom:-3px;border-radius:4px;background:#72d1ae33;border:1px dashed #72d1ae}.ib-fill{position:absolute;left:0;top:3px;bottom:3px;border-radius:0 4px 4px 0}.ib-value{font-size:15px;text-align:right}.ib-value small{display:block;font-size:10px;font-weight:800}.ib-value small.ok{color:#2f8467}.ib-value small.warn{color:#c2573c}.ib-legend{margin:4px 0 0;color:var(--sub);font-size:11px}.ib-legend i{display:inline-block;width:14px;height:8px;margin-right:5px;border:1px dashed #72d1ae;background:#72d1ae33;border-radius:2px}
      .ib-history{overflow-x:auto;margin:0 -4px;padding:0 4px}.ib-history table{border-collapse:collapse;min-width:100%;font-size:12px}.ib-history th,.ib-history td{padding:6px 5px;text-align:right;white-space:nowrap}.ib-history thead th{color:var(--sub);font-weight:700}.ib-history tbody th{position:sticky;left:0;background:#fff;text-align:left;color:var(--sub);font-weight:800}.ib-history td b{display:block;font-size:13px}.ib-history td i{display:block;height:4px;margin:4px 0 0 auto;border-radius:3px;background:#b9d8cc}.ib-history .latest{background:#f1faf6}.ib-history td.latest b{color:#17372c}.ib-history td.latest i{background:#72d1ae}.ib-changes{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px;font-size:12px}.ib-changes em{color:var(--sub);font-style:normal}.ib-changes span{padding:4px 8px;border-radius:99px;background:#f1f5f3;font-weight:800}.ib-changes .good{background:#dcf5eb;color:#23775a}.ib-changes .bad{background:#ffece6;color:#b05243}.ib-target{margin:12px 0 0;padding:10px 12px;border-radius:13px;background:#fff8e1;font-size:13px;font-weight:800}
      .ib-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px;border-radius:14px;background:#f1f6f4}.ib-tabs button{min-height:36px;border:0;border-radius:11px;background:transparent;color:var(--sub);font-size:12px;font-weight:800}.ib-tabs button.on{background:#fff;color:var(--metric);box-shadow:0 2px 8px #17372c14}.ib-trend-chart{margin-top:8px}.ib-trend-chart .trend-value{fill:#48625a;font-size:10px;font-weight:700}.ib-trend-chart .trend-value.last{fill:#17372c;font-size:12px;font-weight:900}.ib-trend-chart .trend-date{fill:#8a9c95;font-size:10px}.ib-trend-chart .trend-date.last{fill:#17372c;font-weight:800}.ib-trend-empty{margin:14px 0;color:var(--sub);font-size:12px;text-align:center}
      .ib-summary{display:grid;grid-template-columns:.8fr 1fr 1fr;gap:6px;margin-top:6px}.ib-summary>div{padding:9px 10px;border-radius:12px;background:#f5faf8}.ib-summary span{display:block;color:var(--sub);font-size:11px}.ib-summary em{font-style:normal;opacity:.8}.ib-summary strong{display:block;margin-top:3px;font-size:18px;line-height:1.1}.ib-summary strong small{margin-left:2px;color:var(--sub);font-size:11px}.ib-summary b{display:block;margin-top:4px;font-size:14px}.ib-summary b.good{color:#23775a}.ib-summary b.bad{color:#c2573c}.ib-summary b.flat{color:#5d736b}
      .part-bars{display:grid;gap:9px;margin-top:10px}.part-row{display:grid;grid-template-columns:36px 1fr 52px;align-items:center;gap:8px;font-size:13px}.part-row span{font-weight:800}.part-row b{text-align:right;font-size:13px}.part-track{position:relative;height:12px;border-radius:99px;background:#eef4f1;overflow:hidden}.part-track .band{position:absolute;top:0;bottom:0;background:#72d1ae2e}.part-track .fill{position:absolute;left:0;top:0;bottom:0;border-radius:99px}.part-track .fill.ok{background:#72d1ae}.part-track .fill.under{background:#9fb7c9}.part-track .fill.over{background:#ffb35f}.band-dot{background:#72d1ae2e!important;border:1px solid #72d1ae;border-radius:2px!important}#partSetsCard .legend{margin-top:10px}
      .report-top{display:flex;justify-content:space-between;align-items:start;gap:10px}.score-ring{--p:0;flex:none;width:64px;height:64px;border-radius:50%;background:conic-gradient(#72d1ae calc(var(--p)*1%),#e3eeea 0);display:grid;place-items:center;align-content:center;position:relative}.score-ring:before{content:"";position:absolute;inset:6px;border-radius:50%;background:#fff}.score-ring b,.score-ring small{position:relative}.score-ring b{font-size:20px;line-height:1}.score-ring small{color:var(--sub);font-size:10px}.report-summary{margin:10px 0 0;font-size:13px;line-height:1.6}
      .metric-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:12px}.metric{padding:10px;border-radius:13px;background:#fff;border:1px solid #e3eeea}.metric span,.metric small{display:block;color:var(--sub);font-size:11px}.metric b{display:block;margin:3px 0 2px;font-size:16px}.metric.good{border-color:#bfe8d7}.metric.good small{color:#23775a}.metric.warn{border-color:#ffd6c8}.metric.warn small{color:#b05243}
      .report-section{margin-top:10px;padding:11px 12px;border-radius:14px;background:#fff}.report-section h4{display:flex;align-items:center;gap:6px;margin:0 0 5px;font-size:13px}.report-section p{margin:0;color:#48625a;font-size:12px;line-height:1.6}.status{padding:2px 7px;border-radius:99px;font-size:11px;font-style:normal}.status.up{background:#dcf5eb;color:#23775a}.status.keep{background:#e8f1ff;color:#3a6a95}.status.warn{background:#fff1d6;color:#8a6200}.status.rest{background:#f1ecff;color:#5f4bb6}.coach-actions{display:flex;justify-content:space-between;gap:8px;margin-top:4px}
      .advice-result{margin-top:12px;padding:12px;border-radius:14px;background:#fff}.advice-result strong{font-size:15px}.advice-result>p{margin:5px 0 0;color:#48625a;font-size:12px;line-height:1.6}.advice-result ol{margin:10px 0 0;padding-left:18px}.advice-result li{margin:8px 0;font-size:12px;line-height:1.55}.advice-result li b,.advice-result li span{display:block}.advice-result li span{color:var(--sub)}.advice-cautions{margin-top:8px;padding:9px 11px;border-radius:12px;background:#fff4f0}.advice-cautions b{font-size:12px;color:#a4492f}.advice-cautions p{margin:4px 0 0;color:#8d5a4d;font-size:12px}.advice-result small{display:block;margin-top:8px;color:var(--sub);font-size:11px}
      .day-block .day-workout{display:block;margin:8px 0;padding:10px;border-radius:12px;background:#fff}.day-workout>b{font-size:12px}.day-workout>small{display:block;margin-top:2px;color:var(--sub);font-size:11px}.day-workout ul{margin:6px 0 0;padding:0;list-style:none}.day-workout li{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:5px 0;border-top:1px dashed #e4efeb}.day-block .day-workout li span{color:var(--ink);font-size:12px}.day-workout li em{color:var(--sub);font-style:normal}.day-block .day-comment{margin-top:6px;color:#48625a}
      @media(max-width:360px){.welcome{padding-right:118px}.welcome img{width:120px;height:120px}.calendar-grid,.calendar-weekdays{gap:2px}.calendar-day{height:52px}.activity-ring{width:26px;height:26px}.activity-ring:before{width:20px;height:20px}.activity-ring:after{width:14px;height:14px}.mascot-stats span{font-size:10px}}
    `;
    document.head.appendChild(style);
  }

  // 급식표 모듈(lunch.js)처럼 따로 불러오는 기능이 앱의 저장·알림을 쓸 수 있게 열어둔다.
  window.FitLogCore = { readState, writeState, showToast, dateKey, esc, goTo };
  window.FitLogAI = {
    enabled: () => aiReady(parse(localStorage.getItem(AI_KEY), {}) || {}),
    context: state => profileContextText(state),
    analyze: prompt => analyzeWithAi(parse(localStorage.getItem(AI_KEY), {}) || {}, prompt, 'analyze', false)
  };

  if (migrateMonthlyLog()) {
    location.reload();
    return;
  }
  removeLegacyDemoMeals();
  injectStyles();
  updateMascot();
  updatePlanHero();
  refreshIcons();
  installCalendar();
  installWorkoutForm();
  installPlanActions();
  installCheckin();
  renderPlanCard();
  installMealComposer();
  installMealRecommendation();
  installUserContext();
  installBodyGoals();
  installWeeklyCoach();
  renderRealReportCharts();
  renderGroupedMeals();
  removeDuplicateArchive();
  [$('#mealPreview'), $('#mealList')].filter(Boolean).forEach(target => new MutationObserver(() => renderGroupedMeals()).observe(target, { childList: true }));
  window.addEventListener('hashchange', () => {
    if (location.hash === '#workout') { renderCalendar(); renderPlanCard(); renderWorkoutDraft(); renderExerciseChips(); }
    if (location.hash === '#report') renderRealReportCharts();
    if (location.hash === '#home') { updatePlanHero(); renderCheckin(); }
    removeDuplicateArchive();
  });
  window.addEventListener('fitlog:state-updated', () => {
    updateMascot();
    updatePlanHero();
    renderPlanCard();
    if (!$('#checkin')?.contains(document.activeElement)) renderCheckin();
    renderCalendar();
    renderRealReportCharts();
    renderGroupedMeals();
  });
})();
