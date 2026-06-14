require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// Configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024 },
});
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "brain-vision-secret";
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");

// PostgreSQL configuration
const isProduction = process.env.NODE_ENV === "production";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(isProduction && {
    ssl: { rejectUnauthorized: false }
  })
});

// Helper functions
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha512")
    .toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, originalHash] = String(stored).split(":");
  if (!salt || !originalHash) return false;
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(originalHash, "hex"), Buffer.from(hash, "hex"));
}

function signUser(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function auth(requiredRoles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ message: "Connexion requise." });
    }

    try {
      req.user = jwt.verify(token, JWT_SECRET);
      if (requiredRoles.length && !requiredRoles.includes(req.user.role)) {
        return res.status(403).json({ message: "Accès refusé pour ce rôle." });
      }
      next();
    } catch (error) {
      res.status(401).json({ message: "Session invalide ou expirée." });
    }
  };
}

async function uploadAsset(file, type) {
  if (!file) throw new Error("Fichier manquant.");
  
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const ext = path.extname(file.originalname);
  const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "-");
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  const filepath = path.join(UPLOAD_DIR, filename);
  await fs.writeFile(filepath, file.buffer);
  return { url: `/uploads/${filename}`, publicId: filename };
}

// Database initialization
async function initDatabase() {
  console.log("[DB] Initialisation de la base de données...");
  
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(50) NOT NULL CHECK (role IN ('student', 'teacher', 'promoter')),
      avatar_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS modules (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      level VARCHAR(100),
      certificate_threshold INT DEFAULT 70,
      created_by INT REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      module_id INT REFERENCES modules(id) ON DELETE CASCADE,
      teacher_id INT REFERENCES users(id),
      title VARCHAR(255) NOT NULL,
      description TEXT,
      cover_url TEXT,
      status VARCHAR(50) DEFAULT 'draft',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS lessons (
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
    )`,
    
    `CREATE TABLE IF NOT EXISTS evaluations (
      id SERIAL PRIMARY KEY,
      lesson_id INT UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      pass_score INT DEFAULT 60,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      evaluation_id INT REFERENCES evaluations(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      option_d TEXT NOT NULL,
      correct_option CHAR(1) NOT NULL,
      points INT DEFAULT 1
    )`,
    
    `CREATE TABLE IF NOT EXISTS enrollments (
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      course_id INT REFERENCES courses(id) ON DELETE CASCADE,
      progress DECIMAL(5,2) DEFAULT 0,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, course_id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      lesson_id INT REFERENCES lessons(id) ON DELETE CASCADE,
      evaluation_id INT REFERENCES evaluations(id),
      score INT,
      answers JSONB,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, lesson_id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS certificates (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      module_id INT REFERENCES modules(id) ON DELETE CASCADE,
      certificate_code VARCHAR(255) UNIQUE NOT NULL,
      average_score DECIMAL(5,2),
      issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, module_id)
    )`
  ];

  for (const sql of tables) {
    try {
      await pool.query(sql);
    } catch (error) {
      console.error(`[DB] Erreur:`, error.message);
    }
  }
  
  console.log("[DB] ✓ Base de données initialisée");
}

async function seedDemo() {
  try {
    const result = await pool.query("SELECT COUNT(*) FROM users");
    if (parseInt(result.rows[0].count) > 0) {
      console.log("[SEED] Données déjà existantes");
      return;
    }

    console.log("[SEED] Création des données de démonstration...");
    
    // Créer les utilisateurs
    const usersResult = await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES
        ($1, $2, $3, $4),
        ($5, $6, $7, $8),
        ($9, $10, $11, $12)
       RETURNING id, role`,
      [
        "Admin Promoteur", "promoter@brain-vision.com", hashPassword("password123"), "promoter",
        "Prof Enseignant", "teacher@brain-vision.com", hashPassword("password123"), "teacher",
        "Etudiant Test", "student@brain-vision.com", hashPassword("password123"), "student"
      ]
    );
    
    const promoterId = usersResult.rows.find(u => u.role === "promoter").id;
    const teacherId = usersResult.rows.find(u => u.role === "teacher").id;
    const studentId = usersResult.rows.find(u => u.role === "student").id;
    
    // Créer un module
    const moduleResult = await pool.query(
      `INSERT INTO modules (title, description, level, certificate_threshold, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      ["Développement Web Moderne", "Maîtrisez les fondamentaux du développement web", "Debutant", 70, promoterId]
    );
    const moduleId = moduleResult.rows[0].id;
    
    // Créer un cours
    const courseResult = await pool.query(
      `INSERT INTO courses (module_id, teacher_id, title, description, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [moduleId, teacherId, "HTML5 & CSS3 Avancé", "Apprenez à créer des sites web modernes et responsives", "published"]
    );
    const courseId = courseResult.rows[0].id;
    
    // Inscrire l'étudiant
    await pool.query(
      "INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2)",
      [studentId, courseId]
    );
    
    // Créer des leçons avec évaluations
    const lessons = [
      { title: "Introduction au HTML5", summary: "Les bases du HTML5 et sa structure", type: "pdf", url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", position: 1 },
      { title: "Les sélecteurs CSS", summary: "Maîtrisez les sélecteurs CSS pour un design parfait", type: "video", url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", position: 2 },
      { title: "Flexbox et Grid", summary: "Créez des layouts modernes et responsives", type: "pdf", url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", position: 3 }
    ];
    
    for (const lesson of lessons) {
      const lessonResult = await pool.query(
        `INSERT INTO lessons (course_id, title, summary, content_type, content_url, position)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [courseId, lesson.title, lesson.summary, lesson.type, lesson.url, lesson.position]
      );
      const lessonId = lessonResult.rows[0].id;
      
      // Créer une évaluation pour chaque leçon
      const evalResult = await pool.query(
        `INSERT INTO evaluations (lesson_id, title, pass_score)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [lessonId, `Quiz - ${lesson.title}`, 60]
      );
      const evaluationId = evalResult.rows[0].id;
      
      // Ajouter des questions spécifiques à chaque leçon
      if (lesson.position === 1) {
        await pool.query(
          `INSERT INTO questions (evaluation_id, question, option_a, option_b, option_c, option_d, correct_option, points) VALUES
            ($1, 'Que signifie HTML ?', 'Hyper Text Markup Language', 'High Tech Modern Language', 'Hyper Transfer Markup Language', 'Home Tool Markup Language', 'A', 1),
            ($1, 'Quelle balise HTML est utilisée pour créer un lien ?', '<link>', '<a>', '<href>', '<url>', 'B', 1)`,
          [evaluationId]
        );
      } else if (lesson.position === 2) {
        await pool.query(
          `INSERT INTO questions (evaluation_id, question, option_a, option_b, option_c, option_d, correct_option, points) VALUES
            ($1, 'Comment sélectionne-t-on un élément par son ID en CSS ?', '.monId', '#monId', '*monId', 'monId', 'B', 1),
            ($1, 'Quelle propriété CSS permet de changer la couleur du texte ?', 'background-color', 'text-color', 'color', 'font-color', 'C', 1)`,
          [evaluationId]
        );
      } else {
        await pool.query(
          `INSERT INTO questions (evaluation_id, question, option_a, option_b, option_c, option_d, correct_option, points) VALUES
            ($1, 'Que permet Flexbox de faire ?', 'Créer des grilles complexes', 'Disposer des éléments en ligne ou colonne', 'Gérer les images', 'Animer des éléments', 'B', 1),
            ($1, 'Quelle propriété CSS Grid définit les colonnes ?', 'grid-template-columns', 'grid-columns', 'grid-template', 'grid-col', 'A', 1)`,
          [evaluationId]
        );
      }
    }
    
    console.log("[SEED] ✓ Données créées avec succès");
  } catch (error) {
    console.error("[SEED] Erreur:", error.message);
  }
}

// ==================== ROUTES API ====================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

// Auth routes
app.post("/api/auth/register", asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;
  const allowedRoles = ["promoter", "teacher", "student"];
  
  if (!name || !email || !password || !allowedRoles.includes(role)) {
    return res.status(400).json({ message: "Tous les champs sont requis" });
  }
  
  const passwordHash = hashPassword(password);
  
  try {
    await pool.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)",
      [name, email, passwordHash, role]
    );
    
    const result = await pool.query(
      "SELECT id, name, email, role FROM users WHERE email = $1",
      [email]
    );
    
    const user = result.rows[0];
    res.status(201).json({ user, token: signUser(user) });
  } catch (error) {
    if (error.code === "23505") {
      res.status(409).json({ message: "Cet email est déjà utilisé" });
    } else {
      throw error;
    }
  }
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];
  
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ message: "Email ou mot de passe incorrect" });
  }
  
  delete user.password_hash;
  res.json({ user, token: signUser(user) });
}));

