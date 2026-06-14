require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

const hasCloudinary = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

if (hasCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

const dbConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'lumina_lms'
    };

const useSsl =
  process.env.DB_SSL === 'true' ||
  (process.env.DATABASE_URL || '').includes('sslmode=require') ||
  (process.env.NODE_ENV === 'production' && Boolean(process.env.DATABASE_URL));

const pool = new Pool({
  ...dbConfig,
  max: 10,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, originalHash] = String(stored).split(':');
  if (!salt || !originalHash) return false;
  const testHash = hashPassword(password, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), Buffer.from(testHash, 'hex'));
}

function signUser(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function auth(requiredRoles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Connexion requise.' });

    try {
      req.user = jwt.verify(token, JWT_SECRET);
      if (requiredRoles.length && !requiredRoles.includes(req.user.role)) {
        return res.status(403).json({ message: 'Accès refusé pour ce rôle.' });
      }
      next();
    } catch {
      res.status(401).json({ message: 'Session invalide ou expirée.' });
    }
  };
}

function prepareSql(sql, params = {}) {
  const values = [];
  const indexes = new Map();
  const text = sql.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, key) => {
    if (!indexes.has(key)) {
      indexes.set(key, values.length + 1);
      values.push(params[key]);
    }
    return `$${indexes.get(key)}`;
  });
  return { text, values };
}

async function query(sql, params = {}) {
  const prepared = prepareSql(sql, params);
  const result = await pool.query(prepared.text, prepared.values);
  return result.rows;
}

async function uploadAsset(file, type) {
  if (!file) throw new Error('Fichier manquant.');
  if (hasCloudinary) {
    const folder = process.env.CLOUDINARY_FOLDER || 'lumina-lms';
    const resourceType = type === 'video' ? 'video' : 'raw';
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: resourceType, use_filename: true },
        (error, value) => (error ? reject(error) : resolve(value))
      );
      stream.end(file.buffer);
    });
    return { url: result.secure_url, publicId: result.public_id };
  }

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '-');
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), file.buffer);
  return { url: `/uploads/${filename}`, publicId: filename };
}

