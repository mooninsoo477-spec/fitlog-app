(() => {
  'use strict';

  const STATE_KEY = 'fitlog:dashboard:v3';
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
  const pad = value => String(value).padStart(2, '0');
  const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedDate = dateKey(new Date());

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
    mascot.onerror = () => { mascot.onerror = null; mascot.src = 'mascot/default.png'; };
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
    // 오늘은 아직 끼니가 남았을 수 있어 평균에서 뺀다. 오늘만 기록이 있으면 오늘 값을 쓴다.
    const allMealLogs = logs.filter(log => (log.meals || []).length);
    const pastMealLogs = dates.filter(date => date < dateKey(new Date())).map(date => state.logs?.[date] || {}).filter(log => (log.meals || []).length);
    const mealLogs = pastMealLogs.length ? pastMealLogs : allMealLogs;
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
      parts: partSets(state, endKey, days)
    };
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
        return `<section class="meal-group"><header><span class="meal-emoji small" aria-hidden="true">${mealEmoji(group.items, group.meal)}</span><div><strong>${esc(group.meal)}</strong><span>${group.items.length}가지 음식</span></div><em><b class="kcal-value">${Math.round(kcal).toLocaleString()}</b> kcal</em></header><div class="meal-group-items">${group.items.map(item => `<article><div><strong>${esc(item.name)}</strong><span>${esc(item.amount || item.referenceAmount || '')} · 단백질 ${Math.round(+item.protein || 0)}g · 탄수 ${Math.round(+item.carbs || 0)}g · 지방 ${Math.round(+item.fat || 0)}g</span></div><b class="item-kcal">${Math.round(+item.kcal || 0)} kcal</b><button type="button" class="delete" data-del-meal="${esc(item.id)}">삭제</button></article>`).join('')}</div></section>`;
      }).join('') : '<div class="item"><div><strong>오늘의 식사를 추가해 주세요</strong><span>음식 이름과 칼로리만 적어도 저장돼요.</span></div></div>';
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
        ${workout.comment ? `<p class="day-comment">💬 ${esc(workout.comment)}</p>` : ''}</div>`;
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
    if (children[0]?.textContent.includes('기록 보관함')) children[0].remove();
    if (children[1]?.classList.contains('sync-card')) children[1].remove();
    panel.dataset.calendarMoved = 'true';
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

  function clamp(value, min, max, fallback) {
    const number = +value;
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  }

  function targetSummary(state) {
    const targets = state.profile?.targets || { kcal: 2200, protein: 153, carbs: 260, fat: 61 };
    return `<div class="ai-target-summary"><span><b>${(+targets.kcal || 0).toLocaleString()}</b> kcal</span><span><b>${+targets.protein || 0}g</b> 단백질</span><span><b>${+targets.carbs || 0}g</b> 탄수</span><span><b>${+targets.fat || 0}g</b> 지방</span><span><b>주 ${state.profile?.workoutGoal || 4}회</b> 운동 목표</span></div>`;
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
    const lacking = partValues.filter(([, value]) => value < 10).map(([part]) => part);
    const weightDiff = metrics.weightStart != null && metrics.weightEnd != null ? Math.round((metrics.weightEnd - metrics.weightStart) * 10) / 10 : null;
    return `<div class="metric-grid">
      ${tile('운동 수행', `${metrics.workoutDays}/${metrics.goal}회`, metrics.planned ? `계획 ${metrics.plannedDone}/${metrics.planned}회 수행` : '주간 목표 대비', doneRatio >= .8 ? 'good' : 'warn')}
      ${tile('총 볼륨', metrics.volume ? `${Math.round(metrics.volume).toLocaleString()}kg` : '–', metrics.volumeChange != null ? `지난주 대비 ${metrics.volumeChange > 0 ? '+' : ''}${metrics.volumeChange}%` : '비교할 기록 없음', metrics.volumeChange == null ? '' : metrics.volumeChange >= 0 ? 'good' : 'warn')}
      ${tile('운동 소모', metrics.burnKcal ? `${metrics.burnKcal.toLocaleString()}kcal` : '–', metrics.rpe ? `평균 RPE ${metrics.rpe.toFixed(1)}` : '강도 기록 없음')}
      ${tile('부위 균형', `${balanced}/6 적정`, lacking.length ? `부족: ${lacking.slice(0, 3).join('·')}` : '모든 부위 적정', balanced >= 4 ? 'good' : 'warn')}
      ${tile('평균 섭취', metrics.kcal != null ? `${Math.round(metrics.kcal).toLocaleString()}kcal` : '–', kcalPct != null ? `목표의 ${kcalPct}% · ${metrics.mealDays}일 기록` : '식단 기록 없음', kcalPct == null ? '' : kcalPct >= 90 && kcalPct <= 105 ? 'good' : 'warn')}
      ${tile('단백질', metrics.protein != null ? `${Math.round(metrics.protein)}g` : '–', proteinPct != null ? `목표의 ${proteinPct}%` : '식단 기록 없음', proteinPct == null ? '' : proteinPct >= 90 ? 'good' : 'warn')}
      ${tile('수면·컨디션', metrics.sleep != null ? `${metrics.sleep.toFixed(1)}시간` : '–', metrics.condition != null ? `컨디션 ${metrics.condition.toFixed(1)}/5` : '체크인 기록 없음', metrics.sleep == null ? '' : metrics.sleep >= 7 ? 'good' : 'warn')}
      ${tile('공복 체중', metrics.weightEnd != null ? `${metrics.weightEnd}kg` : '–', weightDiff ? `주간 ${weightDiff > 0 ? '+' : ''}${weightDiff}kg` : '체크인에 체중을 적어주세요')}
    </div>`;
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
  const goTo = view => $(`.nav [data-go="${view}"]`)?.click();
  const selectedGroups = () => [...document.querySelectorAll('[name="wt"]:checked')].map(input => input.value);

  function workoutDraft() {
    const state = readState();
    const groups = selectedGroups();
    const exercises = parseWorkoutText($('#workoutNote')?.value, groups.join('·'));
    const cardio = groups.some(group => /유산소/.test(group));
    const estimate = estimateWorkout(exercises, {
      minutes: +$('#workoutMinutes')?.value || 0, rpe: selectedRpe, groups,
      manualCardioKcal: cardio ? +$('#workoutKcal')?.value || 0 : 0, bodyWeight: latestBodyWeight(state)
    });
    return { state, groups, exercises, estimate, cardio };
  }

  function renderWorkoutDraft() {
    const target = $('#workoutParsed');
    if (!target) return;
    const { state, exercises, estimate } = workoutDraft();
    if (!exercises.length) { target.innerHTML = ''; return; }
    const history = exerciseHistory(state, dateKey(new Date()));
    const volume = exercises.reduce((sum, exercise) => sum + exercise.volume, 0);
    target.innerHTML = `<div class="parsed-head"><span>인식된 운동 ${exercises.length}개</span><b>약 ${estimate.kcal.toLocaleString()} kcal 소모</b></div>
      <ul>${exercises.map(exercise => {
        const previous = exercise.cardio ? null : (history.get(exerciseKey(exercise.name)) || []).at(-1);
        return `<li><div><strong>${esc(exercise.name)}</strong><span>${esc(setSummary(exercise))}</span>${previous ? `<small class="prev-hint">지난번 ${shortDate(previous.date)} · ${esc(setSummary(previous))} → ${esc(nextTarget(previous))}</small>` : ''}</div><div class="badges">${progressBadges(exerciseProgress(exercise, history))}</div></li>`;
      }).join('')}</ul>
      <div class="parsed-foot">${volume ? `총 볼륨 <b>${volume.toLocaleString()}kg</b> · ` : ''}${estimate.strengthSets ? `${estimate.strengthSets}세트 · ` : ''}${estimate.minutes ? `${estimate.estimatedTime ? '약 ' : ''}${estimate.minutes}분 · ` : ''}체중 ${estimate.bodyWeight}kg 기준</div>`;
  }

  function syncCardioField() {
    $('#cardioField')?.classList.toggle('hidden', !selectedGroups().some(group => /유산소/.test(group)));
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
    const choices = $('.choices');
    choices.classList.remove('shake'); void choices.offsetWidth; choices.classList.add('shake');
  }

  function resetWorkoutForm() {
    document.querySelectorAll('[name="wt"]').forEach(input => { input.checked = false; });
    ['#workoutNote', '#workoutKcal', '#workoutMinutes', '#workoutComment'].forEach(selector => { if ($(selector)) $(selector).value = ''; });
    setRpe(null);
    syncCardioField();
    renderWorkoutDraft();
  }

  function saveWorkoutRecord() {
    const notice = $('#workoutNotice');
    const { state, groups, exercises, estimate, cardio } = workoutDraft();
    if (!groups.length) return workoutWarn('운동 종류를 하나 이상 선택해 주세요.');
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
    state.logs ||= {};
    state.logs[today] ||= { meals: [], workouts: [] };
    state.logs[today].workouts ||= [];
    state.logs[today].workouts.push(record);
    writeState(state);
    window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
    resetWorkoutForm();
    notice.classList.remove('warn');
    notice.textContent = ['저장했어요', totalVolume ? `볼륨 ${totalVolume.toLocaleString()}kg` : '', estimate.kcal ? `약 ${estimate.kcal.toLocaleString()}kcal 소모` : '', prs ? `🏆 PR ${prs}개` : ''].filter(Boolean).join(' · ');
    setTimeout(() => { notice.textContent = ''; goTo('home'); }, 1400);
  }

  function installWorkoutForm() {
    const note = $('#workoutNote');
    if (!note || note.dataset.enhanced) return;
    note.dataset.enhanced = 'true';
    note.addEventListener('input', renderWorkoutDraft);
    ['#workoutMinutes', '#workoutKcal'].forEach(selector => $(selector)?.addEventListener('input', renderWorkoutDraft));
    document.querySelectorAll('[name="wt"]').forEach(input => input.addEventListener('change', () => {
      syncCardioField();
      renderWorkoutDraft();
      $('#workoutNotice').classList.remove('warn');
      $('#workoutNotice').textContent = '';
    }));
    document.querySelectorAll('[data-rpe]').forEach(button => button.addEventListener('click', () => {
      setRpe(selectedRpe === +button.dataset.rpe ? null : +button.dataset.rpe);
      renderWorkoutDraft();
    }));
    $('#loadLastWorkout').onclick = () => {
      const state = readState();
      const last = Object.keys(state.logs || {}).filter(validDate).sort().reverse().map(date => (state.logs[date].workouts || []).at(-1)).find(Boolean);
      if (!last) return showToast('불러올 운동 기록이 아직 없어요.');
      const groups = String(last.group || last.type || '').split('·');
      document.querySelectorAll('[name="wt"]').forEach(input => { input.checked = groups.includes(input.value); });
      note.value = last.note || last.name || '';
      syncCardioField();
      renderWorkoutDraft();
      showToast('최근 기록을 불러왔어요. 무게·횟수만 바꿔 저장하세요.');
    };
    $('#saveWorkout').onclick = saveWorkoutRecord;
    setRpe(null);
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
      <div class="checkin-head"><strong>☀️ 아침 체크인</strong><small>주간 리포트에 반영돼요</small><span class="checkin-saved" id="checkinSaved"></span></div>
      <div class="checkin-grid">
        <label><span>공복 체중</span><div class="unit-input"><input id="ciWeight" inputmode="decimal" value="${esc(log.weight || '')}" placeholder="${latestBodyWeight(state)}"><b>kg</b></div></label>
        <label><span>수면</span><div class="unit-input"><input id="ciSleep" inputmode="decimal" value="${esc(log.sleep || '')}" placeholder="7"><b>시간</b></div></label>
      </div>
      <div class="condition-chips" role="radiogroup" aria-label="컨디션">${Object.entries(CONDITIONS).map(([value, [emoji, label]]) => `<button type="button" data-condition="${value}" class="${+log.condition === +value ? 'on' : ''}" aria-label="컨디션 ${label}"><span>${emoji}</span><small>${label}</small></button>`).join('')}</div>`;
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

  // ---- 점진적 과부하 안내: 지난 기록만으로 다음 목표를 제안한다 ----
  function nextTarget(previous) {
    if (previous.rpe >= 9) return '다음엔 같은 무게로 자세 다지기';
    if (!previous.weight) return '다음 목표 세트당 +1~2회';
    const reps = previous.setList.filter(set => set.weight === previous.weight).map(set => set.reps);
    const allSame = reps.length > 1 && reps.every(rep => rep === reps[0]);
    return allSame ? `다음 목표 ${Math.round((previous.weight + (previous.part === '하체' ? 5 : 2.5)) * 10) / 10}kg` : `다음 목표 ${previous.weight}kg로 전 세트 ${Math.max(...reps)}회`;
  }

  function fillWorkoutFrom(workout) {
    const groups = String(workout.group || workout.type || '').split('·');
    document.querySelectorAll('[name="wt"]').forEach(input => { input.checked = groups.includes(input.value); });
    $('#workoutNote').value = workout.note || workout.name || '';
    syncCardioField();
    renderWorkoutDraft();
  }

  // 주요 부위별로 마지막으로 운동한 날을 찾아 가장 오래 쉰 부위를 고른다.
  function restedPart(state, excludeParts = []) {
    const today = dateKey(new Date());
    const lastDone = {};
    Object.keys(state.logs || {}).filter(validDate).sort().forEach(date => {
      (state.logs[date].workouts || []).forEach(workout => workoutExercises(workout).forEach(exercise => {
        if (!exercise.cardio && exercise.sets) lastDone[exercise.part] = { date, workout };
      }));
    });
    const daysSince = date => Math.round((new Date(`${today}T12:00:00`) - new Date(`${date}T12:00:00`)) / 86400000);
    const candidates = ['하체', '등', '가슴', '어깨'].filter(part => !excludeParts.includes(part)).map(part => ({ part, days: lastDone[part] ? daysSince(lastDone[part].date) : null, workout: lastDone[part]?.workout }));
    return candidates.sort((a, b) => (b.days ?? 99) - (a.days ?? 99))[0];
  }

  function updateHomeHero() {
    const hero = $('#planHero');
    if (!hero) return;
    const state = readState();
    const today = dateKey(new Date());
    const hasLogs = Object.values(state.logs || {}).some(log => (log.meals || []).length || (log.workouts || []).length);
    if (!state.profile?.targetUpdatedAt && !hasLogs) {
      hero.className = 'hero onboard';
      hero.innerHTML = `<span class="tag">시작하기</span><h2>나에게 맞는 기준부터 정해요</h2>
        <ol><li>키·체중·나이로 하루 목표 칼로리 계산</li><li>운동은 적는 즉시 볼륨·소모 칼로리로 정리</li><li>기록은 이 기기에만 저장돼요</li></ol>
        <div class="hero-actions"><button class="primary" data-go="more" data-open="recommendationProfile">목표 계산하기</button><button class="ghost" data-go="workout">먼저 기록해보기</button></div>`;
      return;
    }
    const weeklyGoal = +(state.profile?.workoutGoal || 4);
    let doneDays = 0;
    for (let key = mondayKey(); key <= today; key = addDays(key, 1)) if ((state.logs?.[key]?.workouts || []).length) doneDays++;
    const progress = `<div class="hero-progress"><div class="track"><i style="width:${Math.min(100, doneDays / Math.max(1, weeklyGoal) * 100)}%"></i></div><b>이번 주 ${doneDays}/${weeklyGoal}회</b></div>`;
    const todayWorkouts = state.logs?.[today]?.workouts || [];
    hero.className = 'hero';
    if (todayWorkouts.length) {
      const burned = todayWorkouts.reduce((sum, workout) => sum + (+workout.burnKcal || 0), 0);
      const volume = todayWorkouts.reduce((sum, workout) => sum + workoutVolume(workout), 0);
      const todayParts = todayWorkouts.flatMap(workout => workoutExercises(workout).map(exercise => exercise.part));
      const next = restedPart(state, todayParts);
      hero.innerHTML = `<span class="tag">오늘 운동 완료 ✓</span><h2>${burned ? `약 ${burned.toLocaleString()}kcal 소모` : '오늘도 해냈어요'}</h2>
        <p>${[volume ? `총 볼륨 ${Math.round(volume).toLocaleString()}kg` : '', next ? `다음엔 ${next.part} 차례예요` : ''].filter(Boolean).join(' · ')}</p>
        ${progress}<div class="hero-actions"><button class="ghost" data-go="workout">기록 보기</button></div>`;
      return;
    }
    const suggestion = restedPart(state);
    const previous = suggestion?.workout ? workoutExercises(suggestion.workout).filter(exercise => exercise.part === suggestion.part && exercise.sets) : [];
    const history = exerciseHistory(state, today);
    hero.innerHTML = `<span class="tag">오늘의 추천</span>
      <h2>${suggestion.part} 운동할 차례예요</h2>
      <p>${suggestion.days == null ? `아직 ${suggestion.part} 기록이 없어요. 가볍게 시작해 보세요.` : `${suggestion.part}을 ${suggestion.days}일째 쉬었어요. 지난 기록에서 조금만 더 해봐요.`}</p>
      ${previous.length ? `<ul class="hero-list">${previous.slice(0, 3).map(exercise => {
        const last = (history.get(exerciseKey(exercise.name)) || []).at(-1) || exercise;
        return `<li><span>${esc(exercise.name)}</span><b>${esc(nextTarget(last).replace('다음 목표 ', ''))}</b></li>`;
      }).join('')}</ul>` : ''}
      ${progress}<div class="hero-actions">${suggestion.workout ? `<button class="primary" data-hero-repeat="${esc(suggestion.workout.id || '')}">지난 루틴 불러오기</button>` : ''}<button class="ghost" data-go="workout">운동 기록</button></div>`;
  }

  function installHomeHero() {
    const hero = $('#planHero');
    if (!hero || hero.dataset.enhanced) return;
    hero.dataset.enhanced = 'true';
    hero.addEventListener('click', event => {
      const button = event.target.closest('[data-hero-repeat]');
      if (!button) return;
      const state = readState();
      const workout = Object.values(state.logs || {}).flatMap(log => log.workouts || []).find(item => String(item.id) === button.dataset.heroRepeat);
      if (!workout) return;
      goTo('workout');
      fillWorkoutFrom(workout);
      setTimeout(() => $('#workoutForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
      showToast('지난 루틴을 불러왔어요. 오늘 한 무게·횟수로 고쳐서 저장하세요.');
    });
    updateHomeHero();
  }

  // ---- 목표 계산기 (Mifflin-St Jeor) ----
  const ACTIVITY_LEVELS = [['1.2', '거의 앉아서 생활'], ['1.375', '가볍게 움직임 (주 1~3회 운동)'], ['1.55', '보통 (주 3~5회 운동)'], ['1.725', '활동적 (주 6~7회 운동)']];
  const GOAL_TYPES = ['체지방 감량', '체중 유지', '근육 증가'];

  function calculateTargets(info) {
    const weight = +info.weight; const height = +info.height;
    if (!(weight >= 30 && weight <= 250) || !(height >= 120 && height <= 230)) return null;
    const birth = +info.birthYear;
    const age = birth >= 1920 && birth <= new Date().getFullYear() - 10 ? new Date().getFullYear() - birth : 30;
    const sexOffset = info.sex === '남성' ? 5 : info.sex === '여성' ? -161 : -78;
    const bmr = 10 * weight + 6.25 * height - 5 * age + sexOffset;
    const tdee = bmr * (+info.activity || 1.375);
    const goal = info.goalType || '체중 유지';
    let kcal = goal === '체지방 감량' ? tdee - Math.min(500, tdee * .15) : goal === '근육 증가' ? tdee + Math.min(300, tdee * .1) : tdee;
    kcal = Math.max(info.sex === '여성' ? 1200 : 1400, Math.round(kcal / 10) * 10);
    const protein = Math.round(weight * (goal === '체지방 감량' ? 2 : goal === '근육 증가' ? 1.8 : 1.6));
    const fat = Math.round(kcal * .25 / 9);
    const carbs = Math.max(50, Math.round((kcal - protein * 4 - fat * 9) / 4));
    return { kcal, protein, carbs, fat, bmr: Math.round(bmr), tdee: Math.round(tdee), age, goal };
  }

  function installProfile() {
    const more = $('[data-view="more"] .content');
    const firstCard = more?.querySelector('.card.form');
    if (!more || !firstCard || $('#recommendationProfile')) return;
    const state = readState();
    const info = state.profile?.recommendationContext || {};
    firstCard.classList.add('hidden');
    const section = document.createElement('details');
    section.id = 'recommendationProfile';
    section.className = 'card settings-fold recommendation-profile';
    const option = (value, label, current) => `<option value="${value}" ${String(current) === String(value) ? 'selected' : ''}>${label}</option>`;
    section.innerHTML = `
      <summary><span class="fold-icon">🎯</span><span><strong>목표 설정과 나의 정보</strong><small>키·체중·활동량으로 하루 목표를 계산해요</small></span><b>›</b></summary>
      <div class="fold-content">
        <div class="profile-detail-grid">
          <label class="field full-field"><span>이름 (선택)</span><input class="input" id="ctxName" value="${esc(state.profile?.name || '')}"></label>
          <label class="field"><span>성별</span><select class="select" id="ctxSex">${option('', '선택 안 함', info.sex)}${option('남성', '남성', info.sex)}${option('여성', '여성', info.sex)}</select></label>
          <label class="field"><span>출생연도</span><input class="input" id="ctxBirth" inputmode="numeric" value="${esc(info.birthYear || '')}" placeholder="예: 1995"></label>
          <label class="field"><span>키 cm</span><input class="input" id="ctxHeight" inputmode="decimal" value="${esc(info.height || '')}" placeholder="예: 170"></label>
          <label class="field"><span>체중 kg</span><input class="input" id="ctxWeight" inputmode="decimal" value="${esc(info.weight || '')}" placeholder="예: 65"></label>
          <label class="field full-field"><span>평소 활동량</span><select class="select" id="ctxActivity">${ACTIVITY_LEVELS.map(([value, label]) => option(value, label, info.activity || '1.375')).join('')}</select></label>
          <label class="field"><span>목표</span><select class="select" id="ctxGoalType">${GOAL_TYPES.map(goal => option(goal, goal, info.goalType || '체중 유지')).join('')}</select></label>
          <label class="field"><span>주간 운동 목표</span><select class="select" id="ctxWorkouts">${[2, 3, 4, 5, 6].map(count => option(count, `주 ${count}회`, state.profile?.workoutGoal || 4)).join('')}</select></label>
          <label class="field full-field"><span>목표 체지방률 % (선택)</span><input class="input" id="ctxTargetFat" inputmode="decimal" value="${esc(state.profile?.targetFat || '')}" placeholder="예: 15"></label>
        </div>
        <button type="button" class="primary mint full" id="saveProfileTargets">저장하고 목표 계산</button>
        <div id="currentTargets">${state.profile?.targetUpdatedAt ? targetSummary(state) : ''}</div>
        <p class="notice" id="targetNotice">${esc(state.profile?.targetReason || '계산 결과는 일반적인 추정치예요. 성장기 청소년, 임신·수유 중이거나 질환이 있다면 전문가와 상담하세요.')}</p>
      </div>`;
    firstCard.insertAdjacentElement('afterend', section);
    $('#saveProfileTargets').onclick = () => {
      const next = readState();
      next.profile ||= {};
      const context = {
        ...(next.profile.recommendationContext || {}),
        sex: $('#ctxSex').value, birthYear: $('#ctxBirth').value.trim(), height: $('#ctxHeight').value.trim(), weight: $('#ctxWeight').value.trim(),
        activity: $('#ctxActivity').value, goalType: $('#ctxGoalType').value
      };
      const result = calculateTargets(context);
      const notice = $('#targetNotice');
      if (!result) { notice.textContent = '키(cm)와 체중(kg)을 정확히 입력해 주세요.'; notice.classList.add('warn'); return; }
      notice.classList.remove('warn');
      next.profile.name = $('#ctxName').value.trim();
      next.profile.recommendationContext = context;
      next.profile.workoutGoal = +$('#ctxWorkouts').value;
      next.profile.targetFat = +$('#ctxTargetFat').value || next.profile.targetFat || 0;
      next.profile.targets = { kcal: result.kcal, protein: result.protein, carbs: result.carbs, fat: result.fat };
      next.profile.targetUpdatedAt = new Date().toISOString();
      next.profile.targetReason = `기초대사량 ${result.bmr.toLocaleString()}kcal × 활동량 ${context.activity} = 유지 ${result.tdee.toLocaleString()}kcal → ${result.goal} 기준 ${result.kcal.toLocaleString()}kcal. 단백질은 체중 1kg당 ${(result.protein / +context.weight).toFixed(1)}g으로 잡았어요.`;
      writeState(next);
      $('#currentTargets').innerHTML = targetSummary(next);
      notice.textContent = next.profile.targetReason;
      window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
      showToast('목표를 계산해 저장했어요.');
    };
  }

  // ---- 기록 기반 주간 리포트 ----
  function localReport(state, metrics) {
    const kcalPct = metrics.kcal != null ? Math.round(metrics.kcal / metrics.kcalTarget * 100) : null;
    const proteinPct = metrics.protein != null ? Math.round(metrics.protein / metrics.proteinTarget * 100) : null;
    const lacking = PART_ORDER.filter(part => part !== '코어' && part !== '팔' && metrics.parts[part] < 10);
    const heavy = PART_ORDER.filter(part => metrics.parts[part] > 20);
    const recordDays = Array.from({ length: 7 }, (_, index) => state.logs?.[addDays(metrics.end, -index)]).filter(log => log && ((log.meals || []).length || (log.workouts || []).length || log.weight || log.sleep)).length;
    const status = metrics.rpe >= 9 || (metrics.sleep != null && metrics.sleep < 6) ? '회복' : metrics.volumeChange != null && metrics.volumeChange >= 5 && !(metrics.rpe > 8) ? '상향' : metrics.volumeChange != null && metrics.volumeChange < -20 ? '조정' : '유지';
    const score = Math.round(
      Math.min(1, metrics.workoutDays / Math.max(1, metrics.goal)) * 35 +
      (kcalPct != null ? (1 - Math.min(1, Math.abs(kcalPct - 100) / 30)) * 20 + Math.min(1, (proteinPct || 0) / 100) * 10 : 0) +
      (metrics.sleep != null ? Math.min(1, metrics.sleep / 7) * 14 + (metrics.condition != null ? metrics.condition / 5 * 6 : 3) : 0) +
      recordDays / 7 * 15
    );
    const strengths = [
      metrics.workoutDays >= metrics.goal && `주간 목표 ${metrics.goal}회를 채웠어요.`,
      metrics.volumeChange > 0 && `총 볼륨이 지난주보다 ${metrics.volumeChange}% 늘었어요.`,
      proteinPct >= 90 && `단백질을 목표의 ${proteinPct}%까지 챙겼어요.`,
      metrics.sleep >= 7 && `평균 ${metrics.sleep.toFixed(1)}시간 자며 회복을 챙겼어요.`,
      metrics.mealDays >= 5 && `${metrics.mealDays}일 식단을 기록해 패턴이 잘 보여요.`,
      metrics.workoutDays > 0 && `${metrics.workoutDays}일 운동을 기록했어요.`,
      '기록을 이어가는 것 자체가 가장 좋은 출발이에요.'
    ].filter(Boolean).slice(0, 2);
    const adjustments = [
      metrics.workoutDays < metrics.goal && `주간 목표까지 ${metrics.goal - metrics.workoutDays}회 남았어요. 20분짜리 짧은 운동도 기록해 보세요.`,
      proteinPct != null && proteinPct < 90 && `단백질이 하루 평균 ${Math.round(metrics.proteinTarget - metrics.protein)}g 부족해요. 끼니마다 달걀·두부·살코기를 한 가지씩 더해 보세요.`,
      kcalPct > 105 && `평균 섭취가 목표보다 ${Math.round(metrics.kcal - metrics.kcalTarget)}kcal 많아요. 간식과 음료부터 줄여 보세요.`,
      metrics.sleep != null && metrics.sleep < 7 && `평균 수면이 ${metrics.sleep.toFixed(1)}시간이에요. 30분만 일찍 잠자리에 들어 보세요.`,
      lacking.length && `${lacking.join('·')} 세트가 주 10세트에 못 미쳐요. ${lacking[0]} 운동을 주 2회 넣어 보세요.`,
      metrics.sleep == null && '아침 체크인을 남기면 회복 상태까지 볼 수 있어요.',
      '지금 흐름을 유지하며 무게를 조금씩 올려 보세요.'
    ].filter(Boolean).slice(0, 2);
    return {
      score, status,
      headline: score >= 80 ? '균형 잡힌 한 주였어요' : score >= 60 ? '좋은 흐름, 조금만 더' : metrics.workoutDays ? '루틴을 다시 세우는 한 주' : '기록부터 차근차근',
      summary: `운동 ${metrics.workoutDays}일, 식단 ${metrics.mealDays}일, 체크인 ${Array.from({ length: 7 }, (_, index) => state.logs?.[addDays(metrics.end, -index)]?.sleep).filter(Boolean).length}일을 기록했어요.`,
      training: `총 볼륨 ${Math.round(metrics.volume).toLocaleString()}kg${metrics.volumeChange != null ? `(지난주 대비 ${metrics.volumeChange > 0 ? '+' : ''}${metrics.volumeChange}%)` : ''}${metrics.rpe ? `, 평균 RPE ${metrics.rpe.toFixed(1)}` : ''}. ${lacking.length ? `${lacking.join('·')}는 주 10세트에 못 미쳐요.` : '주요 부위가 고르게 분포했어요.'}${heavy.length ? ` ${heavy.join('·')}는 주 20세트를 넘었어요.` : ''} ${status === '상향' ? '다음 주는 주요 종목 무게를 한 단계 올려도 좋아요.' : status === '회복' ? '다음 주는 무게를 유지하고 회복에 집중하세요.' : status === '조정' ? '운동량이 크게 줄었으니 횟수부터 회복해 보세요.' : '지금 무게로 반복 횟수를 채우는 데 집중하세요.'}`,
      nutrition: kcalPct != null ? `기록한 날 평균 ${Math.round(metrics.kcal).toLocaleString()}kcal로 목표의 ${kcalPct}%, 단백질은 평균 ${Math.round(metrics.protein)}g(목표의 ${proteinPct}%)이에요.` : '식단 기록이 없어 영양은 분석하지 못했어요.',
      recovery: metrics.sleep != null ? `평균 수면 ${metrics.sleep.toFixed(1)}시간${metrics.condition != null ? `, 컨디션 ${metrics.condition.toFixed(1)}/5` : ''}${metrics.weightStart != null && metrics.weightEnd != null ? `, 공복 체중 ${metrics.weightStart}→${metrics.weightEnd}kg` : ''}이에요.` : '아침 체크인(공복 체중·수면·컨디션)을 남기면 회복 상태를 분석해요.',
      strengths, adjustments,
      nextActions: [...adjustments.map(item => item.split('. ').pop()), '운동 후 RPE와 메모 남기기', '매일 아침 체크인하기'].slice(0, 3)
    };
  }

  function installLocalReport() {
    const anchor = $('#bodyComment') || $('#bodyCard');
    if (!anchor || $('#weeklyCoach')) return;
    const coach = document.createElement('section');
    coach.id = 'weeklyCoach';
    coach.className = 'card weekly-coach';
    anchor.insertAdjacentElement('afterend', coach);
    const statusTone = { 상향: 'up', 유지: 'keep', 조정: 'warn', 회복: 'rest' };
    const render = () => {
      const state = readState();
      const metrics = weeklyMetrics(state);
      if (!metrics.workoutDays && !metrics.mealDays && metrics.sleep == null) {
        coach.innerHTML = `<div class="coach-title"><span>WEEKLY REPORT</span><strong>이번 주 기록이 쌓이면 리포트가 만들어져요</strong><small>운동·식단·아침 체크인을 종합해 점수와 다음 주 방향을 자동으로 정리해요.</small></div>${metricTiles(metrics)}`;
        return;
      }
      const report = localReport(state, metrics);
      coach.innerHTML = `<div class="report-top"><div class="coach-title"><span>WEEKLY REPORT · ${shortDate(metrics.start)}–${shortDate(metrics.end)}</span><strong>${esc(report.headline)}</strong></div><div class="score-ring" style="--p:${report.score}"><b>${report.score}</b><small>점</small></div></div>
        <p class="report-summary">${esc(report.summary)}</p>
        ${metricTiles(metrics)}
        <div class="report-section"><h4>훈련 <i class="status ${statusTone[report.status]}">다음 주 ${report.status}</i></h4><p>${esc(report.training)}</p></div>
        <div class="report-section"><h4>영양</h4><p>${esc(report.nutrition)}</p></div>
        <div class="report-section"><h4>회복</h4><p>${esc(report.recovery)}</p></div>
        <div class="coach-columns"><div><b>잘한 점</b>${report.strengths.map(item => `<p>✓ ${esc(item)}</p>`).join('')}</div><div><b>조정할 점</b>${report.adjustments.map(item => `<p>• ${esc(item)}</p>`).join('')}</div></div>
        <div class="coach-plan"><b>다음 7일 실행 계획</b>${report.nextActions.map((item, index) => `<p><span>${index + 1}</span>${esc(item)}</p>`).join('')}</div>
        <small class="coach-note">최근 7일 기록으로 자동 계산한 요약이에요. 점수는 운동 35 · 영양 30 · 회복 20 · 기록 15 기준이며, 의료 진단을 대신하지 않아요.</small>`;
    };
    render();
    window.addEventListener('fitlog:state-updated', render);
    // 식사 추가·삭제는 index.html 쪽에서 저장하므로 리포트 탭을 열 때도 다시 계산한다.
    window.addEventListener('hashchange', () => { if (location.hash === '#report') render(); });
  }

  function installMealForm() {
    const type = $('#mealType');
    if (!type) return;
    const hour = new Date().getHours();
    type.value = hour >= 4 && hour < 10 ? '아침' : hour >= 10 && hour < 15 ? '점심' : hour >= 15 && hour < 21 ? '저녁' : '간식';
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
      .parsed li small.prev-hint{display:block;margin-top:3px;color:#2f8467;font-size:11px;line-height:1.4}
      .input-hint{margin:6px 2px 0;color:var(--sub);font-size:12px;line-height:1.5}.input-hint b{color:var(--ink)}
      .parsed{margin:0 0 12px;padding:12px;border-radius:15px;background:#f3f9f6;color:var(--sub);font-size:12px}.parsed-head{display:flex;justify-content:space-between;align-items:center;gap:8px}.parsed-head b{color:#c2573c;font-size:14px}.parsed ul{margin:8px 0 0;padding:0;list-style:none}.parsed li{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 0;border-top:1px dashed #dcebe5}.parsed li strong,.parsed li span{display:block}.parsed li strong{color:var(--ink);font-size:13px}.parsed li span{margin-top:2px;font-size:12px}.parsed-foot{margin-top:6px;padding-top:8px;border-top:1px solid #dcebe5;font-size:12px}.parsed-foot b{color:#2f8467}
      .workout-meta{display:grid;grid-template-columns:112px 1fr;gap:10px}.workout-meta .field>span small{color:#2f8467;font-weight:800}.rpe-chips{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}.rpe-chips button{height:44px;border:1px solid var(--line);border-radius:12px;background:#f9fcfb;font-weight:900}.rpe-chips button.on{background:#17372c;border-color:#17372c;color:#fff}
      .plan-card{margin-bottom:12px;padding:15px}.plan-card:empty{display:none}.plan-eyebrow{display:block;color:#477e9d;font-size:11px;font-weight:950;letter-spacing:.3px}.plan-empty{display:grid;gap:6px}.plan-empty strong{font-size:17px}.plan-empty small{color:var(--sub);font-size:12px;line-height:1.55}.plan-empty .primary{margin-top:6px}.plan-loading{min-height:120px;display:grid;place-items:center;align-content:center;gap:6px;text-align:center}.plan-loading small{color:var(--sub);font-size:12px}
      .plan-head{display:flex;justify-content:space-between;align-items:start;gap:8px}.plan-head strong{display:block;margin-top:3px;font-size:18px}.plan-principle{margin:10px 0 0;padding:10px 12px;border-radius:13px;background:#eef7ff;color:#335f79;font-size:12px;line-height:1.55}.plan-alert{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding:10px 12px;border-radius:13px;background:#fff1ec;color:#a4492f;font-size:12px;font-weight:800}.plan-alert button{flex:none;border:0;border-radius:10px;background:#c2573c;color:#fff;padding:8px 10px;font-size:12px;font-weight:900}
      .plan-strip{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin:12px 0}.plan-day{min-width:0;padding:7px 0 6px;border:1px solid transparent;border-radius:13px;background:#f3f8f6;display:grid;justify-items:center;gap:3px}.plan-day span{color:var(--sub);font-size:11px}.plan-day b{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#fff;font-size:12px}.plan-day small{max-width:100%;overflow:hidden;color:var(--sub);font-size:10px;white-space:nowrap}.plan-day.done b{background:var(--mint);color:#fff}.plan-day.missed b{background:#ffd9cf;color:#b05243}.plan-day.rest{background:#fafcfb}.plan-day.rest b{background:transparent;color:#a3b3ad}.plan-day.is-today span{color:var(--ink);font-weight:900}.plan-day.selected{border-color:#17372c;background:#fff}.plan-day:disabled{opacity:.4}
      .plan-detail{padding:12px;border-radius:15px;background:#f7fbf9}.plan-detail.rest p{margin:6px 0 0;color:var(--sub);font-size:13px;line-height:1.55}.plan-detail-head{display:flex;justify-content:space-between;align-items:center;gap:8px}.plan-detail-head strong{font-size:14px}.plan-exercises{margin:8px 0 0;padding:0;list-style:none;counter-reset:ex}.plan-exercises li{display:flex;justify-content:space-between;align-items:start;gap:10px;padding:8px 0;border-top:1px dashed #dcebe5}.plan-exercises li strong{display:block;font-size:13px}.plan-exercises li small{display:block;margin-top:2px;color:#2f8467;font-size:11px;line-height:1.45}.plan-exercises li b{flex:none;font-size:13px}.plan-note{margin:8px 0 0;color:var(--sub);font-size:12px;line-height:1.5}.plan-detail .primary{margin-top:10px}
      .hero-list{margin:6px 0 12px;padding:0;list-style:none}.hero-list li{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #17372c12;font-size:13px}.hero-list li b{white-space:nowrap}.hero-list li.more{color:var(--sub);border:0}
      .checkin{margin-top:9px;padding:12px 14px}.checkin-head{display:flex;align-items:baseline;gap:7px;margin-bottom:9px}.checkin-head strong{font-size:14px}.checkin-head small{color:var(--sub);font-size:11px}.checkin-saved{margin-left:auto;color:#2f8467;font-size:11px;font-weight:800}.checkin-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.checkin-grid label>span{display:block;margin-bottom:4px;color:var(--sub);font-size:11px}.unit-input{position:relative}.unit-input input{width:100%;height:40px;border:1px solid var(--line);border-radius:12px;background:#f9fcfb;padding:0 42px 0 11px;font-size:16px}.unit-input b{position:absolute;right:11px;top:50%;transform:translateY(-50%);color:var(--sub);font-size:12px}.condition-chips{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin-top:9px}.condition-chips button{height:48px;border:1px solid var(--line);border-radius:12px;background:#f9fcfb;display:grid;place-items:center;align-content:center;gap:1px}.condition-chips span{font-size:18px;line-height:1}.condition-chips small{color:var(--sub);font-size:10px}.condition-chips button.on{border-color:#72d1ae;background:#dcf5eb}.checkin.done{display:flex;align-items:center;gap:8px}.checkin.done .checkin-title{color:var(--sub);font-size:12px;white-space:nowrap}.checkin.done b{flex:1;font-size:13px}.checkin.done .link{padding:4px}
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

  if (migrateMonthlyLog()) {
    location.reload();
    return;
  }
  removeLegacyDemoMeals();
  injectStyles();
  updateMascot();
  refreshIcons();
  installHomeHero();
  installCalendar();
  installWorkoutForm();
  installCheckin();
  installMealForm();
  installProfile();
  installBodyGoals();
  renderRealReportCharts();
  installLocalReport();
  renderGroupedMeals();
  removeDuplicateArchive();
  [$('#mealPreview'), $('#mealList')].filter(Boolean).forEach(target => new MutationObserver(() => renderGroupedMeals()).observe(target, { childList: true }));
  window.addEventListener('hashchange', () => {
    if (location.hash === '#workout') { renderCalendar(); renderWorkoutDraft(); }
    if (location.hash === '#report') renderRealReportCharts();
    if (location.hash === '#home') { updateHomeHero(); renderCheckin(); }
    removeDuplicateArchive();
  });
  window.addEventListener('fitlog:state-updated', () => {
    updateMascot();
    updateHomeHero();
    if (!$('#checkin')?.contains(document.activeElement)) renderCheckin();
    renderCalendar();
    renderRealReportCharts();
    renderGroupedMeals();
  });
})();