// Dashboard
app.get("/api/dashboard", auth(), asyncHandler(async (req, res) => {
  const [modulesCount, coursesCount, lessonsCount, certificatesCount] = await Promise.all([
    pool.query("SELECT COUNT(*) FROM modules"),
    pool.query("SELECT COUNT(*) FROM courses"),
    pool.query("SELECT COUNT(*) FROM lessons"),
    pool.query("SELECT COUNT(*) FROM certificates")
  ]);
  
  let latest = [];
  
  if (req.user.role === "student") {
    latest = await pool.query(
      `SELECT c.id, c.title, c.description, m.title AS module_title, u.name AS teacher_name,
       e.progress, e.completed_at
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
       JOIN modules m ON m.id = c.module_id
       LEFT JOIN users u ON u.id = c.teacher_id
       WHERE e.user_id = $1
       ORDER BY e.created_at DESC
       LIMIT 6`,
      [req.user.id]
    );
  } else {
    latest = await pool.query(
      `SELECT c.id, c.title, c.description, m.title AS module_title, u.name AS teacher_name
       FROM courses c
       JOIN modules m ON m.id = c.module_id
       LEFT JOIN users u ON u.id = c.teacher_id
       ORDER BY c.created_at DESC
       LIMIT 6`
    );
  }
  
  res.json({
    stats: {
      modules: parseInt(modulesCount.rows[0].count),
      courses: parseInt(coursesCount.rows[0].count),
      lessons: parseInt(lessonsCount.rows[0].count),
      certificates: parseInt(certificatesCount.rows[0].count)
    },
    latest: latest.rows,
    userRole: req.user.role
  });
}));