async function seedDemo() {
  if (process.env.AUTO_SEED !== 'true') return;
  const countRows = await query('SELECT COUNT(*) AS count FROM users');
  if (countRows[0].count > 0) return;

  const promoterHash = hashPassword('password123');
  const teacherHash = hashPassword('password123');
  const studentHash = hashPassword('password123');
  const demoUsers = await query(
    `INSERT INTO users (name, email, password_hash, role) VALUES
      ('Amina Promoteur', 'promoter@lumina.test', :promoterHash, 'promoter'),
      ('Nicolas Enseignant', 'teacher@lumina.test', :teacherHash, 'teacher'),
      ('Grace Etudiante', 'student@lumina.test', :studentHash, 'student')
     RETURNING id, role`,
    { promoterHash, teacherHash, studentHash }
  );
  const promoterId = demoUsers.find((user) => user.role === 'promoter').id;
  const teacherId = demoUsers.find((user) => user.role === 'teacher').id;

  const [module] = await query(
    `INSERT INTO modules (title, description, level, certificate_threshold, created_by)
     VALUES ('Fondamentaux du Web', 'HTML, CSS, JavaScript et bases de l’expérience utilisateur.', 'Débutant', 70, :promoterId)
     RETURNING id`,
    { promoterId }
  );
  const [course] = await query(
    `INSERT INTO courses (module_id, teacher_id, title, description, cover_url)
     VALUES (:moduleId, :teacherId, 'Créer une interface LMS moderne', 'Un cours guidé pour structurer des pages pédagogiques claires.', '')
     RETURNING id`,
    { moduleId: module.id, teacherId }
  );
  const lessons = await query(
    `INSERT INTO lessons (course_id, title, summary, content_type, content_url, position, duration_minutes)
     VALUES
      (:courseId, 'Architecture d’une page de cours', 'Comprendre la navigation, les modules et la progression.', 'pdf', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', 1, 12),
      (:courseId, 'Interactions JavaScript utiles', 'Créer une expérience fluide pour l’apprenant.', 'video', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 2, 18)
     RETURNING id, position`,
    { courseId: course.id }
  );
  const firstLessonId = lessons.find((lesson) => lesson.position === 1).id;
  const secondLessonId = lessons.find((lesson) => lesson.position === 2).id;
  const evaluations = await query(
    `INSERT INTO evaluations (lesson_id, title, pass_score) VALUES
      (:firstLessonId, 'Quiz: structure LMS', 60),
      (:secondLessonId, 'Quiz: interactions', 60)
     RETURNING id, title`,
    { firstLessonId, secondLessonId }
  );
  const structureEvaluationId = evaluations.find((evaluation) => evaluation.title.includes('structure')).id;
  const interactionEvaluationId = evaluations.find((evaluation) => evaluation.title.includes('interactions')).id;
  await query(
    `INSERT INTO questions (evaluation_id, question, option_a, option_b, option_c, option_d, correct_option, points) VALUES
      (:structureEvaluationId, 'Quel élément aide le plus à organiser un cours LMS ?', 'Une couleur unique', 'Des modules et leçons', 'Une image décorative', 'Un long paragraphe', 'B', 1),
      (:structureEvaluationId, 'La progression d’un étudiant doit être liée à...', 'Sa note aux évaluations', 'Son navigateur', 'Son email uniquement', 'La taille du fichier', 'A', 1),
      (:interactionEvaluationId, 'JavaScript sert ici principalement à...', 'Rendre les pages interactives', 'Remplacer PostgreSQL', 'Compresser les vidéos', 'Créer le serveur DNS', 'A', 1),
      (:interactionEvaluationId, 'Une bonne interface étudiant doit montrer...', 'La progression et les prochaines leçons', 'Seulement le logo', 'Le code source', 'Les mots de passe', 'A', 1)`,
    { structureEvaluationId, interactionEvaluationId }
  );
}

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;
  const allowedRoles = ['promoter', 'teacher', 'student'];
  if (!name || !email || !password || !allowedRoles.includes(role)) {
    return res.status(400).json({ message: 'Nom, email, mot de passe et rôle sont requis.' });
  }
  const passwordHash = hashPassword(password);
  await query(
    'INSERT INTO users (name, email, password_hash, role) VALUES (:name, :email, :passwordHash, :role)',
    { name, email, passwordHash, role }
  );
  const rows = await query('SELECT id, name, email, role FROM users WHERE email = :email', { email });
  res.status(201).json({ user: rows[0], token: signUser(rows[0]) });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const rows = await query('SELECT * FROM users WHERE email = :email', { email });
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ message: 'Identifiants incorrects.' });
  }
  delete user.password_hash;
  res.json({ user, token: signUser(user) });
}));

app.get('/api/me', auth(), asyncHandler(async (req, res) => {
  const rows = await query('SELECT id, name, email, role, avatar_url FROM users WHERE id = :id', { id: req.user.id });
  res.json(rows[0]);
}));

app.get('/api/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, storage: hasCloudinary ? 'cloudinary' : 'local' });
}));

app.get('/api/dashboard', auth(), asyncHandler(async (req, res) => {
  const [modulesCount] = await query('SELECT COUNT(*) AS count FROM modules');
  const [coursesCount] = await query('SELECT COUNT(*) AS count FROM courses');
  const [lessonsCount] = await query('SELECT COUNT(*) AS count FROM lessons');
  const [certificatesCount] = await query('SELECT COUNT(*) AS count FROM certificates');
  const latest = await query(
    `SELECT c.id, c.title, c.description, m.title AS module_title, u.name AS teacher_name,
      COUNT(l.id) AS lesson_count
     FROM courses c
     JOIN modules m ON m.id = c.module_id
     LEFT JOIN users u ON u.id = c.teacher_id
     LEFT JOIN lessons l ON l.course_id = c.id
     GROUP BY c.id, m.title, u.name
     ORDER BY c.created_at DESC
     LIMIT 6`
  );
  res.json({
    stats: {
      modules: modulesCount.count,
      courses: coursesCount.count,
      lessons: lessonsCount.count,
      certificates: certificatesCount.count
    },
    latest
  });
}));

