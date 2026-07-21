// src/routes/ai.ts
//
// All AI endpoints. Every request must carry a valid JWT.
// The usage tracker enforces per-tier daily limits.

import { Router, Request, Response } from "express";
import { z } from "zod";
import multer from "multer";
import { requireAuth } from "../middleware/auth";
import { usageTracker } from "../services/usageTracker";
import {
  extractProblem,
  generateSolution,
  debugSolution,
  transcribeAudio,
  generateAnswerSuggestions,
  solveQuiz,
} from "../services/aiService";

// ── Multipart upload middleware ───────────────────────────────────────────────
// Files are held in memory as Buffers and converted to base64 before being
// forwarded to the AI services — no disk writes, no changes to aiService.ts.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are accepted"));
      return;
    }
    cb(null, true);
  },
});

function filesToBase64(files: Express.Multer.File[]): string[] {
  return files.map((f) => f.buffer.toString("base64"));
}

const router = Router();

// All routes under /api/ai require a valid JWT
router.use(requireAuth);

// ── helpers ───────────────────────────────────────────────────────────────────

async function limitCheck(req: Request, res: Response): Promise<boolean> {
  const user = req.user!;
  const canUse = await usageTracker.canUse(user.userId, user.tier);

  if (!canUse) {
    const summary = await usageTracker.summary(user.userId, user.tier);
    res.status(429).json({
      error: `Daily limit reached for your ${user.tier} plan (${summary.limit}/day). Upgrade to continue.`,
      usage: summary,
    });
    return false;
  }

  return true;
}

// ── POST /api/ai/extract ──────────────────────────────────────────────────────
// Step 1: Send screenshots → get structured problem info back

const extractSchema = z.object({
  images: z.array(z.string().min(1)).min(1).max(5),
  language: z.string().default("python"),
  provider: z.enum(["openai", "gemini", "anthropic"]).default("openai"),
  extractionModel: z.string().default("gpt-5.4-mini"),
  conversationContext: z.string().optional(),
});