// Modules (Promoteur only)
app.get("/api/modules", auth(), asyncHandler(async (req, res) => {
  const modules = await pool.query(
    `SELECT m.*, COUNT(DISTINCT c.id) AS course_count, COUNT(DISTINCT cert.id) AS certificate_count,
     (SELECT COUNT(*) FROM enrollments e 
      JOIN courses c2 ON c2.id = e.course_id 
      WHERE c2.module_id = m.id) AS student_count
     FROM modules m
     LEFT JOIN courses c ON c.module_id = m.id
     LEFT JOIN certificates cert ON cert.module_id = m.id
     GROUP BY m.id
     ORDER BY m.created_at DESC`
  );
  res.json(modules.rows);
}));

app.post("/api/modules", auth(["promoter"]), asyncHandler(async (req, res) => {
  const { title, description, level, certificate_threshold } = req.body;
  
  const result = await pool.query(
    `INSERT INTO modules (title, description, level, certificate_threshold, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [title, description || "", level || "Debutant", Number(certificate_threshold) || 70, req.user.id]
  );
  
  res.status(201).json({ message: "Module créé avec succès", moduleId: result.rows[0].id });
}));

app.put("/api/modules/:id", auth(["promoter"]), asyncHandler(async (req, res) => {
  const { title, description, level, certificate_threshold } = req.body;
  
  await pool.query(
    `UPDATE modules 
     SET title = $1, description = $2, level = $3, certificate_threshold = $4
     WHERE id = $5`,
    [title, description, level, certificate_threshold, req.params.id]
  );
  
  res.json({ message: "Module mis à jour" });
}));

app.delete("/api/modules/:id", auth(["promoter"]), asyncHandler(async (req, res) => {
  await pool.query("DELETE FROM modules WHERE id = $1", [req.params.id]);
  res.json({ message: "Module supprimé" });
}));

// Courses
app.get("/api/courses", auth(), asyncHandler(async (req, res) => {
  let query_text = `
    SELECT c.*, m.title AS module_title, u.name AS teacher_name,
     COUNT(DISTINCT l.id) AS lesson_count,
     COUNT(DISTINCT e.user_id) AS enrolled_count,
     EXISTS(SELECT 1 FROM enrollments e2 WHERE e2.course_id = c.id AND e2.user_id = $1) AS enrolled,
     COALESCE(e3.progress, 0) AS my_progress
     FROM courses c
     JOIN modules m ON m.id = c.module_id
     LEFT JOIN users u ON u.id = c.teacher_id
     LEFT JOIN lessons l ON l.course_id = c.id
     LEFT JOIN enrollments e3 ON e3.course_id = c.id AND e3.user_id = $1
  `;
  
  const params = [req.user.id];
  
  if (req.user.role === "teacher") {
    query_text += ` WHERE c.teacher_id = $2`;
    params.push(req.user.id);
  }
  
  query_text += ` GROUP BY c.id, m.title, u.name, e3.progress ORDER BY c.created_at DESC`;
  
  const courses = await pool.query(query_text, params);
  res.json(courses.rows);
}));

app.post("/api/courses", auth(["teacher"]), upload.single("cover"), asyncHandler(async (req, res) => {
  const { module_id, title, description } = req.body;
  let coverUrl = "";
  
  if (req.file) {
    const asset = await uploadAsset(req.file, "image");
    coverUrl = asset.url;
  }
  
  const result = await pool.query(
    `INSERT INTO courses (module_id, teacher_id, title, description, cover_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [module_id, req.user.id, title, description || "", coverUrl]
  );
  
  res.status(201).json({ message: "Cours créé avec succès", courseId: result.rows[0].id });
}));

app.post("/api/courses/:id/enroll", auth(["student"]), asyncHandler(async (req, res) => {
  const existing = await pool.query(
    "SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2",
    [req.user.id, req.params.id]
  );
  
  if (existing.rows.length === 0) {
    await pool.query(
      "INSERT INTO enrollments (user_id, course_id, progress) VALUES ($1, $2, 0)",
      [req.user.id, req.params.id]
    );
  }
  
  res.json({ message: "Inscription confirmée" });
}));

app.get("/api/courses/:id", auth(), asyncHandler(async (req, res) => {
  const courseResult = await pool.query(
    `SELECT c.*, m.title AS module_title, m.certificate_threshold, u.name AS teacher_name,
     (SELECT progress FROM enrollments WHERE user_id = $1 AND course_id = c.id) AS my_progress
     FROM courses c
     JOIN modules m ON m.id = c.module_id
     LEFT JOIN users u ON u.id = c.teacher_id
     WHERE c.id = $2`,
    [req.user.id, req.params.id]
  );
  
  if (courseResult.rows.length === 0) {
    return res.status(404).json({ message: "Cours introuvable" });
  }
  
  const lessons = await pool.query(
    `SELECT l.*, e.id AS evaluation_id, e.title AS evaluation_title, e.pass_score,
     s.score AS student_score, s.submitted_at,
     CASE WHEN s.score >= e.pass_score THEN true ELSE false END AS is_validated
     FROM lessons l
     LEFT JOIN evaluations e ON e.lesson_id = l.id
     LEFT JOIN submissions s ON s.lesson_id = l.id AND s.user_id = $1
     WHERE l.course_id = $2
     ORDER BY l.position ASC`,
    [req.user.id, req.params.id]
  );
  
  res.json({ course: courseResult.rows[0], lessons: lessons.rows });
}));

// Lessons
app.post("/api/courses/:id/lessons", auth(["teacher"]), upload.single("content"), asyncHandler(async (req, res) => {
  const { title, summary, content_type, position } = req.body;
  
  const ownership = await pool.query(
    "SELECT id FROM courses WHERE id = $1 AND teacher_id = $2",
    [req.params.id, req.user.id]
  );
  
  if (ownership.rows.length === 0) {
    return res.status(403).json({ message: "Ce cours ne vous appartient pas" });
  }
  
  if (!["pdf", "video"].includes(content_type)) {
    return res.status(400).json({ message: "Type de contenu invalide" });
  }
  
  if (!req.file) {
    return res.status(400).json({ message: "Fichier requis" });
  }
  
  const asset = await uploadAsset(req.file, content_type);
  
  const result = await pool.query(
    `INSERT INTO lessons (course_id, title, summary, content_type, content_url, public_id, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [req.params.id, title, summary || "", content_type, asset.url, asset.publicId, Number(position) || 1]
  );
  
  res.status(201).json({ message: "Leçon ajoutée avec succès", lessonId: result.rows[0].id });
}));

// Evaluations
app.post("/api/lessons/:id/evaluation", auth(["teacher"]), asyncHandler(async (req, res) => {
  const { title, pass_score, questions } = req.body;
  
  const ownership = await pool.query(
    `SELECT l.id FROM lessons l 
     JOIN courses c ON c.id = l.course_id
     WHERE l.id = $1 AND c.teacher_id = $2`,
    [req.params.id, req.user.id]
  );
  
  if (ownership.rows.length === 0) {
    return res.status(403).json({ message: "Leçon non autorisée" });
  }
  
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ message: "Ajoutez au moins une question" });
  }
  
  await pool.query(
    `INSERT INTO evaluations (lesson_id, title, pass_score)
     VALUES ($1, $2, $3)
     ON CONFLICT (lesson_id) 
     DO UPDATE SET title = EXCLUDED.title, pass_score = EXCLUDED.pass_score`,
    [req.params.id, title, Number(pass_score) || 60]
  );
  
  const evaluationResult = await pool.query(
    "SELECT id FROM evaluations WHERE lesson_id = $1",
    [req.params.id]
  );
  const evaluationId = evaluationResult.rows[0].id;
  
  await pool.query("DELETE FROM questions WHERE evaluation_id = $1", [evaluationId]);
  
  for (const item of questions) {
    await pool.query(
      `INSERT INTO questions (evaluation_id, question, option_a, option_b, option_c, option_d, correct_option, points)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        evaluationId,
        item.question,
        item.option_a,
        item.option_b,
        item.option_c,
        item.option_d,
        item.correct_option,
        Number(item.points) || 1
      ]
    );
  }
  
  res.status(201).json({ message: "Évaluation enregistrée avec succès" });
}));