app.get('/api/modules', auth(), asyncHandler(async (req, res) => {
  const modules = await query(
    `SELECT m.*, COUNT(DISTINCT c.id) AS course_count, COUNT(DISTINCT cert.id) AS certificate_count
     FROM modules m
     LEFT JOIN courses c ON c.module_id = m.id
     LEFT JOIN certificates cert ON cert.module_id = m.id
     GROUP BY m.id
     ORDER BY m.created_at DESC`
  );
  res.json(modules);
}));

app.post('/api/modules', auth(['promoter']), asyncHandler(async (req, res) => {
  const { title, description, level, certificate_threshold } = req.body;
  await query(
    `INSERT INTO modules (title, description, level, certificate_threshold, created_by)
     VALUES (:title, :description, :level, :threshold, :createdBy)`,
    {
      title,
      description: description || '',
      level: level || 'Débutant',
      threshold: Number(certificate_threshold) || 70,
      createdBy: req.user.id
    }
  );
  res.status(201).json({ message: 'Module créé.' });
}));

app.get('/api/courses', auth(), asyncHandler(async (req, res) => {
  const courses = await query(
    `SELECT c.*, m.title AS module_title, u.name AS teacher_name,
      COUNT(DISTINCT l.id) AS lesson_count,
      EXISTS(SELECT 1 FROM enrollments e WHERE e.course_id = c.id AND e.user_id = :userId) AS enrolled
     FROM courses c
     JOIN modules m ON m.id = c.module_id
     LEFT JOIN users u ON u.id = c.teacher_id
     LEFT JOIN lessons l ON l.course_id = c.id
     WHERE (:teacherOnly = 0 OR c.teacher_id = :userId)
     GROUP BY c.id, m.title, u.name
     ORDER BY c.created_at DESC`,
    { userId: req.user.id, teacherOnly: req.user.role === 'teacher' ? 1 : 0 }
  );
  res.json(courses);
}));

app.post('/api/courses', auth(['teacher']), upload.single('cover'), asyncHandler(async (req, res) => {
  const { module_id, title, description } = req.body;
  let coverUrl = '';
  if (req.file) coverUrl = (await uploadAsset(req.file, 'image')).url;
  await query(
    `INSERT INTO courses (module_id, teacher_id, title, description, cover_url)
     VALUES (:moduleId, :teacherId, :title, :description, :coverUrl)`,
    { moduleId: module_id, teacherId: req.user.id, title, description: description || '', coverUrl }
  );
  res.status(201).json({ message: 'Cours créé.' });
}));

app.post('/api/courses/:id/enroll', auth(['student']), asyncHandler(async (req, res) => {
  await query('INSERT INTO enrollments (user_id, course_id) VALUES (:userId, :courseId) ON CONFLICT (user_id, course_id) DO NOTHING', {
    userId: req.user.id,
    courseId: req.params.id
  });
  res.json({ message: 'Inscription confirmée.' });
}));

app.get('/api/courses/:id', auth(), asyncHandler(async (req, res) => {
  const courseRows = await query(
    `SELECT c.*, m.title AS module_title, m.certificate_threshold, u.name AS teacher_name
     FROM courses c
     JOIN modules m ON m.id = c.module_id
     LEFT JOIN users u ON u.id = c.teacher_id
     WHERE c.id = :id`,
    { id: req.params.id }
  );
  const course = courseRows[0];
  if (!course) return res.status(404).json({ message: 'Cours introuvable.' });
  const lessons = await query(
    `SELECT l.*, e.id AS evaluation_id, e.title AS evaluation_title, e.pass_score,
      s.score AS student_score, s.submitted_at
     FROM lessons l
     LEFT JOIN evaluations e ON e.lesson_id = l.id
     LEFT JOIN submissions s ON s.lesson_id = l.id AND s.user_id = :userId
     WHERE l.course_id = :courseId
     ORDER BY l.position ASC`,
    { courseId: req.params.id, userId: req.user.id }
  );
  res.json({ course, lessons });
}));

