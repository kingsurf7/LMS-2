const state = {
  token: localStorage.getItem('lumina_token'),
  user: JSON.parse(localStorage.getItem('lumina_user') || 'null'),
  view: 'overview',
  modules: [],
  courses: [],
  selectedCourse: null,
  selectedLesson: null
};

const $ = (selector) => document.querySelector(selector);
const root = $('#view-root');
const roleNames = { promoter: 'Promoteur', teacher: 'Enseignant', student: 'Etudiant' };

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.message || 'Action impossible.');
  return data;
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  Object.assign(el.style, {
    position: 'fixed',
    right: '18px',
    bottom: '18px',
    zIndex: 50,
    padding: '12px 14px',
    borderRadius: '8px',
    color: '#fff',
    background: type === 'error' ? '#e11d48' : '#0f9f8f',
    fontWeight: 800,
    boxShadow: '0 16px 40px rgba(18,24,38,.18)'
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function saveSession(payload) {
  state.token = payload.token;
  state.user = payload.user;
  localStorage.setItem('lumina_token', payload.token);
  localStorage.setItem('lumina_user', JSON.stringify(payload.user));
}

function logout() {
  localStorage.removeItem('lumina_token');
  localStorage.removeItem('lumina_user');
  state.token = null;
  state.user = null;
  $('#auth-screen').classList.remove('hidden');
  $('#app-screen').classList.add('hidden');
}

function showApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  $('#user-name').textContent = state.user.name;
  $('#user-email').textContent = state.user.email;
  $('#role-label').textContent = roleNames[state.user.role];
  $('#user-initials').textContent = state.user.name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  document.querySelectorAll('.nav').forEach((button) => {
    const restricted = {
      studio: ['teacher', 'promoter'],
      progress: ['student'],
      certificates: ['student', 'promoter']
    };
    const allowed = restricted[button.dataset.view];
    button.style.display = allowed && !allowed.includes(state.user.role) ? 'none' : '';
  });
  navigate(state.view);
}

function setTitle(title) {
  $('#page-title').textContent = title;
  document.querySelectorAll('.nav').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
  });
}

function serialize(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function loadBasics() {
  const [modules, courses] = await Promise.all([api('/api/modules'), api('/api/courses')]);
  state.modules = modules;
  state.courses = courses;
}

async function navigate(view) {
  state.view = view;
  setTitle({ overview: 'Aperçu', modules: 'Modules', courses: 'Cours', studio: 'Studio', progress: 'Progression', certificates: 'Certificats' }[view]);
  try {
    if (['modules', 'courses', 'studio', 'overview'].includes(view)) await loadBasics();
    if (view === 'overview') return renderOverview();
    if (view === 'modules') return renderModules();
    if (view === 'courses') return renderCourses();
    if (view === 'studio') return renderStudio();
    if (view === 'progress') return renderProgress();
    if (view === 'certificates') return renderCertificates();
  } catch (error) {
    root.innerHTML = `<section class="panel"><h3>Erreur</h3><p>${error.message}</p></section>`;
  }
}

async function renderOverview() {
  const dashboard = await api('/api/dashboard');
  root.innerHTML = `
    <section class="stats-grid">
      ${stat('Modules', dashboard.stats.modules)}
      ${stat('Cours', dashboard.stats.courses)}
      ${stat('Leçons', dashboard.stats.lessons)}
      ${stat('Certificats', dashboard.stats.certificates)}
    </section>
    <section class="panel" style="margin-top:18px">
      <h3>Derniers cours publiés</h3>
      <div class="card-grid">
        ${dashboard.latest.map(courseCard).join('') || empty('Aucun cours pour le moment.')}
      </div>
    </section>`;
}

function stat(label, value) {
  return `<article class="stat"><span class="eyebrow">${label}</span><strong>${value}</strong></article>`;
}

function empty(text) {
  return `<p>${text}</p>`;
}

function courseCard(course) {
  return `
    <article class="card">
      <p class="eyebrow">${course.module_title || 'Module'}</p>
      <h3>${course.title}</h3>
      <p>${course.description || 'Cours sans description.'}</p>
      <div class="meta-row">
        <span class="pill">${course.lesson_count || 0} leçon(s)</span>
        <span class="pill">${course.teacher_name || 'Enseignant à assigner'}</span>
      </div>
      <button class="quiet" data-open-course="${course.id}">Ouvrir</button>
      ${state.user.role === 'student' ? `<button class="primary" data-enroll="${course.id}">${course.enrolled ? 'Inscrit' : 'S’inscrire'}</button>` : ''}
    </article>`;
}

function renderModules() {
  const promoterForm = state.user.role === 'promoter' ? `
    <section class="panel">
      <h3>Nouveau module</h3>
      <form id="module-form" class="form-grid">
        <label>Titre<input name="title" required /></label>
        <label>Niveau<input name="level" value="Débutant" /></label>
        <label>Seuil certificat (%)<input name="certificate_threshold" type="number" min="1" max="100" value="70" /></label>
        <label class="full">Description<textarea name="description"></textarea></label>
        <button class="primary" type="submit">Créer le module</button>
      </form>
    </section>` : '';

  root.innerHTML = `
    ${promoterForm}
    <section class="card-grid">
      ${state.modules.map((module) => `
        <article class="card">
          <p class="eyebrow">${module.level}</p>
          <h3>${module.title}</h3>
          <p>${module.description || 'Module prêt à recevoir des cours.'}</p>
          <div class="meta-row">
            <span class="pill">${module.course_count} cours</span>
            <span class="pill">Seuil ${module.certificate_threshold}%</span>
            <span class="pill">${module.certificate_count} certificat(s)</span>
          </div>
          ${state.user.role === 'student' ? `<button class="primary" data-certificate-module="${module.id}">Demander certificat</button>` : ''}
        </article>`).join('') || empty('Aucun module disponible.')}
    </section>`;

  $('#module-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await api('/api/modules', { method: 'POST', body: JSON.stringify(serialize(event.target)) });
    toast('Module créé.');
    navigate('modules');
  });
}