app.get("/api/lessons/:id/evaluation", auth(), asyncHandler(async (req, res) => {
  const evaluationResult = await pool.query(
    "SELECT * FROM evaluations WHERE lesson_id = $1",
    [req.params.id]
  );
  
  if (evaluationResult.rows.length === 0) {
    return res.status(404).json({ message: "Aucune évaluation disponible" });
  }
  
  const evaluation = evaluationResult.rows[0];
  
  const submission = await pool.query(
    "SELECT * FROM submissions WHERE user_id = $1 AND lesson_id = $2",
    [req.user.id, req.params.id]
  );
  
  const questions = await pool.query(
    `SELECT id, question, option_a, option_b, option_c, option_d, points
     FROM questions 
     WHERE evaluation_id = $1 
     ORDER BY id ASC`,
    [evaluation.id]
  );
  
  res.json({ 
    evaluation, 
    questions: questions.rows,
    hasSubmitted: submission.rows.length > 0,
    previousScore: submission.rows[0]?.score
  });
}));

app.post("/api/lessons/:id/submit", auth(["student"]), asyncHandler(async (req, res) => {
  const { answers } = req.body;
  
  const evaluationResult = await pool.query(
    "SELECT * FROM evaluations WHERE lesson_id = $1",
    [req.params.id]
  );
  
  if (evaluationResult.rows.length === 0) {
    return res.status(404).json({ message: "Aucune évaluation disponible" });
  }
  
  const evaluation = evaluationResult.rows[0];
  const questions = await pool.query(
    "SELECT * FROM questions WHERE evaluation_id = $1",
    [evaluation.id]
  );
  
  let total = 0;
  let earned = 0;
  let correctCount = 0;
  
  for (const q of questions.rows) {
    total += q.points;
    if (answers && answers[q.id] === q.correct_option) {
      earned += q.points;
      correctCount++;
    }
  }
  
  const score = total > 0 ? Math.round((earned / total) * 100) : 0;
  const passed = score >= evaluation.pass_score;
  
  await pool.query(
    `INSERT INTO submissions (user_id, lesson_id, evaluation_id, score, answers)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (user_id, lesson_id)
     DO UPDATE SET score = EXCLUDED.score, answers = EXCLUDED.answers, submitted_at = CURRENT_TIMESTAMP`,
    [req.user.id, req.params.id, evaluation.id, score, JSON.stringify(answers || {})]
  );
  
  const lessonResult = await pool.query(
    "SELECT course_id FROM lessons WHERE id = $1",
    [req.params.id]
  );
  const courseId = lessonResult.rows[0].course_id;
  
  const progressResult = await pool.query(
    `SELECT 
       COUNT(l.id) AS total_lessons,
       COUNT(s.id) AS completed_lessons,
       AVG(s.score) AS avg_score
     FROM lessons l
     LEFT JOIN submissions s ON s.lesson_id = l.id AND s.user_id = $1
     WHERE l.course_id = $2`,
    [req.user.id, courseId]
  );
  
  const totalLessons = parseInt(progressResult.rows[0].total_lessons);
  const completedLessons = parseInt(progressResult.rows[0].completed_lessons);
  const avgScore = parseFloat(progressResult.rows[0].avg_score) || 0;
  const progress = (completedLessons / totalLessons) * 100;
  
  await pool.query(
    `UPDATE enrollments 
     SET progress = $1
     WHERE user_id = $2 AND course_id = $3`,
    [progress, req.user.id, courseId]
  );
  
  res.json({ 
    score, 
    passed,
    correctCount,
    totalQuestions: questions.rows.length,
    message: passed ? "Félicitations ! Vous avez validé cette leçon." : "Vous n'avez pas atteint le score requis. Réessayez !"
  });
}));