app.post('/api/courses/:id/lessons', auth(['teacher']), upload.single('content'), asyncHandler(async (req, res) => {
  const { title, summary, content_type, position, duration_minutes } = req.body;
  const ownership = await query('SELECT id FROM courses WHERE id = :id AND teacher_id = :teacherId', {
    id: req.params.id,
    teacherId: req.user.id
  });
  if (!ownership.length) return res.status(403).json({ message: 'Ce cours ne vous appartient pas.' });
  if (!['pdf', 'video'].includes(content_type)) return res.status(400).json({ message: 'Type de leçon invalide.' });

  const asset = await uploadAsset(req.file, content_type);
  await query(
    `INSERT INTO lessons (course_id, title, summary, content_type, content_url, public_id, position, duration_minutes)
     VALUES (:courseId, :title, :summary, :contentType, :contentUrl, :publicId, :position, :duration)`,
    {
      courseId: req.params.id,
      title,
      summary: summary || '',
      contentType: content_type,
      contentUrl: asset.url,
      publicId: asset.publicId,
      position: Number(position) || 1,
      duration: Number(duration_minutes) || 10
    }
  );
  res.status(201).json({ message: 'Leçon ajoutée.' });
}));

app.post('/api/lessons/:id/evaluation', auth(['teacher']), asyncHandler(async (req, res) => {
  const { title, pass_score, questions } = req.body;
  const ownership = await query(
    `SELECT l.id FROM lessons l JOIN courses c ON c.id = l.course_id
     WHERE l.id = :lessonId AND c.teacher_id = :teacherId`,
    { lessonId: req.params.id, teacherId: req.user.id }
  );
  if (!ownership.length) return res.status(403).json({ message: 'Leçon non autorisée.' });
  if (!Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ message: 'Ajoutez au moins une question.' });
  }

  await query(
    `INSERT INTO evaluations (lesson_id, title, pass_score)
     VALUES (:lessonId, :title, :passScore)
     ON CONFLICT (lesson_id) DO UPDATE SET title = EXCLUDED.title, pass_score = EXCLUDED.pass_score`,
    { lessonId: req.params.id, title, passScore: Number(pass_score) || 60 }
  );
  const [evaluation] = await query('SELECT id FROM evaluations WHERE lesson_id = :lessonId', { lessonId: req.params.id });
  await query('DELETE FROM questions WHERE evaluation_id = :evaluationId', { evaluationId: evaluation.id });

  for (const item of questions) {
    await query(
      `INSERT INTO questions
       (evaluation_id, question, option_a, option_b, option_c, option_d, correct_option, points)
       VALUES (:evaluationId, :question, :a, :b, :c, :d, :correct, :points)`,
      {
        evaluationId: evaluation.id,
        question: item.question,
        a: item.option_a,
        b: item.option_b,
        c: item.option_c,
        d: item.option_d,
        correct: item.correct_option,
        points: Number(item.points) || 1
      }
    );
  }
  res.status(201).json({ message: 'Evaluation enregistrée.' });
}));

app.get('/api/lessons/:id/evaluation', auth(), asyncHandler(async (req, res) => {
  const [evaluation] = await query('SELECT * FROM evaluations WHERE lesson_id = :lessonId', { lessonId: req.params.id });
  if (!evaluation) return res.status(404).json({ message: 'Aucune évaluation.' });
  const questions = await query(
    `SELECT id, question, option_a, option_b, option_c, option_d, points
     FROM questions WHERE evaluation_id = :evaluationId ORDER BY id ASC`,
    { evaluationId: evaluation.id }
  );
  res.json({ evaluation, questions });
}));

app.post('/api/lessons/:id/submit', auth(['student']), asyncHandler(async (req, res) => {
  const { answers } = req.body;
  const [evaluation] = await query('SELECT * FROM evaluations WHERE lesson_id = :lessonId', { lessonId: req.params.id });
  if (!evaluation) return res.status(404).json({ message: 'Aucune évaluation disponible.' });
  const questions = await query('SELECT * FROM questions WHERE evaluation_id = :evaluationId', { evaluationId: evaluation.id });
  const total = questions.reduce((sum, q) => sum + Number(q.points), 0);
  const earned = questions.reduce((sum, q) => {
    return sum + (answers?.[q.id] === q.correct_option ? Number(q.points) : 0);
  }, 0);
  const score = total ? Math.round((earned / total) * 100) : 0;

  await query(
    `INSERT INTO submissions (user_id, lesson_id, evaluation_id, score, answers)
     VALUES (:userId, :lessonId, :evaluationId, :score, :answers::jsonb)
     ON CONFLICT (user_id, lesson_id)
     DO UPDATE SET score = EXCLUDED.score, answers = EXCLUDED.answers, submitted_at = CURRENT_TIMESTAMP`,
    {
      userId: req.user.id,
      lessonId: req.params.id,
      evaluationId: evaluation.id,
      score,
      answers: JSON.stringify(answers || {})
    }
  );
  res.json({ score, passed: score >= evaluation.pass_score });
}));