function renderCourses() {
  root.innerHTML = `<section class="card-grid">${state.courses.map(courseCard).join('') || empty('Aucun cours publié.')}</section>`;
}

function renderStudio() {
  if (state.user.role === 'promoter') {
    root.innerHTML = `
      <section class="panel">
        <h3>Console promoteur</h3>
        <p>Créez les modules depuis l’onglet Modules, puis laissez les enseignants y rattacher leurs cours.</p>
      </section>
      <section class="card-grid">${state.modules.map((m) => `<article class="card"><h3>${m.title}</h3><p>${m.description || ''}</p><span class="pill">${m.certificate_threshold}% pour valider</span></article>`).join('')}</section>`;
    return;
  }

  root.innerHTML = `
    <section class="split">
      <div>
        <section class="panel">
          <h3>Nouveau cours</h3>
          <form id="course-form" class="form-stack">
            <label>Module
              <select name="module_id">${state.modules.map((m) => `<option value="${m.id}">${m.title}</option>`).join('')}</select>
            </label>
            <label>Titre<input name="title" required /></label>
            <label>Description<textarea name="description"></textarea></label>
            <label>Image de couverture<input name="cover" type="file" accept="image/*" /></label>
            <button class="primary" type="submit">Créer le cours</button>
          </form>
        </section>
        <section class="panel">
          <h3>Nouvelle leçon</h3>
          <form id="lesson-form" class="form-stack">
            <label>Cours
              <select name="course_id">${state.courses.map((c) => `<option value="${c.id}">${c.title}</option>`).join('')}</select>
            </label>
            <label>Titre<input name="title" required /></label>
            <label>Résumé<textarea name="summary"></textarea></label>
            <div class="form-grid">
              <label>Type
                <select name="content_type">
                  <option value="pdf">PDF</option>
                  <option value="video">Vidéo</option>
                </select>
              </label>
              <label>Position<input name="position" type="number" min="1" value="1" /></label>
            </div>
            <label>Fichier<input name="content" type="file" accept=".pdf,video/*" required /></label>
            <button class="primary" type="submit">Ajouter la leçon</button>
          </form>
        </section>
      </div>
      <section class="panel">
        <h3>Evaluation QCM</h3>
        <form id="evaluation-form" class="form-stack">
          <label>Cours
            <select name="course_id" id="eval-course">${state.courses.map((c) => `<option value="${c.id}">${c.title}</option>`).join('')}</select>
          </label>
          <label>Leçon<select name="lesson_id" id="eval-lesson"></select></label>
          <label>Titre<input name="title" value="Evaluation de fin de leçon" required /></label>
          <label>Score de réussite (%)<input name="pass_score" type="number" min="1" max="100" value="60" /></label>
          <div id="question-list"></div>
          <button class="ghost" type="button" id="add-question">Ajouter une question</button>
          <button class="primary" type="submit">Enregistrer l’évaluation</button>
        </form>
      </section>
    </section>`;

  bindStudioForms();
}