router.post("/extract", async (req: Request, res: Response) => {
  if (!(await limitCheck(req, res))) return;

  const parsed = extractSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { images, language, provider, extractionModel, conversationContext } = parsed.data;

  console.log(`[AI] /extract request`, {
    userId: req.user?.userId,
    provider,
    imageCount: images.length,
    language,
    conversationContextLength: conversationContext?.length || 0,
  });

  try {
    const startedAt = Date.now();
    const problemInfo = await extractProblem(
      images,
      language,
      provider,
      extractionModel,
      conversationContext
    );

    console.log(`[AI] /extract completed in ${Date.now() - startedAt}ms`, {
      userId: req.user?.userId,
      provider,
      extractionModel,
    });

    // Don't increment here — extraction is free, solution generation costs a credit
    res.json({ success: true, problemInfo });
  } catch (err: unknown) {
    console.error("[/extract]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/ai/solve ────────────────────────────────────────────────────────
// Step 2: Send problem info → get solution back (costs 1 credit)

const solveSchema = z.object({
  problemInfo: z.object({
    problem_statement: z.string(),
    constraints: z.string().optional(),
    example_input: z.string().optional(),
    example_output: z.string().optional(),
  }),
  language: z.string().default("python"),
  provider: z.enum(["openai", "gemini", "anthropic"]),
  solutionModel: z.string(),
});

router.post("/solve", async (req: Request, res: Response) => {
  if (!(await limitCheck(req, res))) return;

  const parsed = solveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { problemInfo, language, provider, solutionModel } = parsed.data;

  console.log(`[AI] /solve request`, {
    userId: req.user?.userId,
    provider,
    language,
    problemLength: problemInfo.problem_statement?.length || 0,
  });

  try {
    const startedAt = Date.now();
    const solution = await generateSolution(problemInfo, language, provider, solutionModel);

    console.log(`[AI] /solve completed in ${Date.now() - startedAt}ms`, {
      userId: req.user?.userId,
      provider,
    });

    // Increment after a successful generation
    await usageTracker.increment(req.user!.userId);
    const usage = await usageTracker.summary(req.user!.userId, req.user!.tier);

    res.json({ success: true, solution, usage });
  } catch (err: unknown) {
    console.error("[/solve]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/ai/process ─────────────────────────────────────────────────────
// Combined: extract + solve in one round trip (costs 1 credit)

const processSchema = z.object({
  images: z.array(z.string().min(1)).min(1).max(5),
  language: z.string().default("python"),
  provider: z.enum(["openai", "gemini", "anthropic"]).default("openai"),
  extractionModel: z.string().default("gpt-5.4-mini"),
  solutionModel: z.string().default("gpt-5.4-mini"),
  conversationContext: z.string().optional(),
});

router.post("/process", async (req: Request, res: Response) => {
  if (!(await limitCheck(req, res))) return;

  const parsed = processSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { images, language, provider, extractionModel, solutionModel, conversationContext } =
    parsed.data;

  try {
    const problemInfo = await extractProblem(
      images,
      language,
      provider,
      extractionModel,
      conversationContext
    );

    const solution = await generateSolution(problemInfo, language, provider, solutionModel);

    await usageTracker.increment(req.user!.userId);
    const usage = await usageTracker.summary(req.user!.userId, req.user!.tier);

    res.json({ success: true, problemInfo, solution, usage });
  } catch (err: unknown) {
    console.error("[/process]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/ai/debug ────────────────────────────────────────────────────────
// Debug mode: screenshots of error/output → debugging analysis (costs 1 credit)

const debugSchema = z.object({
  images: z.array(z.string().min(1)).min(1).max(10),
  problemStatement: z.string(),
  language: z.string().default("python"),
  provider: z.enum(["openai", "gemini", "anthropic"]),
  debuggingModel: z.string(),
});

router.post("/debug", async (req: Request, res: Response) => {
  if (!(await limitCheck(req, res))) return;

  const parsed = debugSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { images, problemStatement, language, provider, debuggingModel } = parsed.data;

  try {
    const result = await debugSolution(
      images,
      problemStatement,
      language,
      provider,
      debuggingModel
    );

    await usageTracker.increment(req.user!.userId);
    const usage = await usageTracker.summary(req.user!.userId, req.user!.tier);

    res.json({ success: true, result, usage });
  } catch (err: unknown) {
    console.error("[/debug]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/ai/transcribe ───────────────────────────────────────────────────
// Audio transcription (doesn't cost a solution credit)

const transcribeSchema = z.object({
  audio: z.string().min(1),
  mimeType: z.string().default("audio/webm"),
  provider: z.enum(["openai", "gemini", "anthropic"]),
  speechRecognitionModel: z.string().optional(),
});

router.post("/transcribe", async (req: Request, res: Response) => {
  const parsed = transcribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { audio, mimeType, provider, speechRecognitionModel } = parsed.data;

  try {
    const result = await transcribeAudio(audio, mimeType, provider, speechRecognitionModel);
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    console.error("[/transcribe]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/ai/answer-suggestions ──────────────────────────────────────────
// Interview Q&A mode (doesn't cost a solution credit)

const answerSchema = z.object({
  question: z.string().min(1),
  conversationHistory: z.string().default(""),
  screenshotContext: z.string().optional(),
  candidateProfile: z
    .object({
      name: z.string().optional(),
      resume: z.string().optional(),
      jobDescription: z.string().optional(),
    })
    .optional(),
  provider: z.enum(["openai", "gemini", "anthropic"]),
  answerModel: z.string(),
});

router.post("/answer-suggestions", async (req: Request, res: Response) => {
  const parsed = answerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { question, conversationHistory, screenshotContext, candidateProfile, provider, answerModel } =
    parsed.data;

  try {
    const result = await generateAnswerSuggestions(
      question,
      conversationHistory,
      provider,
      answerModel,
      screenshotContext,
      candidateProfile
    );
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    console.error("[/answer-suggestions]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/ai/usage ────────────────────────────────────────────────────────
// Let the app show the user how many credits they have left

router.get("/usage", async (req: Request, res: Response) => {
  const user = req.user!;
  const usage = await usageTracker.summary(user.userId, user.tier);
  res.json({ success: true, usage });
});

// ── POST /api/ai/quiz ─────────────────────────────────────────────────────────
// Extract and solve all quiz questions from screenshots (costs 1 credit)

const quizSchema = z.object({
  images: z.array(z.string().min(1)).min(1).max(5),
  provider: z.enum(["openai", "gemini", "anthropic"]).default("openai"),
  extractionModel: z.string().default("gpt-4o"),
});

router.post("/quiz", async (req: Request, res: Response) => {
  if (!(await limitCheck(req, res))) return;

  const parsed = quizSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { images, provider, extractionModel } = parsed.data;

  console.log(`[AI] /quiz request`, {
    userId: req.user?.userId,
    provider,
    imageCount: images.length,
    extractionModel,
  });

  try {
    const startedAt = Date.now();
    const result = await solveQuiz(images, provider, extractionModel);

    await usageTracker.increment(req.user!.userId);
    const usage = await usageTracker.summary(req.user!.userId, req.user!.tier);

    res.json({ success: true, result, usage });
  } catch (err: unknown) {
    console.error("[/quiz]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/ai/quiz/upload ─────────────────────────────────────────────────
// Multipart alternative to /quiz — send real image files instead of base64.
// Form fields: images (1-5 files), provider, extractionModel
router.post(
  "/quiz/upload",
  upload.array("images", 5),
  async (req: Request, res: Response) => {
    if (!(await limitCheck(req, res))) return;

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: "At least one image file is required" });
      return;
    }

    const parsed = quizSchema.safeParse({
      images: filesToBase64(files),
      provider: req.body.provider,
      extractionModel: req.body.extractionModel,
    });

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const { images, provider, extractionModel } = parsed.data;

    console.log(`[AI] /quiz/upload request`, {
      userId: req.user?.userId,
      provider,
      imageCount: images.length,
      extractionModel,
    });

    try {
      const startedAt = Date.now();
      const result = await solveQuiz(images, provider, extractionModel);

      console.log(`[AI] /quiz/upload completed in ${Date.now() - startedAt}ms`, {
        userId: req.user?.userId,
        provider,
        extractionModel,
      });

      await usageTracker.increment(req.user!.userId);
      const usage = await usageTracker.summary(req.user!.userId, req.user!.tier);

      res.json({ success: true, result, usage });
    } catch (err: unknown) {
      console.error("[/quiz/upload]", err);
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

// ── POST /api/ai/extract/upload ───────────────────────────────────────────────
// Multipart alternative to /extract — send real image files instead of base64.
// Form fields: images (1-5 files), language, provider, extractionModel,
//              conversationContext (optional)

router.post(
  "/extract/upload",
  upload.array("images", 5),
  async (req: Request, res: Response) => {
    if (!(await limitCheck(req, res))) return;

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: "At least one image file is required" });
      return;
    }

    const parsed = extractSchema.safeParse({
      images: filesToBase64(files),
      language: req.body.language,
      provider: req.body.provider,
      extractionModel: req.body.extractionModel,
      conversationContext: req.body.conversationContext,
    });

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const { images, language, provider, extractionModel, conversationContext } = parsed.data;

    try {
      const problemInfo = await extractProblem(
        images,
        language,
        provider,
        extractionModel,
        conversationContext
      );
      res.json({ success: true, problemInfo });
    } catch (err: unknown) {
      console.error("[/extract/upload]", err);
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

// ── POST /api/ai/process/upload ───────────────────────────────────────────────
// Multipart alternative to /process — extract + solve in one shot (costs 1 credit).
// Form fields: images (1-5 files), language, provider, extractionModel,
//              solutionModel, conversationContext (optional)

router.post(
  "/process/upload",
  upload.array("images", 5),
  async (req: Request, res: Response) => {
    if (!(await limitCheck(req, res))) return;

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: "At least one image file is required" });
      return;
    }

    const parsed = processSchema.safeParse({
      images: filesToBase64(files),
      language: req.body.language,
      provider: req.body.provider,
      extractionModel: req.body.extractionModel,
      solutionModel: req.body.solutionModel,
      conversationContext: req.body.conversationContext,
    });

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const { images, language, provider, extractionModel, solutionModel, conversationContext } =
      parsed.data;

    try {
      const problemInfo = await extractProblem(
        images,
        language,
        provider,
        extractionModel,
        conversationContext
      );
      const solution = await generateSolution(problemInfo, language, provider, solutionModel);

      await usageTracker.increment(req.user!.userId);
      const usage = await usageTracker.summary(req.user!.userId, req.user!.tier);

      res.json({ success: true, problemInfo, solution, usage });
    } catch (err: unknown) {
      console.error("[/process/upload]", err);
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

// ── POST /api/ai/debug/upload ─────────────────────────────────────────────────
// Multipart alternative to /debug — send real image files instead of base64.
// Form fields: images (1-10 files), problemStatement, language,
//              provider, debuggingModel

router.post(
  "/debug/upload",
  upload.array("images", 10),
  async (req: Request, res: Response) => {
    if (!(await limitCheck(req, res))) return;

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: "At least one image file is required" });
      return;
    }

    const parsed = debugSchema.safeParse({
      images: filesToBase64(files),
      problemStatement: req.body.problemStatement,
      language: req.body.language,
      provider: req.body.provider,
      debuggingModel: req.body.debuggingModel,
    });

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const { images, problemStatement, language, provider, debuggingModel } = parsed.data;

    try {
      const result = await debugSolution(
        images,
        problemStatement,
        language,
        provider,
        debuggingModel
      );

      await usageTracker.increment(req.user!.userId);
      const usage = await usageTracker.summary(req.user!.userId, req.user!.tier);

      res.json({ success: true, result, usage });
    } catch (err: unknown) {
      console.error("[/debug/upload]", err);
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

export default router;
