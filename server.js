const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fsp = require('fs/promises');
const archiver = require('archiver');
const { BlobServiceClient } = require('@azure/storage-blob');
const mime = require('mime-types');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const port = process.env.PORT || 3000;

// Anthropic Claude API setup
const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/preview', express.static(path.join(__dirname, 'generated-site')));

/**
 * ------------------ ROUTE 1: Detect intent from Tamil text ------------------
 */
app.post('/intent', async (req, res) => {
  const { tamilText } = req.body;

  if (!tamilText || tamilText.trim() === '') {
    return res
      .status(400)
      .json({ success: false, error: 'Tamil text is required' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 100,
      temperature: 0.4,
      system:
        'You are an assistant that understands Tamil and converts spoken Tamil into a detailed website intent in English. Always elaborate dynamically, include possible features, sections, and describe the purpose of the site in multiple sentences.',
      messages: [
        {
          role: 'user',
          content: `Tamil Input: "${tamilText}". What kind of website does the user want?`,
        },
      ],
    });

    // ✅ Correct way to extract text
    const intent = response.content[0].text.trim();

    console.log('📝 Tamil Text:', tamilText);
    console.log('🎯 Intent:', intent);

    res.json({ success: true, intent });
  } catch (error) {
    console.error('❌ Claude intent error:', error);
    res.status(500).json({ success: false, error: 'Intent detection failed' });
  }
});

/**
 * ------------------ ROUTE 2: Generate website code ------------------
 */
app.post('/generate-code', async (req, res) => {
  const { intent } = req.body;

  if (!intent || intent.trim() === '') {
    return res
      .status(400)
      .json({ success: false, error: 'Intent is required to generate code.' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-1-20250805',
      max_tokens: 3000,
      temperature: 0.4,
      system:
        'You are a coding assistant that generates complete, production-ready multi-file websites.',
      messages: [
        {
          role: 'user',
          content: `You are a coding assistant that generates complete, production-ready multi-file websites based on the user's intent. 

Always:
- Produce professional, responsive HTML using Tailwind CSS via CDN (never use PostCSS or @import).
- Include:
  - index.html with multiple sections 
  - style.css for extra custom styles
  - script.js for interactivity (smooth scroll, animations, etc.)
  - server.js using Express to serve static files
  - package.json with correct dependencies and a start script
- Replace any contact form with a Team Section:
  - At least 5 members
  - Each member must use a unique image:
    - Use https://picsum.photos/800/600?random=1, ?random=2, etc.
    - Or https://via.placeholder.com/800x600 for placeholders
  - Include alt text, name, role, and bio
  - Tailwind classes: object-cover rounded-lg mb-4 w-full h-64
  - Responsive grid: 1 col mobile, 2 cols tablet, 3 cols desktop
- Fill all sections with relevant sample content
- Add a fixed navbar with smooth scrolling
- Do not use React or build tools unless explicitly asked
- Keep filenames consistent

⚠️ Output all files in this exact order with no extra commentary:

--- index.html ---
<code>
--- style.css ---
<code>
--- script.js ---
<code>
--- server.js ---
<code>
--- package.json ---
<code>

Intent: ${intent}
Generate the full code for ALL the files listed above(index.html, style.css, script.js, server.js, package.json).
          `,
        },
      ],
    });

    // ✅ Extract full generated code
    const gptOutput = response.content[0].text;
    console.log('📦 Claude Code Output:\n', gptOutput);

    // Parse files from Claude output
    const files = {};
    const regex =
      /---\s*([\w.\-]+)\s*---\s*\n([\s\S]*?)(?=(---\s*[\w.\-]+\s*---|$))/g;

    let match;
    while ((match = regex.exec(gptOutput)) !== null) {
      const filename = match[1].trim();
      let content = match[2].trim();
      if (content.startsWith('```')) {
        content = content
          .replace(/^```[a-z]*\n?/i, '')
          .replace(/```$/, '')
          .trim();
      }
      files[filename] = content;
    }

    const folderPath = path.join(__dirname, 'generated-site');
    await fsp.rm(folderPath, { recursive: true, force: true });
    await fsp.mkdir(folderPath);

    for (const [filename, content] of Object.entries(files)) {
      const filePath = path.join(folderPath, filename);
      await fsp.writeFile(filePath, content, 'utf-8');
    }

    res.json({
      success: true,
      message: 'Code generated and saved',
      files: Object.keys(files),
    });
  } catch (error) {
    console.error('❌ Code generation error:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to generate project code' });
  }
});

/**
 * ------------------ DOWNLOAD GENERATED ZIP ------------------
 */
app.get('/download', async (req, res) => {
  const folderPath = path.join(__dirname, 'generated-site');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename=generated-site.zip'
  );

  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('error', (err) => {
    console.error('❌ Archive error:', err);
    res.status(500).send({ error: 'Could not create archive' });
  });

  archive.pipe(res);
  archive.directory(folderPath, false);

  await archive.finalize();
});



app.post('/save-edits', async (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ message: 'Filename and content required' });
  try {
    const filePath = path.join(__dirname, 'generated-site', filename);
    await fsp.writeFile(filePath, content, 'utf-8');
    res.json({ message: '✅ Edits saved successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '❌ Failed to save edits' });
  }
});

app.post('/deploy', async (req, res) => {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING
    );

    const containerName = '$web';
    const containerClient = blobServiceClient.getContainerClient(containerName);

    if (!(await containerClient.exists())) {
      await blobServiceClient.createContainer(containerName, { access: 'container' });
    }

    // 1️⃣ Generate unique site folder
    const siteId = `site-${Date.now()}`;
    const prefix = `${siteId}/`;

    // 2️⃣ Upload all generated files into unique folder
    const siteDir = path.join(__dirname, 'generated-site');
    const files = await fsp.readdir(siteDir);

    for (const filename of files) {
      const filePath = path.join(siteDir, filename);
      const content = await fsp.readFile(filePath);
      const blockBlobClient = containerClient.getBlockBlobClient(prefix + filename);

      const contentType = mime.lookup(filename) || 'application/octet-stream';
      const cacheControl = filename === 'index.html' ? 'no-cache' : 'public, max-age=3600';

      await blockBlobClient.upload(content, content.length, {
        blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: cacheControl },
        overwrite: true
      });
    }

    // 3️⃣ Update or create sites.json
    const sitesFile = 'sites.json';
    let sites = [];

    try {
      const existingBlob = containerClient.getBlockBlobClient(sitesFile);
      if (await existingBlob.exists()) {
        const download = await existingBlob.downloadToBuffer();
        sites = JSON.parse(download.toString());
      }
    } catch (err) {
      console.log('ℹ️ No existing sites.json, creating a new one');
    }

    const newSite = {
      id: siteId,
      url: `${process.env.STATIC_SITE_URL}/${siteId}/index.html`
    };
    sites.push(newSite);

    const blockBlobClient = containerClient.getBlockBlobClient(sitesFile);
    const sitesContent = JSON.stringify(sites, null, 2);
    await blockBlobClient.upload(
      Buffer.from(sitesContent),
      Buffer.byteLength(sitesContent),
      { overwrite: true }
    );

    // 4️⃣ Return only the latest site URL
    res.json({
      success: true,
      message: '✅ Website deployed successfully!',
      url: newSite.url
    });

  } catch (err) {
    console.error('❌ Deploy error:', err);
    res.status(500).json({
      success: false,
      message: '❌ Failed to deploy site',
      error: err.message
    });
  }
});


app.listen(port, () => {
  console.log(`🚀 Server running at: http://localhost:${port}`);
});
