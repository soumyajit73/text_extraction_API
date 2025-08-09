import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import multer from "multer";
import fetch from "node-fetch";
import dotenv from "dotenv";
import pdfParse from "pdf-parse";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());

// Fix __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create data directory structure
const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(dataDir, "uploads");

// Ensure directories exist
[dataDir, uploadsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Multer config with disk storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, `${Date.now()}-${sanitizedName}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed!"), false);
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Serve static files from frontend folder
app.use(express.static(path.join(__dirname, "..", "frontend")));

// Root route serves index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Protected route with Clerk
app.get("/protected", ClerkExpressRequireAuth(), (req, res) => {
  res.json({ message: "You are authenticated!", userId: req.auth.userId });
});

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_ENDPOINT =
  "https://api.groq.com/openai/v1/chat/completions";

// Error handler
const errorHandler = (err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({
    error: "Something went wrong!",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Internal server error",
    path: err.path,
  });
};


// Process PDF
app.post("/api/process", upload.single("file"), async (req, res, next) => {
  let filePath = null;
  try {
    // If no file uploaded, use the default pdf-parse test file
    if (!req.file) {
      console.log("No file uploaded, using default test PDF...");
      filePath = path.join(
        __dirname,
        "node_modules",
        "pdf-parse",
        "test",
        "data",
        "05-versions-space.pdf"
      );
    } else {
      filePath = path.resolve(req.file.path);
      console.log("Processing uploaded PDF:", filePath);
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const prompt = req.body.prompt || "No prompt provided";
    const pdfBuffer = await fs.promises.readFile(filePath);
    const pdfData = await pdfParse(pdfBuffer);
    const resumeText = pdfData.text;

    // Delete uploaded file if it exists and isn't the default
    if (req.file) {
      try {
        await fs.promises.unlink(filePath);
        console.log("Deleted uploaded file:", filePath);
      } catch (unlinkError) {
        console.error("Error deleting file:", unlinkError);
      }
    }

    const combinedPrompt = `Here is the resume text:\n${resumeText}\n\nUser's question:\n${prompt}`;

    const requestBody = {
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: combinedPrompt }],
      temperature: 0.7,
      max_completion_tokens: 1024,
      top_p: 1,
      stream: false,
      stop: null,
    };

   
    console.log(" Sending request to Groq API with model:", requestBody.model);

    const groqResponse = await fetch(GROQ_API_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      console.error("Groq API Error:", errorText);
      return res
        .status(groqResponse.status)
        .json({ error: "API Error", details: errorText });
    }

    const data = await groqResponse.json();

    
    console.log(" Full Groq API Response:", JSON.stringify(data, null, 2));

    const outputText = data.choices?.[0]?.message?.content;
    console.log(" Extracted Output Text:", outputText); 

    if (!outputText) throw new Error("Invalid response from Groq API");

    res.json({ success: true, output: outputText });
  } catch (error) {
    if (req.file && fs.existsSync(filePath)) {
      try {
        await fs.promises.unlink(filePath);
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }
    }
    next(error);
  }
});


app.use(errorHandler);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Uploads directory: ${uploadsDir}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server");
  server.close(() => process.exit(0));
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  server.close(() => process.exit(1));
});