// Progress
app.get("/api/progress", auth(["student"]), asyncHandler(async (req, res) => {
  const progress = await pool.query(
    `SELECT c.id AS course_id, c.title AS course_title, 
     m.id AS module_id, m.title AS module_title,
     COUNT(DISTINCT l.id) AS lesson_count,
     COUNT(DISTINCT s.id) AS completed_lessons,
     COALESCE(ROUND(AVG(s.score), 2), 0) AS average_score,
     e.progress,
     CASE WHEN e.progress = 100 THEN true ELSE false END AS completed
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     JOIN modules m ON m.id = c.module_id
     LEFT JOIN lessons l ON l.course_id = c.id
     LEFT JOIN submissions s ON s.lesson_id = l.id AND s.user_id = e.user_id
     WHERE e.user_id = $1
     GROUP BY c.id, m.id, e.progress
     ORDER BY e.created_at DESC`,
    [req.user.id]
  );
  
  for (const p of progress.rows) {
    const moduleResult = await pool.query(
      `SELECT 
         COUNT(DISTINCT c2.id) AS total_courses,
         SUM(CASE WHEN e2.progress = 100 THEN 1 ELSE 0 END) AS completed_courses
       FROM courses c2
       JOIN enrollments e2 ON e2.course_id = c2.id
       WHERE c2.module_id = $1 AND e2.user_id = $2`,
      [p.module_id, req.user.id]
    );
    
    p.module_progress = (moduleResult.rows[0].completed_courses / moduleResult.rows[0].total_courses) * 100;
  }
  
  res.json(progress.rows);
}));

