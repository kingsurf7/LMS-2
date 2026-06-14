// ==================== STATE ====================
const state = {
  token: localStorage.getItem('brain_token'),
  user: JSON.parse(localStorage.getItem('brain_user') || 'null'),
  currentView: 'overview',
  modules: [],
  courses: [],
  currentCourse: null,
  currentLesson: null,
  statistics: null
};

// ==================== DOM ELEMENTS ====================
const app = document.getElementById('app');

// ==================== UTILITIES ====================
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

async function api(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };
  
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  
  const config = {
    ...options,
    headers
  };
  
  if (options.body && !(options.body instanceof FormData)) {
    config.body = JSON.stringify(options.body);
  }
  
  const response = await fetch(endpoint, config);
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.message || 'Une erreur est survenue');
  }
  
  return data;
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function getInitials(name) {
  return name
    .split(' ')
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// ==================== AUTHENTIFICATION ====================
async function handleLogin(email, password) {
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password }
    });
    
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('brain_token', data.token);
    localStorage.setItem('brain_user', JSON.stringify(data.user));
    
    showToast('Connexion réussie !');
    renderApp();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleRegister(name, email, password, role) {
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: { name, email, password, role }
    });
    
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('brain_token', data.token);
    localStorage.setItem('brain_user', JSON.stringify(data.user));
    
    showToast('Inscription réussie !');
    renderApp();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function handleLogout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('brain_token');
  localStorage.removeItem('brain_user');
  showToast('Déconnexion réussie');
  renderApp();
}

// ==================== DATA FETCHING ====================
async function loadDashboard() {
  try {
    return await api('/api/dashboard');
  } catch (error) {
    console.error('Erreur chargement dashboard:', error);
    return { stats: { modules: 0, courses: 0, lessons: 0, certificates: 0 }, latest: [] };
  }
}

async function loadModules() {
  try {
    const modules = await api('/api/modules');
    state.modules = modules;
    return modules;
  } catch (error) {
    console.error('Erreur chargement modules:', error);
    return [];
  }
}

async function loadCourses() {
  try {
    const courses = await api('/api/courses');
    state.courses = courses;
    return courses;
  } catch (error) {
    console.error('Erreur chargement cours:', error);
    return [];
  }
}

async function loadCourseDetail(courseId) {
  try {
    return await api(`/api/courses/${courseId}`);
  } catch (error) {
    showToast(error.message, 'error');
    return null;
  }
}

async function loadEvaluation(lessonId) {
  try {
    return await api(`/api/lessons/${lessonId}/evaluation`);
  } catch (error) {
    showToast(error.message, 'error');
    return null;
  }
}

async function submitEvaluation(lessonId, answers) {
  try {
    return await api(`/api/lessons/${lessonId}/submit`, {
      method: 'POST',
      body: { answers }
    });
  } catch (error) {
    showToast(error.message, 'error');
    return null;
  }
}

async function loadProgress() {
  try {
    return await api('/api/progress');
  } catch (error) {
    console.error('Erreur chargement progression:', error);
    return [];
  }
}

async function loadCertificates() {
  try {
    return await api('/api/certificates');
  } catch (error) {
    console.error('Erreur chargement certificats:', error);
    return [];
  }
}

async function loadStatistics() {
  try {
    const stats = await api('/api/statistics');
    state.statistics = stats;
    return stats;
  } catch (error) {
    console.error('Erreur chargement statistiques:', error);
    return null;
  }
}

