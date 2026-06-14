require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
});
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");

const hasCloudinary = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET,
);

if (hasCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const dbConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      database: process.env.DB_NAME || "lumina_lms",
    };

const pool = new Pool({
  ...dbConfig,
  max: 10,
});

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(password, salt, 120000, 64, "sha512")
    .toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, originalHash] = String(stored).split(":");
  if (!salt || !originalHash) return false;
  const testHash = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(
    Buffer.from(originalHash, "hex"),
    Buffer.from(testHash, "hex"),
  );
}

function signUser(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: "7d" },
  );
}

function asyncHandler(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

function auth(requiredRoles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Connexion requise." });

    try {
      req.user = jwt.verify(token, JWT_SECRET);
      if (requiredRoles.length && !requiredRoles.includes(req.user.role)) {
        return res.status(403).json({ message: "Accès refusé pour ce rôle." });
      }
      next();
    } catch {
      res.status(401).json({ message: "Session invalide ou expirée." });
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
  if (!file) throw new Error("Fichier manquant.");
  if (hasCloudinary) {
    const folder = process.env.CLOUDINARY_FOLDER || "lumina-lms";
    const resourceType = type === "video" ? "video" : "auto";
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: resourceType, use_filename: true },
        (error, value) => (error ? reject(error) : resolve(value)),
      );
      stream.end(file.buffer);
    });
    return { url: result.secure_url, publicId: result.public_id };
  }

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "-");
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), file.buffer);
  return { url: `/uploads/${filename}`, publicId: filename };
}