// Certificates
app.post("/api/modules/:id/certificate", auth(["student"]), asyncHandler(async (req, res) => {
  const moduleId = req.params.id;
  
  const moduleResult = await pool.query(
    "SELECT * FROM modules WHERE id = $1",
    [moduleId]
  );
  
  if (moduleResult.rows.length === 0) {
    return res.status(404).json({ message: "Module introuvable" });
  }
  
  const module = moduleResult.rows[0];
  
  const stats = await pool.query(
    `SELECT 
       COUNT(DISTINCT c.id) AS total_courses,
       COUNT(DISTINCT CASE WHEN e.progress = 100 THEN c.id END) AS completed_courses,
       COALESCE(ROUND(AVG(e.progress), 2), 0) AS avg_progress
     FROM courses c
     LEFT JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
     WHERE c.module_id = $2`,
    [req.user.id, moduleId]
  );
  
  const result = stats.rows[0];
  
  if (parseInt(result.completed_courses) < parseInt(result.total_courses)) {
    return res.status(400).json({ 
      message: `Vous devez valider tous les cours du module (${result.completed_courses}/${result.total_courses} complétés)` 
    });
  }
  
  const avgScoreResult = await pool.query(
    `SELECT AVG(s.score) AS avg_score
     FROM submissions s
     JOIN lessons l ON l.id = s.lesson_id
     JOIN courses c ON c.id = l.course_id
     WHERE s.user_id = $1 AND c.module_id = $2`,
    [req.user.id, moduleId]
  );
  
  const avgScore = parseFloat(avgScoreResult.rows[0].avg_score) || 0;
  
  if (avgScore < module.certificate_threshold) {
    return res.status(400).json({ 
      message: `Votre moyenne (${avgScore}%) est inférieure au seuil requis (${module.certificate_threshold}%)` 
    });
  }
  
  const code = `BRAIN-${moduleId}-${req.user.id}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  
  await pool.query(
    `INSERT INTO certificates (user_id, module_id, certificate_code, average_score)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, module_id) 
     DO UPDATE SET average_score = EXCLUDED.average_score`,
    [req.user.id, moduleId, code, avgScore]
  );
  
  const certificate = await pool.query(
    `SELECT cert.*, m.title AS module_title, m.level, u.name AS student_name
     FROM certificates cert
     JOIN modules m ON m.id = cert.module_id
     JOIN users u ON u.id = cert.user_id
     WHERE cert.user_id = $1 AND cert.module_id = $2`,
    [req.user.id, moduleId]
  );
  
  res.json(certificate.rows[0]);
}));

app.get("/api/certificates", auth(), asyncHandler(async (req, res) => {
  const query_text = `
    SELECT cert.*, m.title AS module_title, m.level, u.name AS student_name,
     m.certificate_threshold
     FROM certificates cert
     JOIN modules m ON m.id = cert.module_id
     JOIN users u ON u.id = cert.user_id
     ${req.user.role === "student" ? "WHERE cert.user_id = $1" : ""}
     ORDER BY cert.issued_at DESC
  `;
  
  const params = req.user.role === "student" ? [req.user.id] : [];
  const certificates = await pool.query(query_text, params);
  res.json(certificates.rows);
}));

// Statistics
app.get("/api/statistics", auth(["promoter"]), asyncHandler(async (req, res) => {
  const stats = await pool.query(`
    SELECT 
      (SELECT COUNT(*) FROM users WHERE role = 'student') AS total_students,
      (SELECT COUNT(*) FROM users WHERE role = 'teacher') AS total_teachers,
      (SELECT COUNT(*) FROM modules) AS total_modules,
      (SELECT COUNT(*) FROM courses) AS total_courses,
      (SELECT COUNT(*) FROM lessons) AS total_lessons,
      (SELECT COUNT(*) FROM certificates) AS total_certificates,
      (SELECT ROUND(AVG(progress), 2) FROM enrollments) AS avg_progress,
      (SELECT COUNT(*) FROM submissions WHERE score >= 60) AS passed_evaluations
  `);
  
  const topModules = await pool.query(`
    SELECT m.title, COUNT(DISTINCT cert.id) AS certificates_issued
    FROM modules m
    LEFT JOIN certificates cert ON cert.module_id = m.id
    GROUP BY m.id
    ORDER BY certificates_issued DESC
    LIMIT 5
  `);
  
  res.json({
    overview: stats.rows[0],
    topModules: topModules.rows
  });
}));

// Health check
app.get("/api/health", asyncHandler(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ 
    ok: true, 
    status: "running",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development"
  });
}));

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Error handler
app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  
  if (err.code === "23505") {
    return res.status(409).json({ message: "Cette donnée existe déjà" });
  }
  
  res.status(500).json({ 
    message: process.env.NODE_ENV === "production" 
      ? "Erreur interne du serveur" 
      : err.message 
  });
});

// Start server
async function start() {
  try {
    console.log("=".repeat(50));
    console.log("🧠 BRAIN VISION LMS v2.0");
    console.log("=".repeat(50));
    
    await fs.mkdir(PUBLIC_DIR, { recursive: true });
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    console.log("✅ Dossiers créés");
    
    await pool.connect();
    console.log("✅ PostgreSQL connecté");
    
    await initDatabase();
    
    if (process.env.AUTO_SEED === "true" || !process.env.AUTO_SEED) {
      await seedDemo();
    }
    
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`\n🚀 Serveur démarré sur http://localhost:${PORT}`);
      console.log("\n📝 Comptes de démonstration:");
      console.log("   👑 Promoteur: promoter@brain-vision.com / password123");
      console.log("   👨‍🏫 Enseignant: teacher@brain-vision.com / password123");
      console.log("   👨‍🎓 Étudiant: student@brain-vision.com / password123");
    });
    
  } catch (error) {
    console.error("❌ Erreur au démarrage:", error.message);
    process.exit(1);
  }
}

start();