// ==================== ACTIONS ====================
async function createModule(title, description, level, certificateThreshold) {
  try {
    await api('/api/modules', {
      method: 'POST',
      body: { title, description, level, certificate_threshold: certificateThreshold }
    });
    showToast('Module créé avec succès');
    await loadModules();
    renderCurrentView();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function createCourse(moduleId, title, description, coverFile) {
  try {
    const formData = new FormData();
    formData.append('module_id', moduleId);
    formData.append('title', title);
    formData.append('description', description);
    if (coverFile) formData.append('cover', coverFile);
    
    const response = await fetch('/api/courses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
      body: formData
    });
    
    if (!response.ok) throw new Error('Erreur création cours');
    
    showToast('Cours créé avec succès');
    await loadCourses();
    renderCurrentView();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function enrollCourse(courseId) {
  try {
    await api(`/api/courses/${courseId}/enroll`, { method: 'POST' });
    showToast('Inscription confirmée');
    await loadCourses();
    renderCurrentView();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function createLesson(courseId, title, summary, contentType, position, file) {
  try {
    const formData = new FormData();
    formData.append('title', title);
    formData.append('summary', summary);
    formData.append('content_type', contentType);
    formData.append('position', position);
    formData.append('content', file);
    
    const response = await fetch(`/api/courses/${courseId}/lessons`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
      body: formData
    });
    
    if (!response.ok) throw new Error('Erreur création leçon');
    
    showToast('Leçon ajoutée avec succès');
    renderCurrentView();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function saveEvaluation(lessonId, title, passScore, questions) {
  try {
    await api(`/api/lessons/${lessonId}/evaluation`, {
      method: 'POST',
      body: { title, pass_score: passScore, questions }
    });
    showToast('Évaluation enregistrée avec succès');
    renderCurrentView();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function requestCertificate(moduleId) {
  try {
    await api(`/api/modules/${moduleId}/certificate`, { method: 'POST' });
    showToast('Certificat généré avec succès !');
    renderCurrentView();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ==================== RENDER FUNCTIONS ====================
function renderAuthScreen() {
  return `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-hero">
          <div class="logo">
            <div class="logo-icon">BV</div>
            <span style="font-weight: 600;">Brain Vision</span>
          </div>
          <h1>Apprenez,<br>Évaluez,<br>Certifiez.</h1>
          <p>Plateforme LMS nouvelle génération pour la formation professionnelle et académique.</p>
          <div class="demo-buttons">
            <button class="demo-btn" onclick="window.demoLogin('promoter@brain-vision.com')">👑 Promoteur</button>
            <button class="demo-btn" onclick="window.demoLogin('teacher@brain-vision.com')">👨‍🏫 Enseignant</button>
            <button class="demo-btn" onclick="window.demoLogin('student@brain-vision.com')">👨‍🎓 Étudiant</button>
          </div>
        </div>
        <div class="auth-form">
          <div class="tabs">
            <button class="tab active" onclick="window.switchAuthTab('login')">Connexion</button>
            <button class="tab" onclick="window.switchAuthTab('register')">Inscription</button>
          </div>
          <div id="login-form">
            <div class="form-group">
              <label>Email</label>
              <input type="email" id="login-email" placeholder="exemple@email.com">
            </div>
            <div class="form-group">
              <label>Mot de passe</label>
              <input type="password" id="login-password" placeholder="••••••••">
            </div>
            <button class="btn btn-primary" onclick="window.submitLogin()">Se connecter</button>
          </div>
          <div id="register-form" style="display: none;">
            <div class="form-group">
              <label>Nom complet</label>
              <input type="text" id="register-name" placeholder="Jean Dupont">
            </div>
            <div class="form-group">
              <label>Email</label>
              <input type="email" id="register-email" placeholder="exemple@email.com">
            </div>
            <div class="form-group">
              <label>Mot de passe</label>
              <input type="password" id="register-password" placeholder="6 caractères minimum">
            </div>
            <div class="form-group">
              <label>Rôle</label>
              <select id="register-role">
                <option value="student">👨‍🎓 Étudiant</option>
                <option value="teacher">👨‍🏫 Enseignant</option>
                <option value="promoter">👑 Promoteur</option>
              </select>
            </div>
            <button class="btn btn-primary" onclick="window.submitRegister()">Créer mon compte</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderAppLayout(content) {
  const roleIcons = {
    promoter: '👑',
    teacher: '👨‍🏫',
    student: '👨‍🎓'
  };
  
  const roleNames = {
    promoter: 'Promoteur',
    teacher: 'Enseignant',
    student: 'Étudiant'
  };
  
  const navItems = [
    { id: 'overview', label: 'Tableau de bord', icon: '📊', roles: ['promoter', 'teacher', 'student'] },
    { id: 'modules', label: 'Modules', icon: '📚', roles: ['promoter', 'teacher', 'student'] },
    { id: 'courses', label: 'Cours', icon: '🎓', roles: ['promoter', 'teacher', 'student'] },
    { id: 'studio', label: 'Studio', icon: '✏️', roles: ['teacher', 'promoter'] },
    { id: 'progress', label: 'Progression', icon: '📈', roles: ['student'] },
    { id: 'certificates', label: 'Certificats', icon: '🏆', roles: ['student', 'promoter'] },
    { id: 'statistics', label: 'Statistiques', icon: '📊', roles: ['promoter'] }
  ];
  
  const visibleNav = navItems.filter(item => item.roles.includes(state.user.role));
  
  return `
    <div class="app-container">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="logo">
            <div class="logo-icon">BV</div>
            <span>Brain Vision</span>
          </div>
        </div>
        <nav class="sidebar-nav">
          ${visibleNav.map(item => `
            <div class="nav-item ${state.currentView === item.id ? 'active' : ''}" onclick="window.navigateTo('${item.id}')">
              <span>${item.icon}</span>
              <span>${item.label}</span>
            </div>
          `).join('')}
        </nav>
        <div class="sidebar-footer">
          <button class="btn btn-outline" style="width: 100%;" onclick="window.handleLogout()">
            🚪 Déconnexion
          </button>
        </div>
      </aside>
      <main class="main-content">
        <div class="top-bar">
          <div>
            <div class="badge badge-info">${roleIcons[state.user.role]} ${roleNames[state.user.role]}</div>
            <h2 style="margin-top: 0.5rem;">${getPageTitle()}</h2>
          </div>
          <div class="user-info">
            <div class="user-avatar">${getInitials(state.user.name)}</div>
            <div>
              <div><strong>${state.user.name}</strong></div>
              <div style="font-size: 0.875rem; color: var(--gray);">${state.user.email}</div>
            </div>
          </div>
        </div>
        ${content}
      </main>
    </div>
  `;
}

function getPageTitle() {
  const titles = {
    overview: 'Tableau de bord',
    modules: 'Gestion des modules',
    courses: 'Catalogue des cours',
    studio: 'Studio créateur',
    progress: 'Ma progression',
    certificates: 'Mes certificats',
    statistics: 'Statistiques globales'
  };
  return titles[state.currentView] || 'Brain Vision';
}

async function renderOverview() {
  const dashboard = await loadDashboard();
  
  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-title">Modules</div>
        <div class="stat-value">${dashboard.stats.modules}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Cours</div>
        <div class="stat-value">${dashboard.stats.courses}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Leçons</div>
        <div class="stat-value">${dashboard.stats.lessons}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Certificats</div>
        <div class="stat-value">${dashboard.stats.certificates}</div>
      </div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">📖 Derniers cours</h3>
      </div>
      <div class="card-body">
        <div class="cards-grid">
          ${dashboard.latest.map(course => `
            <div class="card">
              <div class="card-header">
                <div class="badge badge-info">${course.module_title}</div>
                <h4 class="card-title">${course.title}</h4>
              </div>
              <div class="card-body">
                <p style="color: var(--gray); font-size: 0.875rem;">${course.description || 'Aucune description'}</p>
                ${course.progress !== undefined ? `
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: ${course.progress}%"></div>
                  </div>
                  <div style="font-size: 0.875rem;">Progression: ${Math.round(course.progress)}%</div>
                ` : ''}
              </div>
              <div class="card-footer">
                <button class="btn btn-primary" onclick="window.viewCourse(${course.id})">Voir le cours</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

async function renderModules() {
  const modules = await loadModules();
  const isPromoter = state.user.role === 'promoter';
  
  return `
    ${isPromoter ? `
      <div class="card" style="margin-bottom: 2rem;">
        <div class="card-header">
          <h3 class="card-title">➕ Créer un module</h3>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label>Titre du module</label>
            <input type="text" id="module-title" placeholder="Ex: Développement Web">
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea id="module-description" rows="3" placeholder="Description du module..."></textarea>
          </div>
          <div class="form-group">
            <label>Niveau</label>
            <select id="module-level">
              <option value="Débutant">Débutant</option>
              <option value="Intermédiaire">Intermédiaire</option>
              <option value="Avancé">Avancé</option>
            </select>
          </div>
          <div class="form-group">
            <label>Seuil de validation (%)</label>
            <input type="number" id="module-threshold" value="70" min="1" max="100">
          </div>
          <button class="btn btn-primary" onclick="window.createModuleFromForm()">Créer le module</button>
        </div>
      </div>
    ` : ''}
    
    <div class="cards-grid">
      ${modules.map(module => `
        <div class="card">
          <div class="card-header">
            <div class="badge ${module.level === 'Débutant' ? 'badge-success' : module.level === 'Intermédiaire' ? 'badge-warning' : 'badge-info'}">
              ${module.level || 'Débutant'}
            </div>
            <h3 class="card-title">${module.title}</h3>
          </div>
          <div class="card-body">
            <p style="color: var(--gray); margin-bottom: 1rem;">${module.description || 'Aucune description'}</p>
            <div style="display: flex; gap: 1rem; font-size: 0.875rem;">
              <span>📚 ${module.course_count || 0} cours</span>
              <span>🎯 Seuil: ${module.certificate_threshold}%</span>
              <span>🏆 ${module.certificate_count || 0} certificats</span>
            </div>
          </div>
          ${state.user.role === 'student' ? `
            <div class="card-footer">
              <button class="btn btn-primary" onclick="window.requestCertificate(${module.id})">Obtenir certificat</button>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

async function renderCourses() {
  const courses = await loadCourses();
  
  return `
    <div class="cards-grid">
      ${courses.map(course => `
        <div class="card">
          <div class="card-header">
            <div class="badge badge-info">${course.module_title}</div>
            <h3 class="card-title">${course.title}</h3>
          </div>
          <div class="card-body">
            <p style="color: var(--gray); margin-bottom: 1rem;">${course.description || 'Aucune description'}</p>
            <div style="display: flex; gap: 1rem; font-size: 0.875rem; margin-bottom: 1rem;">
              <span>📖 ${course.lesson_count || 0} leçons</span>
              <span>👨‍🏫 ${course.teacher_name || 'Enseignant'}</span>
              ${course.enrolled ? `<span class="badge badge-success">✅ Inscrit</span>` : ''}
            </div>
            ${course.my_progress !== undefined && course.my_progress > 0 ? `
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${course.my_progress}%"></div>
              </div>
              <div style="font-size: 0.875rem;">Progression: ${Math.round(course.my_progress)}%</div>
            ` : ''}
          </div>
          <div class="card-footer">
            <button class="btn btn-primary" onclick="window.viewCourse(${course.id})">Voir le cours</button>
            ${state.user.role === 'student' && !course.enrolled ? `
              <button class="btn btn-secondary" onclick="window.enrollCourse(${course.id})">S'inscrire</button>
            ` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function renderStudio() {
  if (state.user.role === 'promoter') {
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">👑 Console promoteur</h3>
        </div>
        <div class="card-body">
          <p>En tant que promoteur, vous pouvez :</p>
          <ul style="margin-top: 1rem; margin-left: 1.5rem;">
            <li>Créer des modules dans l'onglet "Modules"</li>
            <li>Les enseignants créeront leurs cours dans ces modules</li>
            <li>Consulter les statistiques globales</li>
            <li>Générer des certificats pour les étudiants</li>
          </ul>
        </div>
      </div>
    `;
  }
  
  const modules = await loadModules();
  const courses = await loadCourses();
  
  return `
    <div style="display: grid; gap: 2rem;">
      <!-- Création de cours -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">🎓 Créer un cours</h3>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label>Module</label>
            <select id="course-module">
              ${modules.map(m => `<option value="${m.id}">${m.title}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Titre du cours</label>
            <input type="text" id="course-title" placeholder="Ex: Introduction à React">
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea id="course-description" rows="3" placeholder="Description du cours..."></textarea>
          </div>
          <div class="form-group">
            <label>Image de couverture</label>
            <input type="file" id="course-cover" accept="image/*">
          </div>
          <button class="btn btn-primary" onclick="window.createCourseFromForm()">Créer le cours</button>
        </div>
      </div>
      
      <!-- Création de leçon -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📖 Ajouter une leçon</h3>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label>Cours</label>
            <select id="lesson-course">
              <option value="">Sélectionner un cours</option>
              ${courses.map(c => `<option value="${c.id}">${c.title}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Titre de la leçon</label>
            <input type="text" id="lesson-title" placeholder="Ex: Les bases de React">
          </div>
          <div class="form-group">
            <label>Résumé</label>
            <textarea id="lesson-summary" rows="2" placeholder="Résumé de la leçon..."></textarea>
          </div>
          <div class="form-group">
            <label>Type de contenu</label>
            <select id="lesson-type">
              <option value="pdf">PDF</option>
              <option value="video">Vidéo</option>
            </select>
          </div>
          <div class="form-group">
            <label>Position dans le cours</label>
            <input type="number" id="lesson-position" value="1" min="1">
          </div>
          <div class="form-group">
            <label>Fichier (PDF ou Vidéo)</label>
            <input type="file" id="lesson-file" accept=".pdf,video/*">
          </div>
          <button class="btn btn-primary" onclick="window.createLessonFromForm()">Ajouter la leçon</button>
        </div>
      </div>
      
      <!-- Création d'évaluation -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📝 Créer une évaluation</h3>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label>Cours</label>
            <select id="eval-course" onchange="window.loadLessonsForEval()">
              <option value="">Sélectionner un cours</option>
              ${courses.map(c => `<option value="${c.id}">${c.title}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Leçon</label>
            <select id="eval-lesson">
              <option value="">Sélectionner d'abord un cours</option>
            </select>
          </div>
          <div class="form-group">
            <label>Titre de l'évaluation</label>
            <input type="text" id="eval-title" placeholder="Ex: Quiz sur React">
          </div>
          <div class="form-group">
            <label>Score requis (%)</label>
            <input type="number" id="eval-pass-score" value="60" min="1" max="100">
          </div>
          <div id="questions-container"></div>
          <button class="btn btn-secondary" onclick="window.addQuestion()">➕ Ajouter une question</button>
          <button class="btn btn-primary" onclick="window.saveEvaluationFromForm()" style="margin-top: 1rem;">Enregistrer l'évaluation</button>
        </div>
      </div>
    </div>
  `;
}

async function renderProgress() {
  const progress = await loadProgress();
  
  if (progress.length === 0) {
    return `
      <div class="card">
        <div class="card-body" style="text-align: center; padding: 3rem;">
          <p>Vous n'êtes inscrit à aucun cours pour le moment.</p>
          <button class="btn btn-primary" onclick="window.navigateTo('courses')" style="margin-top: 1rem;">Parcourir les cours</button>
        </div>
      </div>
    `;
  }
  
  return `
    <div class="cards-grid">
      ${progress.map(item => `
        <div class="card">
          <div class="card-header">
            <div class="badge badge-info">${item.module_title}</div>
            <h3 class="card-title">${item.course_title}</h3>
          </div>
          <div class="card-body">
            <div style="margin-bottom: 1rem;">
              <div>Leçons complétées: ${item.completed_lessons}/${item.lesson_count}</div>
              <div>Moyenne: ${item.average_score}%</div>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${item.progress}%"></div>
            </div>
            <div style="margin-top: 0.5rem; font-size: 0.875rem;">Progression globale: ${Math.round(item.progress)}%</div>
            ${item.module_progress ? `
              <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--light);">
                <div>Progression du module: ${Math.round(item.module_progress)}%</div>
                <div class="progress-bar" style="margin-top: 0.5rem;">
                  <div class="progress-fill" style="width: ${item.module_progress}%"></div>
                </div>
              </div>
            ` : ''}
          </div>
          <div class="card-footer">
            <button class="btn btn-primary" onclick="window.viewCourse(${item.course_id})">Continuer</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function renderCertificates() {
  const certificates = await loadCertificates();
  
  if (certificates.length === 0) {
    return `
      <div class="card">
        <div class="card-body" style="text-align: center; padding: 3rem;">
          <p>Aucun certificat obtenu pour le moment.</p>
          <p style="font-size: 0.875rem; margin-top: 0.5rem;">Complétez un module avec un score suffisant pour obtenir un certificat.</p>
        </div>
      </div>
    `;
  }
  
  return `
    <div class="cards-grid">
      ${certificates.map(cert => `
        <div class="card">
          <div class="card-header">
            <div class="badge badge-success">🏆 Certificat officiel</div>
            <h3 class="card-title">${cert.module_title}</h3>
          </div>
          <div class="card-body">
            <p><strong>${cert.student_name}</strong></p>
            <p>Niveau: ${cert.level || 'Débutant'}</p>
            <p>Score obtenu: ${cert.average_score}%</p>
            <p>Seuil requis: ${cert.certificate_threshold}%</p>
            <div style="margin-top: 1rem; padding: 1rem; background: var(--light); border-radius: var(--radius);">
              <code>${cert.certificate_code}</code>
            </div>
            <p style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--gray);">Délivré le ${formatDate(cert.issued_at)}</p>
          </div>
          <div class="card-footer">
            <button class="btn btn-outline" onclick="window.print()">🖨️ Imprimer</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function renderStatistics() {
  const stats = await loadStatistics();
  
  if (!stats) return '<div class="card"><div class="card-body">Chargement...</div></div>';
  
  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-title">Étudiants</div>
        <div class="stat-value">${stats.overview.total_students}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Enseignants</div>
        <div class="stat-value">${stats.overview.total_teachers}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Modules</div>
        <div class="stat-value">${stats.overview.total_modules}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Cours</div>
        <div class="stat-value">${stats.overview.total_courses}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Leçons</div>
        <div class="stat-value">${stats.overview.total_lessons}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Certificats</div>
        <div class="stat-value">${stats.overview.total_certificates}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Progression moyenne</div>
        <div class="stat-value">${stats.overview.avg_progress || 0}%</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Évaluations réussies</div>
        <div class="stat-value">${stats.overview.passed_evaluations}</div>
      </div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🏆 Top modules - Certificats délivrés</h3>
      </div>
      <div class="card-body">
        ${stats.topModules.map(module => `
          <div style="margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
              <span>${module.title}</span>
              <span>${module.certificates_issued || 0} certificats</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${Math.min(100, (module.certificates_issued || 0) * 10)}%"></div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

async function renderCourseDetail(courseId) {
  const data = await loadCourseDetail(courseId);
  if (!data) return '<div class="card"><div class="card-body">Cours introuvable</div></div>';
  
  state.currentCourse = data.course;
  
  return `
    <div class="card" style="margin-bottom: 2rem;">
      <div class="card-header">
        <div class="badge badge-info">${data.course.module_title}</div>
        <h2 class="card-title">${data.course.title}</h2>
        <p style="color: var(--gray);">${data.course.description || 'Aucune description'}</p>
        ${data.course.my_progress !== undefined && data.course.my_progress > 0 ? `
          <div style="margin-top: 1rem;">
            <div>Progression: ${Math.round(data.course.my_progress)}%</div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${data.course.my_progress}%"></div>
            </div>
          </div>
        ` : ''}
      </div>
    </div>
    
    <div style="display: grid; grid-template-columns: 320px 1fr; gap: 2rem;">
      <div class="lesson-list">
        ${data.lessons.map((lesson, index) => `
          <div class="lesson-item" onclick="window.viewLesson(${courseId}, ${lesson.id})">
            <div class="lesson-number">${index + 1}</div>
            <div class="lesson-content">
              <div class="lesson-title">${lesson.title}</div>
              <div class="lesson-meta">
                ${lesson.content_type === 'pdf' ? '📄 PDF' : '🎥 Vidéo'}
                ${lesson.is_validated ? ' ✅ Validé' : lesson.student_score ? ` 📊 ${lesson.student_score}%` : ''}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
      <div id="lesson-viewer">
        ${state.currentLesson ? await renderLessonViewer(courseId, state.currentLesson) : `
          <div class="card">
            <div class="card-body" style="text-align: center; padding: 3rem;">
              <p>Sélectionnez une leçon pour commencer</p>
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}

async function renderLessonViewer(courseId, lessonId) {
  const data = await loadCourseDetail(courseId);
  const lesson = data.lessons.find(l => l.id === lessonId);
  if (!lesson) return '<div class="card"><div class="card-body">Leçon introuvable</div></div>';
  
  let content = '';
  if (lesson.content_type === 'pdf') {
    content = `<iframe src="${lesson.content_url}" style="width: 100%; height: 500px; border: none; border-radius: var(--radius);"></iframe>`;
  } else {
    content = `<video src="${lesson.content_url}" controls style="width: 100%; border-radius: var(--radius);"></video>`;
  }
  
  return `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">${lesson.title}</h3>
        <p style="color: var(--gray);">${lesson.summary || ''}</p>
      </div>
      <div class="card-body">
        ${content}
      </div>
      ${lesson.evaluation_id && state.user.role === 'student' && !lesson.is_validated ? `
        <div class="card-footer">
          <button class="btn btn-primary" onclick="window.startEvaluation(${courseId}, ${lesson.id})">📝 Passer l'évaluation</button>
        </div>
      ` : lesson.is_validated ? `
        <div class="card-footer">
          <div class="badge badge-success">✅ Leçon validée - Score: ${lesson.student_score}%</div>
        </div>
      ` : ''}
    </div>
  `;
}

async function renderEvaluation(courseId, lessonId) {
  const evaluation = await loadEvaluation(lessonId);
  if (!evaluation) return '<div class="card"><div class="card-body">Évaluation introuvable</div></div>';
  
  if (evaluation.hasSubmitted) {
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">${evaluation.evaluation.title}</h3>
        </div>
        <div class="card-body" style="text-align: center;">
          <p>Vous avez déjà complété cette évaluation.</p>
          <p style="margin-top: 0.5rem;">Votre score: <strong>${evaluation.previousScore}%</strong></p>
          <button class="btn btn-primary" onclick="window.viewCourse(${courseId})" style="margin-top: 1rem;">Retour au cours</button>
        </div>
      </div>
    `;
  }
  
  return `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">${evaluation.evaluation.title}</h3>
        <p>Score requis: ${evaluation.evaluation.pass_score}%</p>
      </div>
      <div class="card-body" id="evaluation-questions">
        ${evaluation.questions.map((q, idx) => `
          <div class="question-box" data-question-id="${q.id}">
            <div class="question-text">${idx + 1}. ${q.question}</div>
            <div class="options-list">
              ${['A', 'B', 'C', 'D'].map(letter => `
                <label class="option-item">
                  <input type="radio" name="q_${q.id}" value="${letter}">
                  <span><strong>${letter}.</strong> ${q[`option_${letter.toLowerCase()}`]}</span>
                </label>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" onclick="window.submitEvaluationFromForm(${courseId}, ${lessonId})">Soumettre mes réponses</button>
      </div>
    </div>
  `;
}

// ==================== NAVIGATION ====================
async function navigateTo(view) {
  state.currentView = view;
  await renderCurrentView();
}

async function viewCourse(courseId) {
  state.currentView = 'course_detail';
  state.currentCourse = { id: courseId };
  state.currentLesson = null;
  await renderCurrentView();
}

async function viewLesson(courseId, lessonId) {
  state.currentLesson = lessonId;
  await renderCurrentView();
}

async function startEvaluation(courseId, lessonId) {
  state.currentView = 'evaluation';
  state.currentCourse = { id: courseId };
  state.currentLesson = lessonId;
  await renderCurrentView();
}

async function renderCurrentView() {
  if (!state.user) {
    app.innerHTML = renderAuthScreen();
    return;
  }
  
  let content = '';
  
  switch (state.currentView) {
    case 'overview':
      content = await renderOverview();
      break;
    case 'modules':
      content = await renderModules();
      break;
    case 'courses':
      content = await renderCourses();
      break;
    case 'studio':
      content = await renderStudio();
      break;
    case 'progress':
      content = await renderProgress();
      break;
    case 'certificates':
      content = await renderCertificates();
      break;
    case 'statistics':
      content = await renderStatistics();
      break;
    case 'course_detail':
      content = await renderCourseDetail(state.currentCourse.id);
      break;
    case 'evaluation':
      content = await renderEvaluation(state.currentCourse.id, state.currentLesson);
      break;
    default:
      content = await renderOverview();
  }
  
  app.innerHTML = renderAppLayout(content);
}

// ==================== FORM HANDLERS ====================
window.demoLogin = (email) => {
  document.getElementById('login-email').value = email;
  document.getElementById('login-password').value = 'password123';
};

window.switchAuthTab = (tab) => {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const tabs = document.querySelectorAll('.tab');
  
  if (tab === 'login') {
    loginForm.style.display = 'block';
    registerForm.style.display = 'none';
    tabs[0].classList.add('active');
    tabs[1].classList.remove('active');
  } else {
    loginForm.style.display = 'none';
    registerForm.style.display = 'block';
    tabs[0].classList.remove('active');
    tabs[1].classList.add('active');
  }
};

window.submitLogin = () => {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  handleLogin(email, password);
};

window.submitRegister = () => {
  const name = document.getElementById('register-name').value;
  const email = document.getElementById('register-email').value;
  const password = document.getElementById('register-password').value;
  const role = document.getElementById('register-role').value;
  handleRegister(name, email, password, role);
};

window.handleLogout = handleLogout;
window.navigateTo = navigateTo;
window.viewCourse = viewCourse;
window.viewLesson = viewLesson;
window.startEvaluation = startEvaluation;
window.enrollCourse = enrollCourse;
window.requestCertificate = requestCertificate;

window.createModuleFromForm = () => {
  const title = document.getElementById('module-title').value;
  const description = document.getElementById('module-description').value;
  const level = document.getElementById('module-level').value;
  const threshold = document.getElementById('module-threshold').value;
  if (title) createModule(title, description, level, parseInt(threshold));
  else showToast('Veuillez saisir un titre', 'error');
};

window.createCourseFromForm = () => {
  const moduleId = document.getElementById('course-module').value;
  const title = document.getElementById('course-title').value;
  const description = document.getElementById('course-description').value;
  const coverFile = document.getElementById('course-cover').files[0];
  if (title && moduleId) createCourse(moduleId, title, description, coverFile);
  else showToast('Veuillez remplir tous les champs', 'error');
};

window.createLessonFromForm = () => {
  const courseId = document.getElementById('lesson-course').value;
  const title = document.getElementById('lesson-title').value;
  const summary = document.getElementById('lesson-summary').value;
  const contentType = document.getElementById('lesson-type').value;
  const position = document.getElementById('lesson-position').value;
  const file = document.getElementById('lesson-file').files[0];
  if (courseId && title && file) createLesson(courseId, title, summary, contentType, parseInt(position), file);
  else showToast('Veuillez remplir tous les champs', 'error');
};

window.loadLessonsForEval = async () => {
  const courseId = document.getElementById('eval-course').value;
  if (!courseId) return;
  
  const data = await loadCourseDetail(courseId);
  const lessonSelect = document.getElementById('eval-lesson');
  lessonSelect.innerHTML = '<option value="">Sélectionner une leçon</option>' + 
    data.lessons.map(l => `<option value="${l.id}">${l.title}</option>`).join('');
};

let questionCounter = 0;

window.addQuestion = () => {
  questionCounter++;
  const container = document.getElementById('questions-container');
  const questionDiv = document.createElement('div');
  questionDiv.className = 'question-box';
  questionDiv.id = `question-${questionCounter}`;
  questionDiv.innerHTML = `
    <button class="btn btn-danger" style="float: right; padding: 0.25rem 0.5rem;" onclick="window.removeQuestion(${questionCounter})">✖</button>
    <div class="form-group">
      <label>Question</label>
      <textarea id="q-${questionCounter}-text" rows="2" placeholder="Votre question..."></textarea>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
      <div class="form-group"><label>Option A</label><input type="text" id="q-${questionCounter}-a" placeholder="Option A"></div>
      <div class="form-group"><label>Option B</label><input type="text" id="q-${questionCounter}-b" placeholder="Option B"></div>
      <div class="form-group"><label>Option C</label><input type="text" id="q-${questionCounter}-c" placeholder="Option C"></div>
      <div class="form-group"><label>Option D</label><input type="text" id="q-${questionCounter}-d" placeholder="Option D"></div>
    </div>
    <div class="form-group">
      <label>Bonne réponse</label>
      <select id="q-${questionCounter}-correct">
        <option value="A">A</option>
        <option value="B">B</option>
        <option value="C">C</option>
        <option value="D">D</option>
      </select>
    </div>
  `;
  container.appendChild(questionDiv);
};

window.removeQuestion = (id) => {
  const questionDiv = document.getElementById(`question-${id}`);
  if (questionDiv) questionDiv.remove();
};

window.saveEvaluationFromForm = async () => {
  const lessonId = document.getElementById('eval-lesson').value;
  const title = document.getElementById('eval-title').value;
  const passScore = document.getElementById('eval-pass-score').value;
  
  if (!lessonId || !title) {
    showToast('Veuillez sélectionner une leçon et saisir un titre', 'error');
    return;
  }
  
  const questions = [];
  for (let i = 1; i <= questionCounter; i++) {
    const questionDiv = document.getElementById(`question-${i}`);
    if (questionDiv) {
      const questionText = document.getElementById(`q-${i}-text`)?.value;
      if (questionText) {
        questions.push({
          question: questionText,
          option_a: document.getElementById(`q-${i}-a`).value,
          option_b: document.getElementById(`q-${i}-b`).value,
          option_c: document.getElementById(`q-${i}-c`).value,
          option_d: document.getElementById(`q-${i}-d`).value,
          correct_option: document.getElementById(`q-${i}-correct`).value
        });
      }
    }
  }
  
  if (questions.length === 0) {
    showToast('Ajoutez au moins une question', 'error');
    return;
  }
  
  await saveEvaluation(lessonId, title, parseInt(passScore), questions);
};

window.submitEvaluationFromForm = async (courseId, lessonId) => {
  const answers = {};
  const questions = document.querySelectorAll('.question-box');
  
  for (const question of questions) {
    const questionId = question.dataset.questionId;
    const selected = question.querySelector(`input[name="q_${questionId}"]:checked`);
    if (selected) {
      answers[questionId] = selected.value;
    }
  }
  
  const result = await submitEvaluation(lessonId, answers);
  if (result) {
    showToast(result.message, result.passed ? 'success' : 'error');
    await viewCourse(courseId);
  }
};

// ==================== INITIALISATION ====================
renderApp();

async function renderApp() {
  if (state.token && state.user) {
    await renderCurrentView();
  } else {
    app.innerHTML = renderAuthScreen();
  }
}
