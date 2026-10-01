(() => {
  'use strict';

  // 화면 배치 정리: 모든 모듈이 화면을 그린 뒤에 실행한다.
  const $ = (selector, root = document) => root.querySelector(selector);
  const view = name => $(`[data-view="${name}"] .content`);
  const headingOf = (root, text) => [...root.querySelectorAll('.section-head')].find(el => el.textContent.includes(text));
  // 기존 화면 코드가 값을 써 넣는 요소가 있어서 지우지 않고 숨긴다.
  const hide = el => { if (el) el.hidden = true; };
  const hideSection = (root, text) => {
    const head = headingOf(root, text);
    if (!head) return;
    const next = head.nextElementSibling;
    if (next && !next.classList.contains('section-head')) hide(next);
    hide(head);
  };
  const sectionHead = title => {
    const head = document.createElement('div');
    head.className = 'section-head';
    head.innerHTML = `<h2>${title}</h2>`;
    return head;
  };

  function arrangeWorkout() {
    const workout = view('workout');
    const report = view('report');
    const calendar = $('#calendarArchive');
    if (!workout || !report) return;
    // 기록 달력은 리포트 맨 아래로 옮긴다.
    if (calendar && !report.contains(calendar)) {
      hide(headingOf(workout, '기록 보관함'));
      report.append(sectionHead('기록 달력'), calendar);
    }
    hide($('#workoutList'));
  }

  function arrangeMeals() {
    const meals = view('meals');
    if (!meals) return;
    const header = meals.querySelector('header');
    // 입력이 먼저, 지난 기록·급식표·추천은 그 아래.
    // 공개용은 AI 입력칸 대신 직접 입력 폼(식사 기록 제목 · 목록 · 입력 카드)이 입력 자리에 온다.
    const manualHead = $('#aiMealComposer') ? null : headingOf(meals, '식사 기록');
    const manual = manualHead ? [manualHead, $('#mealList'), $('#mealList')?.nextElementSibling] : [];
    const order = [...manual, ...['#aiMealComposer', '#aiMealPreview', '#mealDays', '#mealRecommendation', '#lunchManager'].map(id => $(id))].filter(Boolean);
    let anchor = header;
    order.forEach(node => { anchor.after(node); anchor = node; });
    hideSection(meals, '남은 끼니 추천');
    hide($('#mealAdvice'));
  }

  function arrangeReport() {
    const report = view('report');
    if (!report) return;
    const header = report.querySelector('header');
    if (header) header.innerHTML = '<div><h1>리포트</h1></div>';
    hide($('#bodyComment'));
  }

  function arrangeSettings() {
    const more = view('more');
    if (!more) return;
    hideSection(more, '앱 정보');
    hideSection(more, '데이터 관리');
    hide($('#csv'));
    // 목표·인바디 → 로그인·AI → 백업 순서.
    const sync = $('#syncPanel');
    const inbody = $('#inbodyPanel');
    if (sync && inbody) inbody.after(sync);
  }

  // 기록 시트의 '체크인'은 홈의 체크인 칸을 열어 준다.
  function installCheckinShortcut() {
    document.addEventListener('click', event => {
      if (!event.target.closest('[data-checkin-open]')) return;
      setTimeout(() => {
        $('#checkin [data-checkin-edit]')?.click();
        const card = $('#checkin');
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => $('#ciWeight')?.focus({ preventScroll: true }), 350);
      }, 60);
    });
  }

  function arrange() {
    arrangeWorkout();
    arrangeMeals();
    arrangeReport();
    arrangeSettings();
  }

  arrange();
  installCheckinShortcut();
  // 다른 모듈이 늦게 다시 그리는 경우를 대비해 한 번 더 맞춘다.
  window.addEventListener('load', arrange);
  window.addEventListener('fitlog:state-updated', () => setTimeout(arrangeReport, 0));
})();
