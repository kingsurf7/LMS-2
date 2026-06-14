const state = {
  token: localStorage.getItem('brain_token'),
  user: JSON.parse(localStorage.getItem('brain_user') || 'null'),
  view: 'overview',
  modules: [],
  courses: [],
  selectedCourse: null,
  selectedLesson: null
};

const $ = (selector) => document.querySelector(selector);
const root = $('#view-root');
const roleNames = { promoter: '👑 Promoteur', teacher: '👨‍🏫 Enseignant', student: '👨‍🎓 Étudiant' };

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  
  if (!response.ok) {
    throw new Error(data.message || 'Une erreur est survenue');
  }
  return data;
}

function toast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toast.style.background = type === 'error' ? 'var(--rose)' : 'var(--teal)';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function saveSession(payload) {
  state.token = payload.token;
  state.user = payload.user;
  localStorage.setItem('brain_token', payload.token);
  localStorage.setItem('brain_user', JSON.stringify(payload.user));
}

function logout() {
  localStorage.removeItem('brain_token');
  localStorage.removeItem('brain_user');
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
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  
  // Masquer les onglets selon le rôle
  document.querySelectorAll('.nav').forEach(btn => {
    const restricted = {
      studio: ['teacher', 'promoter'],
      progress: ['student'],
      certificates: ['student', 'promoter']
    };
    const allowed = restricted[btn.dataset.view];
    if (allowed && !allowed.includes(state.user.role)) {
      btn.style.display = 'none';
    } else {
      btn.style.display = '';
    }
  });
  
  navigate(state.view);
}

function setTitle(title) {
  $('#page-title').textContent = title;
  document.querySelectorAll('.nav').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === state.view);
  });
}

function serialize(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function loadBasics() {
  try {
    const [modules, courses] = await Promise.all([
      api('/api/modules'),
      api('/api/courses')
    ]);
    state.modules = modules;
    state.courses = courses;
  } catch (error) {
    console.error('Erreur chargement:', error);
  }
}

async function navigate(view) {
  state.view = view;
  const titles = {
    overview: 'Tableau de bord',
    modules: 'Modules',
    courses: 'Cours',
    studio: 'Studio créateur',
    progress: 'Ma progression',
    certificates: 'Mes certificats'
  };
  setTitle(titles[view]);
  
  try {
    if (['modules', 'courses', 'studio', 'overview'].includes(view)) {
      await loadBasics();
    }
    
    if (view === 'overview') await renderOverview();
    else if (view === 'modules') await renderModules();
    else if (view === 'courses') await renderCourses();
    else if (view === 'studio') await renderStudio();
    else if (view === 'progress') await renderProgress();
    else if (view === 'certificates') await renderCertificates();
  } catch (error) {
    root.innerHTML = `<div class="panel"><h3>Erreur</h3><p>${error.message}</p></div>`;
  }
}

async function renderOverview() {
  const data = await api('/api/dashboard');
  root.innerHTML = `
    <div class="stats-grid">
      <div class="stat"><span class="eyebrow">Modules</span><strong>${data.stats.modules}</strong></div>
      <div class="stat"><span class="eyebrow">Cours</span><strong>${data.stats.courses}</strong></div>
      <div class="stat"><span class="eyebrow">Leçons</span><strong>${data.stats.lessons}</strong></div>
      <div class="stat"><span class="eyebrow">Certificats</span><strong>${data.stats.certificates}</strong></div>
    </div>
    <div class="panel">
      <h3>📖 Derniers cours</h3>
      <div class="card-grid">
        ${data.latest.map(c => `
          <div class="card">
            <p class="eyebrow">${c.module_title}</p>
            <h3>${c.title}</h3>
            <p>${c.description || 'Aucune description'}</p>
            <div class="meta-row">
              <span class="pill">👨‍🏫 ${c.teacher_name || 'Enseignant'}</span>
            </div>
            <button class="quiet" data-open-course="${c.id}">Voir le cours</button>
          </div>
        `).join('') || '<p>Aucun cours disponible</p>'}
      </div>
    </div>
  `;
}

async function renderModules() {
  const promoterForm = state.user.role === 'promoter' ? `
    <div class="panel">
      <h3>➕ Créer un module</h3>
      <form id="module-form" class="form-grid">
        <label>Titre <input name="title" required></label>
        <label>Niveau <input name="level" value="Débutant"></label>
        <label>Seuil certificat (%) <input name="certificate_threshold" type="number" value="70"></label>
        <label class="full">Description <textarea name="description"></textarea></label>
        <button class="primary" type="submit">Créer</button>
      </form>
    </div>
  ` : '';
  
  root.innerHTML = `
    ${promoterForm}
    <div class="card-grid">
      ${state.modules.map(m => `
        <div class="card">
          <p class="eyebrow">${m.level}</p>
          <h3>${m.title}</h3>
          <p>${m.description || 'Module prêt à l\'emploi'}</p>
          <div class="meta-row">
            <span class="pill">📚 ${m.course_count || 0} cours</span>
            <span class="pill">🎯 Seuil ${m.certificate_threshold}%</span>
          </div>
          ${state.user.role === 'student' ? `<button class="primary" data-certificate-module="${m.id}">Obtenir certificat</button>` : ''}
        </div>
      `).join('')}
    </div>
  `;
  
  $('#module-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/modules', { method: 'POST', body: JSON.stringify(serialize(e.target)) });
    toast('Module créé avec succès');
    navigate('modules');
  });
}

