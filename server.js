require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID: uuidv4 } = require('crypto');
const { exec } = require('child_process');
const OpenAI = require('openai');
const Datastore = require('nedb-promises');

const app = express();
const PORT = process.env.PORT || 3737;

// --- Database setup ---
const db = {
  projects: Datastore.create({ filename: path.join(__dirname, 'data/projects.db'), autoload: true }),
  details:  Datastore.create({ filename: path.join(__dirname, 'data/details.db'),  autoload: true }),
};

// --- OpenAI ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Storage ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'pdfs');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}.pdf`),
});
const upload = multer({ storage, fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf') });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ============================================================
// PROJECTS
// ============================================================
app.get('/api/projects', async (req, res) => {
  const projects = await db.projects.find({}).sort({ createdAt: -1 });
  res.json(projects);
});

app.post('/api/projects', async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const project = await db.projects.insert({ name, description: description || '', createdAt: new Date() });
  res.json(project);
});

app.delete('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  // Delete all details + images for this project
  const details = await db.details.find({ projectId: id });
  for (const d of details) {
    if (d.imagePath && fs.existsSync(path.join(__dirname, d.imagePath))) {
      fs.unlinkSync(path.join(__dirname, d.imagePath));
    }
  }
  await db.details.remove({ projectId: id }, { multi: true });
  await db.projects.remove({ _id: id }, {});
  res.json({ ok: true });
});

// ============================================================
// UPLOAD & PROCESS PDF
// ============================================================
app.post('/api/projects/:id/upload', upload.single('pdf'), async (req, res) => {
  const { id } = req.params;
  const project = await db.projects.findOne({ _id: id });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

  const pdfPath = req.file.path;
  const pdfId = path.basename(pdfPath, '.pdf');
  const imgDir = path.join(__dirname, 'uploads', 'pages', pdfId);
  fs.mkdirSync(imgDir, { recursive: true });

  // Convert PDF pages to images using pdftoppm
  const convertCmd = `pdftoppm -r 150 -png "${pdfPath}" "${path.join(imgDir, 'page')}"`;

  exec(convertCmd, async (err) => {
    if (err) {
      console.error('pdftoppm error:', err);
      return res.status(500).json({ error: 'PDF conversion failed' });
    }

    const pageFiles = fs.readdirSync(imgDir)
      .filter(f => f.endsWith('.png'))
      .sort();

    if (pageFiles.length === 0) {
      return res.status(500).json({ error: 'No pages extracted from PDF' });
    }

    // Start async processing - respond immediately
    res.json({ ok: true, pages: pageFiles.length, message: 'Processing started' });

    // Process each page with OpenAI Vision
    for (let i = 0; i < pageFiles.length; i++) {
      const pageFile = pageFiles[i];
      const imgPath = path.join(imgDir, pageFile);
      const relImgPath = path.join('uploads', 'pages', pdfId, pageFile);

      try {
        const imageData = fs.readFileSync(imgPath);
        const base64 = imageData.toString('base64');

        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are analyzing a construction detail sheet image. This sheet may contain one or more architectural/structural details.

Please analyze this image and respond with a JSON object (no markdown, just raw JSON) with these fields:
{
  "sheetTitle": "overall sheet title or number if visible",
  "detailCount": number of distinct details visible,
  "details": [
    {
      "title": "detail title or reference number",
      "description": "thorough description of what this detail shows - construction elements, connections, materials, dimensions if visible",
      "keywords": ["array", "of", "searchable", "keywords"],
      "location": "where on the sheet this detail appears: full-sheet | top-left | top-right | top-center | bottom-left | bottom-right | bottom-center | center | left | right"
    }
  ],
  "generalKeywords": ["keywords that apply to the overall sheet"],
  "overallSummary": "1-2 sentence summary of what this sheet contains"
}`
              },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${base64}`, detail: 'high' }
              }
            ]
          }]
        });

        let analysisText = response.choices[0].message.content.trim();
        // Strip markdown code fences if present
        analysisText = analysisText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

        let analysis;
        try {
          analysis = JSON.parse(analysisText);
        } catch (e) {
          analysis = {
            sheetTitle: `Page ${i + 1}`,
            detailCount: 1,
            details: [{ title: 'Unknown', description: analysisText, keywords: [], location: 'full-sheet' }],
            generalKeywords: [],
            overallSummary: analysisText.substring(0, 200)
          };
        }

        // Build a combined keyword/description blob for searching
        const allKeywords = [
          ...analysis.generalKeywords,
          ...analysis.details.flatMap(d => [...d.keywords, d.title, d.description])
        ].join(' ').toLowerCase();

        await db.details.insert({
          projectId: id,
          projectName: project.name,
          pdfId,
          pdfName: req.file.originalname,
          pageNumber: i + 1,
          imagePath: relImgPath,
          sheetTitle: analysis.sheetTitle || `Page ${i + 1}`,
          detailCount: analysis.detailCount || 1,
          details: analysis.details || [],
          generalKeywords: analysis.generalKeywords || [],
          overallSummary: analysis.overallSummary || '',
          searchIndex: allKeywords,
          createdAt: new Date(),
          status: 'indexed'
        });

        console.log(`  Indexed page ${i + 1}/${pageFiles.length} of ${req.file.originalname}`);

      } catch (aiErr) {
        console.error(`Error processing page ${i + 1}:`, aiErr.message);
        await db.details.insert({
          projectId: id,
          pdfId,
          pdfName: req.file.originalname,
          pageNumber: i + 1,
          imagePath: relImgPath,
          sheetTitle: `Page ${i + 1}`,
          detailCount: 0,
          details: [],
          generalKeywords: [],
          overallSummary: 'Processing failed',
          searchIndex: '',
          createdAt: new Date(),
          status: 'error'
        });
      }
    }

    console.log(`Done processing ${req.file.originalname}`);
  });
});

// ============================================================
// SEARCH
// ============================================================
app.get('/api/search', async (req, res) => {
  const { q, projectId } = req.query;
  if (!q) return res.json([]);

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const query = projectId ? { projectId, status: 'indexed' } : { status: 'indexed' };
  const allDocs = await db.details.find(query);

  // Score each doc by how many terms appear in searchIndex
  const scored = allDocs
    .map(doc => {
      const idx = doc.searchIndex || '';
      let score = 0;
      for (const term of terms) {
        // Count occurrences for weighting
        const matches = (idx.match(new RegExp(term, 'gi')) || []).length;
        score += matches;
      }
      return { doc, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ doc, score }) => ({ ...doc, relevanceScore: score }));

  res.json(scored);
});

// ============================================================
// DETAILS - list by project
// ============================================================
app.get('/api/projects/:id/details', async (req, res) => {
  const details = await db.details.find({ projectId: req.params.id }).sort({ createdAt: 1 });
  res.json(details);
});

app.delete('/api/details/:id', async (req, res) => {
  const detail = await db.details.findOne({ _id: req.params.id });
  if (detail && detail.imagePath) {
    const full = path.join(__dirname, detail.imagePath);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
  await db.details.remove({ _id: req.params.id }, {});
  res.json({ ok: true });
});

// Processing status check
app.get('/api/projects/:id/status', async (req, res) => {
  const total = await db.details.count({ projectId: req.params.id });
  const indexed = await db.details.count({ projectId: req.params.id, status: 'indexed' });
  const errors = await db.details.count({ projectId: req.params.id, status: 'error' });
  res.json({ total, indexed, errors, processing: total - indexed - errors });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Detail Search running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} or http://<pi-ip>:${PORT}`);
});