async function initDatabase() {
  console.log("[DB] Vérification/Création du schéma...");
  
  try {
    // Create tables if they don't exist
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(50) NOT NULL CHECK (role IN ('student', 'teacher', 'promoter')),
        avatar_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS modules (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        level VARCHAR(100),
        certificate_threshold INT DEFAULT 70,
        created_by INT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS courses (
        id SERIAL PRIMARY KEY,
        module_id INT REFERENCES modules(id) ON DELETE CASCADE,
        teacher_id INT REFERENCES users(id),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        cover_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS lessons (
        id SERIAL PRIMARY KEY,
        course_id INT REFERENCES courses(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        summary TEXT,
        content_type VARCHAR(50) NOT NULL,
        content_url TEXT,
        public_id TEXT,
        position INT DEFAULT 1,
        duration_minutes INT DEFAULT 10,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS evaluations (
        id SERIAL PRIMARY KEY,
        lesson_id INT UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        pass_score INT DEFAULT 60,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        evaluation_id INT REFERENCES evaluations(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT NOT NULL,
        option_d TEXT NOT NULL,
        correct_option CHAR(1) NOT NULL,
        points INT DEFAULT 1
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS enrollments (
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        course_id INT REFERENCES courses(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, course_id)
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        lesson_id INT REFERENCES lessons(id) ON DELETE CASCADE,
        evaluation_id INT REFERENCES evaluations(id),
        score INT,
        answers JSONB,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, lesson_id)
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS certificates (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        module_id INT REFERENCES modules(id) ON DELETE CASCADE,
        certificate_code VARCHAR(255) UNIQUE NOT NULL,
        average_score DECIMAL(5,2),
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, module_id)
      )
    `);

    console.log("[DB] ✓ Schéma de base de données initialisé avec succès.");
  } catch (error) {
    console.error("[DB] Erreur lors de l'initialisation:", error.message);
    throw error;
  }
}

async function seedDemo() {
  console.log("[SEED] Vérification des données de démo...");
  
  const userCount = await query("SELECT COUNT(*) AS count FROM users");
  if (parseInt(userCount[0].count) > 0) {
    console.log("[SEED] Données déjà existantes, skip seeding.");
    return;
  }

  console.log("[SEED] Création des utilisateurs de démo...");
  const promoterHash = hashPassword("password123");
  const teacherHash = hashPassword("password123");
  const studentHash = hashPassword("password123");
  
  const demoUsers = await query(
    `INSERT INTO users (name, email, password_hash, role) VALUES
      ('Amina Promoteur', 'promoter@lumina.test', $1, 'promoter'),
      ('Nicolas Enseignant', 'teacher@lumina.test', $2, 'teacher'),
      ('Grace Etudiante', 'student@lumina.test', $3, 'student')
     RETURNING id, role`,
    [promoterHash, teacherHash, studentHash]
  );
  
  const promoterId = demoUsers.find((user) => user.role === "promoter").id;
  const teacherId = demoUsers.find((user) => user.role === "teacher").id;

  console.log("[SEED] Création du module et cours de démo...");
  const [module] = await query(
    `INSERT INTO modules (title, description, level, certificate_threshold, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    ['Fondamentaux du Web', 'HTML, CSS, JavaScript et bases de l’expérience utilisateur.', 'Débutant', 70, promoterId]
  );
  
  const [course] = await query(
    `INSERT INTO courses (module_id, teacher_id, title, description, cover_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [module.id, teacherId, 'Créer une interface LMS moderne', 'Un cours guidé pour structurer des pages pédagogiques claires.', '']
  );
  
  const lessons = await query(
    `INSERT INTO lessons (course_id, title, summary, content_type, content_url, position, duration_minutes)
     VALUES
      ($1, $2, $3, $4, $5, 1, 12),
      ($1, $6, $7, $8, $9, 2, 18)
     RETURNING id, position`,
    [course.id, 
     'Architecture d’une page de cours', 'Comprendre la navigation, les modules et la progression.', 
     'pdf', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
     'Interactions JavaScript utiles', 'Créer une expérience fluide pour l’apprenant.',
     'video', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4']
  );
  
  const firstLessonId = lessons.find((lesson) => lesson.position === 1).id;
  const secondLessonId = lessons.find((lesson) => lesson.position === 2).id;
  
  await query(
    `INSERT INTO evaluations (lesson_id, title, pass_score) VALUES
      ($1, $2, 60),
      ($3, $4, 60)`,
    [firstLessonId, 'Quiz: structure LMS', secondLessonId, 'Quiz: interactions']
  );
  
  const evaluations = await query(
    "SELECT id, title FROM evaluations WHERE lesson_id IN ($1, $2)",
    [firstLessonId, secondLessonId]
  );
  
  const structureEvaluationId = evaluations.find((e) => e.title.includes("structure")).id;
  const interactionEvaluationId = evaluations.find((e) => e.title.includes("interactions")).id;
  
  await query(
    `INSERT INTO questions (evaluation_id, question, option_a, option_b, option_c, option_d, correct_option, points) VALUES
      ($1, 'Quel élément aide le plus à organiser un cours LMS ?', 'Une couleur unique', 'Des modules et leçons', 'Une image décorative', 'Un long paragraphe', 'B', 1),
      ($1, 'La progression d’un étudiant doit être liée à...', 'Sa note aux évaluations', 'Son navigateur', 'Son email uniquement', 'La taille du fichier', 'A', 1),
      ($2, 'JavaScript sert ici principalement à...', 'Rendre les pages interactives', 'Remplacer PostgreSQL', 'Compresser les vidéos', 'Créer le serveur DNS', 'A', 1),
      ($2, 'Une bonne interface étudiant doit montrer...', 'La progression et les prochaines leçons', 'Seulement le logo', 'Le code source', 'Les mots de passe', 'A', 1)`,
    [structureEvaluationId, interactionEvaluationId]
  );
  
  console.log("[SEED] ✓ Données de démo créées avec succès.");
}

// API Routes
app.post(
  "/api/auth/register",
  asyncHandler(async (req, res) => {
    const { name, email, password, role } = req.body;
    const allowedRoles = ["promoter", "teacher", "student"];
    if (!name || !email || !password || !allowedRoles.includes(role)) {
      return res
        .status(400)
        .json({ message: "Nom, email, mot de passe et rôle sont requis." });
    }
    const passwordHash = hashPassword(password);
    await query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)",
      [name, email, passwordHash, role]
    );
    const rows = await query(
      "SELECT id, name, email, role FROM users WHERE email = $1",
      [email]
    );
    res.status(201).json({ user: rows[0], token: signUser(rows[0]) });
  }),
);

app.post(
  "/api/auth/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const rows = await query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ message: "Identifiants incorrects." });
    }
    delete user.password_hash;
    res.json({ user, token: signUser(user) });
  }),
);

app.get(
  "/api/me",
  auth(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      "SELECT id, name, email, role, avatar_url FROM users WHERE id = $1",
      [req.user.id]
    );
    res.json(rows[0]);
  }),
);

app.get(
  "/api/health",
  asyncHandler(async (req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true, storage: hasCloudinary ? "cloudinary" : "local" });
  }),
);

app.get(
  "/api/dashboard",
  auth(),
  asyncHandler(async (req, res) => {
    const [modulesCount] = await query("SELECT COUNT(*) AS count FROM modules");
    const [coursesCount] = await query("SELECT COUNT(*) AS count FROM courses");
    const [lessonsCount] = await query("SELECT COUNT(*) AS count FROM lessons");
    const [certificatesCount] = await query("SELECT COUNT(*) AS count FROM certificates");
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
        modules: parseInt(modulesCount.count),
        courses: parseInt(coursesCount.count),
        lessons: parseInt(lessonsCount.count),
        certificates: parseInt(certificatesCount.count),
      },
      latest,
    });
  }),
);

app.get(
  "/api/modules",
  auth(),
  asyncHandler(async (req, res) => {
    const modules = await query(
      `SELECT m.*, COUNT(DISTINCT c.id) AS course_count, COUNT(DISTINCT cert.id) AS certificate_count
     FROM modules m
     LEFT JOIN courses c ON c.module_id = m.id
     LEFT JOIN certificates cert ON cert.module_id = m.id
     GROUP BY m.id
     ORDER BY m.created_at DESC`
    );
    res.json(modules);
  }),
);

app.post(
  "/api/modules",
  auth(["promoter"]),
  asyncHandler(async (req, res) => {
    const { title, description, level, certificate_threshold } = req.body;
    await query(
      `INSERT INTO modules (title, description, level, certificate_threshold, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
      [
        title,
        description || "",
        level || "Débutant",
        Number(certificate_threshold) || 70,
        req.user.id,
      ]
    );
    res.status(201).json({ message: "Module créé." });
  }),
);

app.get(
  "/api/courses",
  auth(),
  asyncHandler(async (req, res) => {
    const courses = await query(
      `SELECT c.*, m.title AS module_title, u.name AS teacher_name,
      COUNT(DISTINCT l.id) AS lesson_count,
      EXISTS(SELECT 1 FROM enrollments e WHERE e.course_id = c.id AND e.user_id = $1) AS enrolled
     FROM courses c
     JOIN modules m ON m.id = c.module_id
     LEFT JOIN users u ON u.id = c.teacher_id
     LEFT JOIN lessons l ON l.course_id = c.id
     WHERE ($2 = 0 OR c.teacher_id = $1)
     GROUP BY c.id, m.title, u.name
     ORDER BY c.created_at DESC`,
      [req.user.id, req.user.role === "teacher" ? 1 : 0]
    );
    res.json(courses);
  }),
);

app.post(
  "/api/courses",
  auth(["teacher"]),
  upload.single("cover"),
  asyncHandler(async (req, res) => {
    const { module_id, title, description } = req.body;
    let coverUrl = "";
    if (req.file) coverUrl = (await uploadAsset(req.file, "image")).url;
    await query(
      `INSERT INTO courses (module_id, teacher_id, title, description, cover_url)
     VALUES ($1, $2, $3, $4, $5)`,
      [module_id, req.user.id, title, description || "", coverUrl]
    );
    res.status(201).json({ message: "Cours créé." });
  }),
);

app.post(
  "/api/courses/:id/enroll",
  auth(["student"]),
  asyncHandler(async (req, res) => {
    await query(
      "INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2) ON CONFLICT (user_id, course_id) DO NOTHING",
      [req.user.id, req.params.id]
    );
    res.json({ message: "Inscription confirmée." });
  }),
);

app.get(
  "/api/courses/:id",
  auth(),
  asyncHandler(async (req, res) => {
    const courseRows = await query(
      `SELECT c.*, m.title AS module_title, m.certificate_threshold, u.name AS teacher_name
     FROM courses c
     JOIN modules m ON m.id = c.module_id
     LEFT JOIN users u ON u.id = c.teacher_id
     WHERE c.id = $1`,
      [req.params.id]
    );
    const course = courseRows[0];
    if (!course) return res.status(404).json({ message: "Cours introuvable." });
    const lessons = await query(
      `SELECT l.*, e.id AS evaluation_id, e.title AS evaluation_title, e.pass_score,
      s.score AS student_score, s.submitted_at
     FROM lessons l
     LEFT JOIN evaluations e ON e.lesson_id = l.id
     LEFT JOIN submissions s ON s.lesson_id = l.id AND s.user_id = $1
     WHERE l.course_id = $2
     ORDER BY l.position ASC`,
      [req.user.id, req.params.id]
    );
    res.json({ course, lessons });
  }),
);

app.post(
  "/api/courses/:id/lessons",
  auth(["teacher"]),
  upload.single("content"),
  asyncHandler(async (req, res) => {
    const { title, summary, content_type, position, duration_minutes } = req.body;
    const ownership = await query(
      "SELECT id FROM courses WHERE id = $1 AND teacher_id = $2",
      [req.params.id, req.user.id]
    );
    if (!ownership.length)
      return res
        .status(403)
        .json({ message: "Ce cours ne vous appartient pas." });
    if (!["pdf", "video"].includes(content_type))
      return res.status(400).json({ message: "Type de leçon invalide." });

    const asset = await uploadAsset(req.file, content_type);
    await query(
      `INSERT INTO lessons (course_id, title, summary, content_type, content_url, public_id, position, duration_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.params.id,
        title,
        summary || "",
        content_type,
        asset.url,
        asset.publicId,
        Number(position) || 1,
        Number(duration_minutes) || 10,
      ]
    );
    res.status(201).json({ message: "Leçon ajoutée." });
  }),
);

app.post(
  "/api/lessons/:id/evaluation",
  auth(["teacher"]),
  asyncHandler(async (req, res) => {
    const { title, pass_score, questions } = req.body;
    const ownership = await query(
      `SELECT l.id FROM lessons l JOIN courses c ON c.id = l.course_id
     WHERE l.id = $1 AND c.teacher_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!ownership.length)
      return res.status(403).json({ message: "Leçon non autorisée." });
    if (!Array.isArray(questions) || !questions.length) {
      return res
        .status(400)
        .json({ message: "Ajoutez au moins une question." });
    }

    await query(
      `INSERT INTO evaluations (lesson_id, title, pass_score)
     VALUES ($1, $2, $3)
     ON CONFLICT (lesson_id) DO UPDATE SET title = EXCLUDED.title, pass_score = EXCLUDED.pass_score`,
      [req.params.id, title, Number(pass_score) || 60]
    );
    const [evaluation] = await query(
      "SELECT id FROM evaluations WHERE lesson_id = $1",
      [req.params.id]
    );
    await query("DELETE FROM questions WHERE evaluation_id = $1", [evaluation.id]);

    for (const item of questions) {
      await query(
        `INSERT INTO questions
       (evaluation_id, question, option_a, option_b, option_c, option_d, correct_option, points)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          evaluation.id,
          item.question,
          item.option_a,
          item.option_b,
          item.option_c,
          item.option_d,
          item.correct_option,
          Number(item.points) || 1,
        ]
      );
    }
    res.status(201).json({ message: "Evaluation enregistrée." });
  }),
);

app.get(
  "/api/lessons/:id/evaluation",
  auth(),
  asyncHandler(async (req, res) => {
    const [evaluation] = await query(
      "SELECT * FROM evaluations WHERE lesson_id = $1",
      [req.params.id]
    );
    if (!evaluation)
      return res.status(404).json({ message: "Aucune évaluation." });
    const questions = await query(
      `SELECT id, question, option_a, option_b, option_c, option_d, points
     FROM questions WHERE evaluation_id = $1 ORDER BY id ASC`,
      [evaluation.id]
    );
    res.json({ evaluation, questions });
  }),
);

app.post(
  "/api/lessons/:id/submit",
  auth(["student"]),
  asyncHandler(async (req, res) => {
    const { answers } = req.body;
    const [evaluation] = await query(
      "SELECT * FROM evaluations WHERE lesson_id = $1",
      [req.params.id]
    );
    if (!evaluation)
      return res.status(404).json({ message: "Aucune évaluation disponible." });
    const questions = await query(
      "SELECT * FROM questions WHERE evaluation_id = $1",
      [evaluation.id]
    );
    const total = questions.reduce((sum, q) => sum + Number(q.points), 0);
    const earned = questions.reduce((sum, q) => {
      return (
        sum + (answers?.[q.id] === q.correct_option ? Number(q.points) : 0)
      );
    }, 0);
    const score = total ? Math.round((earned / total) * 100) : 0;

    await query(
      `INSERT INTO submissions (user_id, lesson_id, evaluation_id, score, answers)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (user_id, lesson_id)
     DO UPDATE SET score = EXCLUDED.score, answers = EXCLUDED.answers, submitted_at = CURRENT_TIMESTAMP`,
      [req.user.id, req.params.id, evaluation.id, score, JSON.stringify(answers || {})]
    );
    res.json({ score, passed: score >= evaluation.pass_score });
  }),
);

app.get(
  "/api/progress",
  auth(["student"]),
  asyncHandler(async (req, res) => {
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
     WHERE en.user_id = $1
     GROUP BY c.id, m.id
     ORDER BY en.created_at DESC`,
      [req.user.id]
    );
    res.json(progress);
  }),
);

app.post(
  "/api/modules/:id/certificate",
  auth(["student"]),
  asyncHandler(async (req, res) => {
    const moduleId = req.params.id;
    const [module] = await query("SELECT * FROM modules WHERE id = $1", [moduleId]);
    if (!module)
      return res.status(404).json({ message: "Module introuvable." });
    const [result] = await query(
      `SELECT COUNT(DISTINCT l.id) AS lesson_count,
      COUNT(DISTINCT s.lesson_id) AS completed_lessons,
      COALESCE(ROUND(AVG(s.score), 2), 0) AS average_score
     FROM courses c
     JOIN lessons l ON l.course_id = c.id
     LEFT JOIN submissions s ON s.lesson_id = l.id AND s.user_id = $1
     WHERE c.module_id = $2`,
      [req.user.id, moduleId]
    );
    if (
      !result.lesson_count ||
      parseInt(result.completed_lessons) < parseInt(result.lesson_count) ||
      parseFloat(result.average_score) < module.certificate_threshold
    ) {
      return res.status(400).json({ message: "Module pas encore validé." });
    }

    const code = `LUM-${moduleId}-${req.user.id}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    await query(
      `INSERT INTO certificates (user_id, module_id, certificate_code, average_score)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, module_id) DO UPDATE SET average_score = EXCLUDED.average_score`,
      [req.user.id, moduleId, code, parseFloat(result.average_score)]
    );
    const [certificate] = await query(
      `SELECT cert.*, m.title AS module_title, u.name AS student_name
     FROM certificates cert
     JOIN modules m ON m.id = cert.module_id
     JOIN users u ON u.id = cert.user_id
     WHERE cert.user_id = $1 AND cert.module_id = $2`,
      [req.user.id, moduleId]
    );
    res.json(certificate);
  }),
);

app.get(
  "/api/certificates",
  auth(),
  asyncHandler(async (req, res) => {
    const onlyMine = req.user.role === "student";
    const certificates = await query(
      `SELECT cert.*, m.title AS module_title, u.name AS student_name
     FROM certificates cert
     JOIN modules m ON m.id = cert.module_id
     JOIN users u ON u.id = cert.user_id
     WHERE ($1 = 0 OR cert.user_id = $2)
     ORDER BY cert.issued_at DESC`,
      [onlyMine ? 1 : 0, req.user.id]
    );
    res.json(certificates);
  }),
);

// Serve static files
app.use(express.static(PUBLIC_DIR));
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === "23505")
    return res.status(409).json({ message: "Cette donnée existe déjà." });
  res.status(500).json({ message: err.message || "Erreur serveur." });
});

async function start() {
  try {
    console.log("[APP] Démarrage de Lumina LMS...");
    console.log(`[APP] Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`[APP] Port: ${PORT}`);

    // Créer le dossier uploads
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    console.log("[APP] ✓ Dossier uploads prêt.");

    // Tester la connexion à la base de données
    console.log("[DB] Connexion à la base de données...");
    await pool.query("SELECT 1");
    console.log("[DB] ✓ Connecté à la base de données.");

    // Initialiser le schéma
    await initDatabase();

    // Seed les données de démo
    await seedDemo();

    // Démarrer le serveur
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[APP] ✓ Lumina LMS lancé sur le port ${PORT}`);
      console.log(`[APP] Stockage: ${hasCloudinary ? "Cloudinary" : "Local"}`);
    });
  } catch (error) {
    console.error("[APP] Impossible de démarrer Lumina LMS:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

start();