function addQuestion() {
  const node = $('#question-template').content.cloneNode(true);
  $('#question-list').appendChild(node);
}

async function refreshEvalLessons() {
  const courseId = $('#eval-course')?.value;
  if (!courseId) return;
  const data = await api(`/api/courses/${courseId}`);
  $('#eval-lesson').innerHTML = data.lessons.map((lesson) => `<option value="${lesson.id}">${lesson.position}. ${lesson.title}</option>`).join('');
}

function bindStudioForms() {
  $('#course-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    await api('/api/courses', { method: 'POST', body: formData });
    toast('Cours créé.');
    navigate('studio');
  });

  $('#lesson-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    const courseId = formData.get('course_id');
    formData.delete('course_id');
    await api(`/api/courses/${courseId}/lessons`, { method: 'POST', body: formData });
    toast('Leçon ajoutée.');
    navigate('studio');
  });

  $('#add-question')?.addEventListener('click', addQuestion);
  $('#eval-course')?.addEventListener('change', refreshEvalLessons);
  addQuestion();
  refreshEvalLessons();

  $('#evaluation-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    const questionBoxes = [...document.querySelectorAll('.question-box')];
    const questions = questionBoxes.map((box) => ({
      question: box.querySelector('[name="question"]').value,
      option_a: box.querySelector('[name="option_a"]').value,
      option_b: box.querySelector('[name="option_b"]').value,
      option_c: box.querySelector('[name="option_c"]').value,
      option_d: box.querySelector('[name="option_d"]').value,
      correct_option: box.querySelector('[name="correct_option"]').value
    }));
    await api(`/api/lessons/${formData.get('lesson_id')}/evaluation`, {
      method: 'POST',
      body: JSON.stringify({
        title: formData.get('title'),
        pass_score: formData.get('pass_score'),
        questions
      })
    });
    toast('Evaluation enregistrée.');
  });
}

async function openCourse(courseId) {
  const data = await api(`/api/courses/${courseId}`);
  state.selectedCourse = data.course;
  state.selectedLesson = data.lessons[0] || null;
  renderCourseDetail(data);
}

function renderCourseDetail(data) {
  const { course, lessons } = data;
  const active = state.selectedLesson || lessons[0];
  root.innerHTML = `
    <section class="panel">
      <p class="eyebrow">${course.module_title}</p>
      <h3>${course.title}</h3>
      <p>${course.description || ''}</p>
      <div class="meta-row">
        <span class="pill">${course.teacher_name || 'Enseignant'}</span>
        <span class="pill">Certificat à ${course.certificate_threshold}%</span>
      </div>
    </section>
    <section class="split">
      <div class="lesson-list">
        ${lessons.map((lesson) => `
          <article class="lesson">
            <span class="lesson-number">${lesson.position}</span>
            <div>
              <strong>${lesson.title}</strong>
              <p>${lesson.summary || lesson.content_type.toUpperCase()}</p>
              ${lesson.student_score !== null ? `<span class="pill">Score ${lesson.student_score}%</span>` : ''}
            </div>
            <button class="ghost" data-select-lesson="${lesson.id}">Voir</button>
          </article>`).join('') || empty('Aucune leçon dans ce cours.')}
      </div>
      <div id="lesson-pane">${active ? lessonPane(active) : ''}</div>
    </section>`;

  document.querySelectorAll('[data-select-lesson]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedLesson = lessons.find((lesson) => lesson.id === Number(button.dataset.selectLesson));
      $('#lesson-pane').innerHTML = lessonPane(state.selectedLesson);
      bindEvaluationButton();
    });
  });
  bindEvaluationButton();
}

function lessonPane(lesson) {
  const media = lesson.content_type === 'video'
    ? `<video src="${lesson.content_url}" controls></video>`
    : `<iframe src="${lesson.content_url}"></iframe>`;
  return `
    <section class="panel">
      <h3>${lesson.title}</h3>
      <div class="viewer">${media}</div>
      ${state.user.role === 'student' && lesson.evaluation_id ? `<button class="primary" data-start-evaluation="${lesson.id}">Passer l’évaluation</button>` : ''}
      ${!lesson.evaluation_id ? '<p>Aucune évaluation attachée pour le moment.</p>' : ''}
    </section>`;
}