async function renderCourses() {
  root.innerHTML = `
    <div class="card-grid">
      ${state.courses.map(c => `
        <div class="card">
          <p class="eyebrow">${c.module_title}</p>
          <h3>${c.title}</h3>
          <p>${c.description || 'Cours sans description'}</p>
          <div class="meta-row">
            <span class="pill">📖 ${c.lesson_count || 0} leçons</span>
            <span class="pill">👨‍🏫 ${c.teacher_name || 'Enseignant'}</span>
          </div>
          <button class="quiet" data-open-course="${c.id}">Voir</button>
          ${state.user.role === 'student' ? `<button class="primary" data-enroll="${c.id}">${c.enrolled ? '✅ Inscrit' : 'S\'inscrire'}</button>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderStudio() {
  if (state.user.role === 'promoter') {
    root.innerHTML = `
      <div class="panel">
        <h3>👑 Console promoteur</h3>
        <p>Créez des modules dans l'onglet Modules, puis laissez les enseignants créer leurs cours.</p>
      </div>
      <div class="card-grid">
        ${state.modules.map(m => `
          <div class="card">
            <h3>${m.title}</h3>
            <p>${m.description || ''}</p>
            <span class="pill">Seuil: ${m.certificate_threshold}%</span>
          </div>
        `).join('')}
      </div>
    `;
    return;
  }
  
  root.innerHTML = `
    <div class="split">
      <div>
        <div class="panel">
          <h3>➕ Créer un cours</h3>
          <form id="course-form" class="form-stack">
            <label>Module
              <select name="module_id">${state.modules.map(m => `<option value="${m.id}">${m.title}</option>`).join('')}
              </select>
            </label>
            <label>Titre <input name="title" required></label>
            <label>Description <textarea name="description"></textarea></label>
            <button class="primary" type="submit">Créer</button>
          </form>
        </div>
        <div class="panel">
          <h3>➕ Ajouter une leçon</h3>
          <form id="lesson-form" class="form-stack">
            <label>Cours
              <select name="course_id">${state.courses.map(c => `<option value="${c.id}">${c.title}</option>`).join('')}
              </select>
            </label>
            <label>Titre <input name="title" required></label>
            <label>Résumé <textarea name="summary"></textarea></label>
            <div class="form-grid">
              <label>Type
                <select name="content_type">
                  <option value="pdf">PDF</option>
                  <option value="video">Vidéo</option>
                </select>
              </label>
              <label>Position <input name="position" type="number" value="1"></label>
            </div>
            <label>Fichier <input name="content" type="file" accept=".pdf,video/*" required></label>
            <button class="primary" type="submit">Ajouter</button>
          </form>
        </div>
      </div>
      <div class="panel">
        <h3>📝 Créer évaluation</h3>
        <form id="evaluation-form" class="form-stack">
          <label>Cours
            <select name="course_id" id="eval-course">${state.courses.map(c => `<option value="${c.id}">${c.title}</option>`).join('')}
            </select>
          </label>
          <label>Leçon <select name="lesson_id" id="eval-lesson"></select></label>
          <label>Titre <input name="title" value="Quiz" required></label>
          <label>Score requis (%) <input name="pass_score" type="number" value="60"></label>
          <div id="question-list"></div>
          <button type="button" class="ghost" id="add-question">➕ Ajouter question</button>
          <button class="primary" type="submit">Enregistrer</button>
        </form>
      </div>
    </div>
  `;
  
  bindStudioForms();
}

function addQuestion() {
  const template = $('#question-template').content.cloneNode(true);
  $('#question-list').appendChild(template);
}

async function refreshLessonSelect() {
  const courseId = $('#eval-course')?.value;
  if (!courseId) return;
  const data = await api(`/api/courses/${courseId}`);
  $('#eval-lesson').innerHTML = data.lessons.map(l => `<option value="${l.id}">${l.title}</option>`).join('');
}

function bindStudioForms() {
  $('#course-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/courses', { method: 'POST', body: new FormData(e.target) });
    toast('Cours créé');
    navigate('studio');
  });
  
  $('#lesson-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const courseId = formData.get('course_id');
    await api(`/api/courses/${courseId}/lessons`, { method: 'POST', body: formData });
    toast('Leçon ajoutée');
    navigate('studio');
  });
  
  $('#add-question')?.addEventListener('click', addQuestion);
  $('#eval-course')?.addEventListener('change', refreshLessonSelect);
  addQuestion();
  refreshLessonSelect();
  
  $('#evaluation-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const questions = [...document.querySelectorAll('.question-box')].map(box => ({
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
    toast('Évaluation enregistrée');
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
    <div class="panel">
      <p class="eyebrow">${course.module_title}</p>
      <h3>${course.title}</h3>
      <p>${course.description || ''}</p>
    </div>
    <div class="split">
      <div class="lesson-list">
        ${lessons.map(lesson => `
          <div class="lesson">
            <div class="lesson-number">${lesson.position}</div>
            <div>
              <strong>${lesson.title}</strong>
              <p>${lesson.summary || lesson.content_type}</p>
              ${lesson.student_score ? `<span class="pill">Score: ${lesson.student_score}%</span>` : ''}
            </div>
            <button class="quiet" data-select-lesson="${lesson.id}">Voir</button>
          </div>
        `).join('')}
      </div>
      <div id="lesson-pane">${active ? lessonPane(active) : ''}</div>
    </div>
  `;
  
  document.querySelectorAll('[data-select-lesson]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedLesson = lessons.find(l => l.id === parseInt(btn.dataset.selectLesson));
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
    <div class="panel">
      <h3>${lesson.title}</h3>
      <div class="viewer">${media}</div>
      ${state.user.role === 'student' && lesson.evaluation_id ? 
        `<button class="primary" data-start-evaluation="${lesson.id}" style="margin-top: 16px;">📝 Passer l'évaluation</button>` : 
        '<p class="muted">Aucune évaluation disponible</p>'}
    </div>
  `;
}

function bindEvaluationButton() {
  $('[data-start-evaluation]')?.addEventListener('click', async (e) => {
    const lessonId = e.target.dataset.startEvaluation;
    const data = await api(`/api/lessons/${lessonId}/evaluation`);
    
    $('#lesson-pane').innerHTML += `
      <div class="panel" id="quiz-panel">
        <h3>${data.evaluation.title}</h3>
        <form id="quiz-form">
          ${data.questions.map(q => `
            <fieldset class="question-box">
              <legend><strong>${q.question}</strong></legend>
              <div class="choice-list">
                ${['a', 'b', 'c', 'd'].map(opt => `
                  <label>
                    <input type="radio" name="${q.id}" value="${opt.toUpperCase()}" required>
                    ${opt.toUpperCase()}. ${q[`option_${opt}`]}
                  </label>
                `).join('')}
              </div>
            </fieldset>
          `).join('')}
          <button class="primary" type="submit">Soumettre</button>
        </form>
      </div>
    `;
    
    $('#quiz-form').addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();
      const answers = Object.fromEntries(new FormData(submitEvent.target).entries());
      const result = await api(`/api/lessons/${lessonId}/submit`, {
        method: 'POST',
        body: JSON.stringify({ answers })
      });
      toast(`Score: ${result.score}% - ${result.passed ? '✅ Validé' : '❌ Non validé'}`);
      openCourse(state.selectedCourse.id);
    });
  });
}

async function renderProgress() {
  const progress = await api('/api/progress');
  root.innerHTML = `
    <div class="card-grid">
      ${progress.map(p => `
        <div class="card">
          <p class="eyebrow">${p.module_title}</p>
          <h3>${p.course_title}</h3>
          <p>${p.completed_lessons}/${p.lesson_count} leçons complétées</p>
          <div class="progress-bar"><span style="width: ${p.completion_percent}%"></span></div>
          <div class="meta-row">
            <span class="pill">📊 ${p.average_score}% de moyenne</span>
            <span class="pill">${p.completion_percent}% complété</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function renderCertificates() {
  const certificates = await api('/api/certificates');
  root.innerHTML = `
    <div class="card-grid">
      ${certificates.map(cert => `
        <div class="card">
          <p class="eyebrow">🏆 Certificat</p>
          <h3>${cert.module_title}</h3>
          <p>Délivré à ${cert.student_name}</p>
          <p><strong>Score: ${cert.average_score}%</strong></p>
          <div class="meta-row">
            <span class="pill">📜 ${cert.certificate_code}</span>
            <span class="pill">📅 ${new Date(cert.issued_at).toLocaleDateString('fr-FR')}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// Event Listeners
document.addEventListener('click', async (e) => {
  const courseBtn = e.target.closest('[data-open-course]');
  const enrollBtn = e.target.closest('[data-enroll]');
  const certBtn = e.target.closest('[data-certificate-module]');
  
  try {
    if (courseBtn) await openCourse(courseBtn.dataset.openCourse);
    if (enrollBtn) {
      await api(`/api/courses/${enrollBtn.dataset.enroll}/enroll`, { method: 'POST' });
      toast('Inscription confirmée');
      navigate('courses');
    }
    if (certBtn) {
      await api(`/api/modules/${certBtn.dataset.certificateModule}/certificate`, { method: 'POST' });
      toast('Certificat généré');
      navigate('certificates');
    }
  } catch (error) {
    toast(error.message, 'error');
  }
});

document.querySelectorAll('[data-demo]').forEach(btn => {
  btn.addEventListener('click', () => {
    $('#login-form [name=email]').value = btn.dataset.demo;
    $('#login-form [name=password]').value = 'password123';
  });
});

document.querySelectorAll('[data-auth-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const isLogin = btn.dataset.authTab === 'login';
    document.querySelectorAll('[data-auth-tab]').forEach(tab => tab.classList.toggle('active', tab === btn));
    $('#login-form').classList.toggle('hidden', !isLogin);
    $('#register-form').classList.toggle('hidden', isLogin);
  });
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(serialize(e.target))
    });
    saveSession(data);
    showApp();
  } catch (error) {
    $('#auth-message').textContent = error.message;
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(serialize(e.target))
    });
    saveSession(data);
    showApp();
  } catch (error) {
    $('#auth-message').textContent = error.message;
  }
});

document.querySelectorAll('.nav').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
});

$('#logout').addEventListener('click', logout);

// Initialisation
if (state.token && state.user) {
  showApp();
} else {
  logout();
}
