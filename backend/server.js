import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs/promises";
import fetch from "node-fetch";
import FormData from "form-data";

dotenv.config();

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Folders ----------
const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(dataDir, "uploads");

(async () => {
  await fs.mkdir(uploadsDir, { recursive: true });
  console.log("📂 Directories ready:", uploadsDir);
})().catch((e) => console.error("Dir init error:", e));

// ---------- Multer ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only image and PDF files are allowed."), false);
  },
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- Static Frontend ----------
app.use(express.static(path.join(__dirname, "..", "frontend")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// ---------- LlamaParse HTTP API Functions ----------
const uploadFileToLlamaParse = async (filePath, fileName) => {
  try {
    const formData = new FormData();
    const fileBuffer = await fs.readFile(filePath);
    
    formData.append('file', fileBuffer, fileName);
    formData.append('parse_mode', 'parse_page_with_agent');
    formData.append('model', 'openai-gpt-4-1-mini');
    formData.append('high_res_ocr', 'true');
    formData.append('adaptive_long_table', 'true');
    formData.append('outlined_table_extraction', 'true');
    formData.append('output_tables_as_HTML', 'true');
    formData.append('page_separator', '\n\n---\n\n');

    const response = await fetch('https://api.cloud.llamaindex.ai/api/v1/parsing/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LLAMA_CLOUD_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData,
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Upload failed (${response.status}): ${responseText}`);
    }

    const result = JSON.parse(responseText);
    console.log('File uploaded successfully. Job ID:', result.id);
    return result.id;
  } catch (error) {
    console.error('Upload error:', error);
    throw error;
  }
};

const pollForResult = async (jobId) => {
  const maxAttempts = 60; // 5 minutes max wait
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    
    console.log(`Polling for job ${jobId} - Attempt ${attempts + 1}/${maxAttempts}`);
    
    const response = await fetch(`https://api.cloud.llamaindex.ai/api/v1/parsing/job/${jobId}/result/markdown`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.LLAMA_CLOUD_API_KEY}`,
      },
    });

    if (response.ok) {
      const result = await response.json();
      console.log('Parsing completed!');
      return result.markdown;
    } else if (response.status === 400) {
      const error = await response.json();
      if (error.detail === 'Job not completed yet') {
        attempts++;
        continue;
      } else {
        throw new Error(`Error: ${JSON.stringify(error)}`);
      }
    } else {
      const errorText = await response.text();
      throw new Error(`Error checking job status (${response.status}): ${errorText}`);
    }
  }
  
  throw new Error('Parsing timeout - job took too long to complete');
};

// ---------- Error handler ----------
const errorHandler = (err, _req, res, _next) => {
  console.error("❌ Error:", err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: err.message || "Internal Server Error" });
};

// ---------- Main API ----------
app.post("/api/process", upload.single("file"), async (req, res, next) => {
  let filePath;
  try {
    const prompt = req.body?.prompt?.toString?.().trim();
    const file = req.file;
    filePath = file?.path;

    if (!file) throw new Error("No file uploaded.");
    if (!prompt) throw new Error("No prompt provided.");

    // Check if API keys are set
    if (!process.env.LLAMA_CLOUD_API_KEY) {
      throw new Error("LLAMA_CLOUD_API_KEY is not set in environment variables");
    }
    if (!process.env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is not set in environment variables");
    }

    // Upload file to LlamaParse and get job ID
    const jobId = await uploadFileToLlamaParse(filePath, file.originalname);
    
    // Poll for results
    const parsedContent = await pollForResult(jobId);

    if (!parsedContent) throw new Error("No content returned by LlamaParse.");

    // Truncate content if too long (Groq has token limits)
    const maxContentLength = 10000;
    const truncatedContent = parsedContent.length > maxContentLength 
      ? parsedContent.substring(0, maxContentLength) + "... [content truncated]"
      : parsedContent;

    console.log('Sending to Groq...');

    // Send to Groq
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: `Instruction: '${prompt}'\n\nContent:\n${truncatedContent}` },
    ];

    const groqResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({ 
        model: "llama3-70b-8192", 
        messages, 
        temperature: 0, 
        max_tokens: 2048 
      }),
    });

    const groqResponseText = await groqResp.text();
    
    if (!groqResp.ok) {
      throw new Error(`Groq API error (${groqResp.status}): ${groqResponseText}`);
    }

    const data = JSON.parse(groqResponseText);
    const outputText = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";

    if (!outputText) {
      throw new Error("No output text received from Groq");
    }

    // Cleanup
    if (filePath) {
      try {
        await fs.unlink(filePath);
      } catch (e) {
        console.error('File cleanup error:', e);
      }
    }

    // Return JSON response
    res.json({
      success: true,
      output: outputText
    });

  } catch (err) {
    // Return error as JSON
    console.error("Processing error:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  } finally {
    // Ensure file cleanup even if there's an error
    if (filePath) {
      try { 
        await fs.unlink(filePath); 
      } catch (e) {
        // Silent fail - file might already be deleted
      }
    }
  }
});

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));