app.get('/api/progress', auth(['student']), asyncHandler(async (req, res) => {
  const progress = await query(
    `SELECT c.id AS course_id, c.title AS course_title, m.id AS module_id, m.title AS module_title,
      COUNT(l.id) AS lesson_count,
      COUNT(s.id) AS completed_lessons,
      COALESCE(ROUND(AVG(s.score), 2), 0) AS average_score,
      COALESCE(ROUND(COUNT(s.id)::numeric / NULLIF(COUNT(l.id), 0) * 100, 2), 0) AS completion_percent
     FROM enrollments en
     JOIN courses c ON c.id = en.course_id
     JOIN modules m ON m.id = c.module_id
     LEFT JOIN lessons l ON l.course_id = c.id
     LEFT JOIN submissions s ON s.lesson_id = l.id AND s.user_id = en.user_id
     WHERE en.user_id = :userId
     GROUP BY c.id, m.id
     ORDER BY en.created_at DESC`,
    { userId: req.user.id }
  );
  res.json(progress);
}));

app.post('/api/modules/:id/certificate', auth(['student']), asyncHandler(async (req, res) => {
  const moduleId = req.params.id;
  const [module] = await query('SELECT * FROM modules WHERE id = :moduleId', { moduleId });
  if (!module) return res.status(404).json({ message: 'Module introuvable.' });
  const [result] = await query(
    `SELECT COUNT(DISTINCT l.id) AS lesson_count,
      COUNT(DISTINCT s.lesson_id) AS completed_lessons,
      COALESCE(ROUND(AVG(s.score), 2), 0) AS average_score
     FROM courses c
     JOIN lessons l ON l.course_id = c.id
     LEFT JOIN submissions s ON s.lesson_id = l.id AND s.user_id = :userId
     WHERE c.module_id = :moduleId`,
    { userId: req.user.id, moduleId }
  );
  if (!result.lesson_count || result.completed_lessons < result.lesson_count || result.average_score < module.certificate_threshold) {
    return res.status(400).json({ message: 'Module pas encore validé.' });
  }

  const code = `LUM-${moduleId}-${req.user.id}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  await query(
    `INSERT INTO certificates (user_id, module_id, certificate_code, average_score)
     VALUES (:userId, :moduleId, :code, :average)
     ON CONFLICT (user_id, module_id) DO UPDATE SET average_score = EXCLUDED.average_score`,
    { userId: req.user.id, moduleId, code, average: result.average_score }
  );
  const [certificate] = await query(
    `SELECT cert.*, m.title AS module_title, u.name AS student_name
     FROM certificates cert
     JOIN modules m ON m.id = cert.module_id
     JOIN users u ON u.id = cert.user_id
     WHERE cert.user_id = :userId AND cert.module_id = :moduleId`,
    { userId: req.user.id, moduleId }
  );
  res.json(certificate);
}));

app.get('/api/certificates', auth(), asyncHandler(async (req, res) => {
  const onlyMine = req.user.role === 'student';
  const certificates = await query(
    `SELECT cert.*, m.title AS module_title, u.name AS student_name
     FROM certificates cert
     JOIN modules m ON m.id = cert.module_id
     JOIN users u ON u.id = cert.user_id
     WHERE (:onlyMine = 0 OR cert.user_id = :userId)
     ORDER BY cert.issued_at DESC`,
    { onlyMine: onlyMine ? 1 : 0, userId: req.user.id }
  );
  res.json(certificates);
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === '23505') return res.status(409).json({ message: 'Cette donnée existe déjà.' });
  res.status(500).json({ message: err.message || 'Erreur serveur.' });
});

async function start() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await pool.query('SELECT 1');
  await seedDemo();
  app.listen(PORT, () => {
    console.log(`Lumina LMS lancé sur http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('Impossible de démarrer Lumina LMS:', error.message);
  process.exit(1);
});