function bindEvaluationButton() {
  $('[data-start-evaluation]')?.addEventListener('click', async (event) => {
    const lessonId = event.target.dataset.startEvaluation;
    const data = await api(`/api/lessons/${lessonId}/evaluation`);
    $('#lesson-pane').innerHTML += `
      <section class="panel" id="quiz-panel">
        <h3>${data.evaluation.title}</h3>
        <form id="quiz-form" class="form-stack">
          ${data.questions.map((q) => `
            <fieldset class="question-box">
              <legend>${q.question}</legend>
              <div class="choice-list">
                ${['a', 'b', 'c', 'd'].map((key) => {
                  const value = key.toUpperCase();
                  return `<label><input type="radio" name="${q.id}" value="${value}" required /> ${value}. ${q[`option_${key}`]}</label>`;
                }).join('')}
              </div>
            </fieldset>`).join('')}
          <button class="primary" type="submit">Soumettre mes réponses</button>
        </form>
      </section>`;
    $('#quiz-form').addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();
      const answers = Object.fromEntries(new FormData(submitEvent.target).entries());
      const result = await api(`/api/lessons/${lessonId}/submit`, { method: 'POST', body: JSON.stringify({ answers }) });
      toast(`Score obtenu: ${result.score}%`);
      openCourse(state.selectedCourse.id);
    });
  });
}

async function renderProgress() {
  const progress = await api('/api/progress');
  root.innerHTML = `<section class="card-grid">${progress.map((item) => `
    <article class="card">
      <p class="eyebrow">${item.module_title}</p>
      <h3>${item.course_title}</h3>
      <p>${item.completed_lessons}/${item.lesson_count} leçon(s) évaluée(s). Moyenne: ${item.average_score}%.</p>
      <div class="progress-bar"><span style="width:${item.completion_percent}%"></span></div>
      <div class="meta-row"><span class="pill">${item.completion_percent}% complété</span></div>
      <button class="primary" data-certificate-module="${item.module_id}">Demander certificat</button>
    </article>`).join('') || empty('Inscrivez-vous à un cours pour suivre votre progression.')}</section>`;
}

async function renderCertificates() {
  const certificates = await api('/api/certificates');
  root.innerHTML = `<section class="card-grid">${certificates.map((cert) => `
    <article class="card">
      <p class="eyebrow">Certificat</p>
      <h3>${cert.module_title}</h3>
      <p>Attribué à ${cert.student_name} avec une moyenne de ${cert.average_score}%.</p>
      <div class="meta-row">
        <span class="pill">${cert.certificate_code}</span>
        <span class="pill">${new Date(cert.issued_at).toLocaleDateString('fr-FR')}</span>
      </div>
      <button class="quiet" onclick="window.print()">Imprimer</button>
    </article>`).join('') || empty('Aucun certificat pour le moment.')}</section>`;
}

document.addEventListener('click', async (event) => {
  const courseButton = event.target.closest('[data-open-course]');
  const enrollButton = event.target.closest('[data-enroll]');
  const certificateButton = event.target.closest('[data-certificate-module]');

  try {
    if (courseButton) await openCourse(courseButton.dataset.openCourse);
    if (enrollButton) {
      await api(`/api/courses/${enrollButton.dataset.enroll}/enroll`, { method: 'POST' });
      toast('Inscription confirmée.');
      navigate('courses');
    }
    if (certificateButton) {
      const cert = await api(`/api/modules/${certificateButton.dataset.certificateModule}/certificate`, { method: 'POST' });
      toast(`Certificat ${cert.certificate_code} généré.`);
      navigate('certificates');
    }
  } catch (error) {
    toast(error.message, 'error');
  }
});

document.querySelectorAll('[data-demo]').forEach((button) => {
  button.addEventListener('click', () => {
    $('#login-form [name=email]').value = button.dataset.demo;
    $('#login-form [name=password]').value = 'password123';
  });
});

document.querySelectorAll('[data-auth-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    const login = button.dataset.authTab === 'login';
    document.querySelectorAll('[data-auth-tab]').forEach((tab) => tab.classList.toggle('active', tab === button));
    $('#login-form').classList.toggle('hidden', !login);
    $('#register-form').classList.toggle('hidden', login);
  });
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(serialize(event.target)) });
    saveSession(payload);
    showApp();
  } catch (error) {
    $('#auth-message').textContent = error.message;
  }
});

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(serialize(event.target)) });
    saveSession(payload);
    showApp();
  } catch (error) {
    $('#auth-message').textContent = error.message;
  }
});

document.querySelectorAll('.nav').forEach((button) => {
  button.addEventListener('click', () => navigate(button.dataset.view));
});

$('#logout').addEventListener('click', logout);

if (state.token && state.user) {
  showApp();
} else {
  logout();
}
