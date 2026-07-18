// src/services/aiService.ts
//
// This is the extracted brain of ProcessingHelper.ts, AnswerAssistant.ts,
// and TranscriptionHelper.ts — now running on the server with the API keys
// held server-side instead of in the client app.

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import {
  APIProvider,
  ProblemInfo,
  SolutionResult,
  DebugResult,
} from "../types";

// ── Quiz types ────────────────────────────────────────────────────────────────

export interface QuizQuestion {
  question: string;
  questionNumber: number;
  answer: string;
  explanation: string;
  options?: string[];
  correctOption?: string;
  questionType: "multiple_choice" | "true_false" | "short_answer" | "essay";
}

export interface QuizResult {
  totalQuestions: number;
  questions: QuizQuestion[];
  subject?: string | null;
  instructions?: string | null;
}

// ── Gemini types ──────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> };
    finishReason: string;
  }>;
}

// ── Client factory (stateless — built per request from env keys) ──────────────

function makeOpenAI(): OpenAI {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set on server");
  return new OpenAI({ apiKey: key, timeout: 60_000, maxRetries: 2 });
}

function makeAnthropic(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set on server");
  return new Anthropic({ apiKey: key, timeout: 60_000, maxRetries: 2 });
}

function getGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set on server");
  return key;
}

function stripJsonFences(text: string): string {
  return text.replace(/```json|```/g, "").trim();
}

const OPENAI_MODEL = "gpt-5.5";

function formatError(provider: APIProvider, error: unknown, context: string): string {
  const e = error as Record<string, unknown>;
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof (e?.response as Record<string, unknown>)?.status === "number"
        ? (e.response as Record<string, unknown>).status
        : undefined;
  const msg = e?.message as string | undefined;
  const responseData = (e?.response as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const apiMsg = (responseData?.error as Record<string, unknown>)?.message as string | undefined;
  const message = msg || apiMsg || "Unknown error";
  return `[${provider}] ${context} failed${status ? ` (status ${status})` : ""}: ${message}`;
}

// ── 1. Extract problem from screenshots ───────────────────────────────────────

export async function extractProblem(
  images: string[],
  language: string,
  provider: APIProvider,
  extractionModel: string,
  conversationContext?: string
): Promise<ProblemInfo> {
  const basePrompt = conversationContext
    ? `Extract the coding problem from these screenshots. Conversation context:\n\n${conversationContext}\n\nReturn JSON with: problem_statement, constraints, example_input, example_output. No extra text. Language: ${language}.`
    : `Extract the coding problem from these screenshots. Return JSON with: problem_statement, constraints, example_input, example_output. No extra text. Language: ${language}.`;

  if (provider === "openai") {
    const client = makeOpenAI();
    const content: OpenAI.Responses.ResponseInputMessageContentList = [
      {
        type: "input_text" as const,
        text: basePrompt,
      },
      ...images.map((data) => ({
        type: "input_image" as const,
        image_url: `data:image/png;base64,${data}`,
        detail: "auto" as const,
      })),
    ];

    const response = await client.responses.create({
      model: OPENAI_MODEL,
      instructions:
        "You are a coding challenge interpreter. Return only valid JSON with: problem_statement, constraints, example_input, example_output.",
      input: [
        {
          role: "user",
          content,
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
      max_output_tokens: 4000,
      temperature: 1,
    });
    const text = response.output_text ?? "";
    console.log(`[AI Service] OpenAI extract finished`, {
      textLength: text.length,
    });
    return JSON.parse(stripJsonFences(text));
  }

  if (provider === "gemini") {
    const key = getGeminiKey();
    const parts: GeminiPart[] = [
      { text: basePrompt },
      ...images.map((data) => ({ inlineData: { mimeType: "image/png", data } })),
    ];
    const res = await axios.post<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${extractionModel || "gemini-2.0-flash"}:generateContent?key=${key}`,
      {
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
      }
    );
    const text = res.data.candidates[0].content.parts[0].text;
    return JSON.parse(stripJsonFences(text));
  }

  if (provider === "anthropic") {
    const client = makeAnthropic();
    const response = await client.messages.create({
      model: extractionModel || "claude-3-7-sonnet-20250219",
      max_tokens: 4000,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: basePrompt },
            ...images.map((data) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: "image/png" as const, data },
            })),
          ],
        },
      ],
    });
    const text = (response.content[0] as { type: "text"; text: string }).text;
    return JSON.parse(stripJsonFences(text));
  }

  throw new Error(`Unknown provider: ${provider}`);
}

// ── 2. Generate solution ──────────────────────────────────────────────────────

export async function generateSolution(
  problemInfo: ProblemInfo,
  language: string,
  provider: APIProvider,
  solutionModel: string
): Promise<SolutionResult> {
  const prompt = `
Generate a detailed solution for this coding problem:

PROBLEM: ${problemInfo.problem_statement}
CONSTRAINTS: ${problemInfo.constraints || "None provided"}
EXAMPLE INPUT: ${problemInfo.example_input || "None provided"}
EXAMPLE OUTPUT: ${problemInfo.example_output || "None provided"}
LANGUAGE: ${language}

Respond with:
1. Code: clean optimized implementation in ${language}
2. Your Thoughts: key insights as bullet points
3. Time complexity: O(X) with at least 2 sentences of explanation
4. Space complexity: O(X) with at least 2 sentences of explanation
`;

  let responseContent: string;

  if (provider === "openai") {
    const client = makeOpenAI();
    const res = await client.chat.completions.create({
      model: OPENAI_MODEL,
      max_completion_tokens: 4000,
      temperature: 1,
      messages: [
        {
          role: "system",
          content:
            "You are an expert coding interview assistant. Provide clear, optimal solutions with detailed explanations.",
        },
        { role: "user", content: prompt },
      ],
    });
    responseContent = res.choices[0].message.content ?? "";
    console.log(`[AI Service] OpenAI solve finished`, {
      responseLength: responseContent.length,
    });
  } else if (provider === "gemini") {
    const key = getGeminiKey();
    const res = await axios.post<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${solutionModel || "gemini-2.0-flash"}:generateContent?key=${key}`,
      {
        contents: [{ role: "user", parts: [{ text: `You are an expert coding interview assistant.\n\n${prompt}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
      }
    );
    responseContent = res.data.candidates[0].content.parts[0].text;
  } else if (provider === "anthropic") {
    const client = makeAnthropic();
    const res = await client.messages.create({
      model: solutionModel || "claude-3-7-sonnet-20250219",
      max_tokens: 4000,
      temperature: 0.2,
      messages: [{ role: "user", content: `You are an expert coding interview assistant.\n\n${prompt}` }],
    });
    responseContent = (res.content[0] as { type: "text"; text: string }).text;
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  return parseSolutionResponse(responseContent);
}

function parseSolutionResponse(content: string): SolutionResult {
  const codeMatch = content.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  const code = codeMatch ? codeMatch[1].trim() : content;

  const thoughtsMatch = content.match(
    /(?:Thoughts:|Key Insights:|Reasoning:|Approach:)([\s\S]*?)(?:Time complexity:|$)/i
  );
  let thoughts: string[] = [];
  if (thoughtsMatch?.[1]) {
    const bullets = thoughtsMatch[1].match(/(?:^|\n)\s*(?:[-*•]|\d+\.)\s*(.*)/g);
    thoughts = bullets
      ? bullets.map((p) => p.replace(/^\s*(?:[-*•]|\d+\.)\s*/, "").trim()).filter(Boolean)
      : thoughtsMatch[1].split("\n").map((l) => l.trim()).filter(Boolean);
  }

  const timeMatch = content.match(
    /Time complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:Space complexity|$))/i
  );
  const spaceMatch = content.match(
    /Space complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:[A-Z]|$))/i
  );

  const enrichComplexity = (raw: string | undefined, fallback: string): string => {
    if (!raw) return fallback;
    const t = raw.trim();
    if (!t.match(/O\([^)]+\)/i)) return `O(n) - ${t}`;
    if (!t.includes("-") && !t.includes("because")) {
      const m = t.match(/O\([^)]+\)/i);
      return m ? `${m[0]} - ${t.replace(m[0], "").trim()}` : t;
    }
    return t;
  };

  return {
    code,
    thoughts: thoughts.length > 0 ? thoughts : ["Solution approach based on efficiency and readability"],
    time_complexity: enrichComplexity(
      timeMatch?.[1],
      "O(n) - Linear time complexity because we iterate through the input once."
    ),
    space_complexity: enrichComplexity(
      spaceMatch?.[1],
      "O(n) - Linear space complexity because we may store up to n elements."
    ),
  };
}

// ── 3. Debug solution ─────────────────────────────────────────────────────────

export async function debugSolution(
  images: string[],
  problemStatement: string,
  language: string,
  provider: APIProvider,
  debuggingModel: string
): Promise<DebugResult> {
  const systemPrompt = `You are a coding interview assistant. Analyze screenshots that include error messages, incorrect outputs, or test cases and provide detailed debugging help.

Your response MUST follow this exact structure:
### Issues Identified
- bullet points

### Specific Improvements and Corrections
- bullet points

### Optimizations
- bullet points

### Explanation of Changes Needed
paragraph

### Key Points
- bullet points

Use markdown code blocks with language tags for any code examples.`;

  const userPrompt = `I'm solving: "${problemStatement}" in ${language}. Help me debug. Screenshots attached.`;

  let debugContent: string;

  if (provider === "openai") {
    const client = makeOpenAI();
    const res = await client.chat.completions.create({
      model: OPENAI_MODEL,
      max_completion_tokens: 4000,
      temperature: 1,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            ...images.map((data) => ({
              type: "image_url" as const,
              image_url: { url: `data:image/png;base64,${data}` },
            })),
          ],
        },
      ],
    });
    debugContent = res.choices[0].message.content ?? "";
  } else if (provider === "gemini") {
    const key = getGeminiKey();
    const parts: GeminiPart[] = [
      { text: `${systemPrompt}\n\n${userPrompt}` },
      ...images.map((data) => ({ inlineData: { mimeType: "image/png", data } })),
    ];
    const res = await axios.post<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${debuggingModel || "gemini-2.0-flash"}:generateContent?key=${key}`,
      {
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
      }
    );
    debugContent = res.data.candidates[0].content.parts[0].text;
  } else if (provider === "anthropic") {
    const client = makeAnthropic();
    const res = await client.messages.create({
      model: debuggingModel || "claude-3-7-sonnet-20250219",
      max_tokens: 4000,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${systemPrompt}\n\n${userPrompt}` },
            ...images.map((data) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: "image/png" as const, data },
            })),
          ],
        },
      ],
    });
    debugContent = (res.content[0] as { type: "text"; text: string }).text;
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const codeMatch = debugContent.match(/```(?:[a-zA-Z]+)?([\s\S]*?)```/);
  const code = codeMatch ? codeMatch[1].trim() : "// See debug analysis below";

  const bullets = debugContent.match(/(?:^|\n)[ ]*(?:[-*•]|\d+\.)[ ]+([^\n]+)/g);
  const thoughts = bullets
    ? bullets.map((p) => p.replace(/^[ ]*(?:[-*•]|\d+\.)[ ]+/, "").trim()).slice(0, 5)
    : ["Debug analysis based on your screenshots"];

  return {
    code,
    debug_analysis: debugContent,
    thoughts,
    time_complexity: "N/A - Debug mode",
    space_complexity: "N/A - Debug mode",
  };
}

// ── 4. Transcribe audio ───────────────────────────────────────────────────────

export async function transcribeAudio(
  audioBase64: string,
  mimeType: string,
  provider: APIProvider,
  model?: string
): Promise<{ text: string; language?: string }> {
  const audioBuffer = Buffer.from(audioBase64, "base64");

  if (provider === "openai") {
    const client = makeOpenAI();
    const { Readable } = await import("stream");
    const stream = Readable.from(audioBuffer);
    // @ts-expect-error — openai SDK accepts ReadableStream with name
    stream.name = `audio.${mimeType.split("/")[1] || "webm"}`;
    const result = await client.audio.transcriptions.create({
      file: stream as unknown as File,
      model: model || "whisper-1",
    });
    return { text: result.text };
  }

  if (provider === "gemini") {
    const key = getGeminiKey();
    const res = await axios.post<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-2.0-flash"}:generateContent?key=${key}`,
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: "Please transcribe this audio accurately." },
              { inlineData: { mimeType, data: audioBase64 } },
            ],
          },
        ],
      }
    );
    return { text: res.data.candidates[0].content.parts[0].text };
  }

  throw new Error(`Transcription not supported for provider: ${provider}`);
}

// ── 5. Generate answer suggestions (interview Q&A mode) ───────────────────────

export async function generateAnswerSuggestions(
  question: string,
  conversationHistory: string,
  provider: APIProvider,
  answerModel: string,
  screenshotContext?: string,
  candidateProfile?: { name?: string; resume?: string; jobDescription?: string }
): Promise<{ suggestions: string[]; reasoning: string }> {
  const profileSection = candidateProfile?.resume
    ? `\nCandidate background:\nName: ${candidateProfile.name || "Not provided"}\nResume: ${candidateProfile.resume}\nJob: ${candidateProfile.jobDescription || "Not provided"}`
    : "";

  const prompt = `You are an expert interview coach helping a candidate answer questions in real-time.

Conversation so far:
${conversationHistory || "No conversation yet."}
${profileSection}
${screenshotContext ? `\nAdditional context from screen:\n${screenshotContext}` : ""}

Current question: "${question}"

Provide 3 distinct answer suggestions that are natural and conversational. Return JSON:
{
  "suggestions": ["suggestion 1", "suggestion 2", "suggestion 3"],
  "reasoning": "brief explanation of the approach"
}`;

  let text: string;

  if (provider === "openai") {
    const client = makeOpenAI();
    const res = await client.chat.completions.create({
      model: OPENAI_MODEL,
      max_completion_tokens: 1000,
      temperature: 0.8,
      messages: [{ role: "user", content: prompt }],
    });
    text = res.choices[0].message.content ?? "{}";
  } else if (provider === "gemini") {
    const key = getGeminiKey();
    const res = await axios.post<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${answerModel || "gemini-2.0-flash"}:generateContent?key=${key}`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 1000 },
      }
    );
    text = res.data.candidates[0].content.parts[0].text;
  } else if (provider === "anthropic") {
    const client = makeAnthropic();
    const res = await client.messages.create({
      model: answerModel || "claude-3-7-sonnet-20250219",
      max_tokens: 1000,
      temperature: 0.8,
      messages: [{ role: "user", content: prompt }],
    });
    text = (res.content[0] as { type: "text"; text: string }).text;
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  try {
    const parsed = JSON.parse(stripJsonFences(text));
    return {
      suggestions: parsed.suggestions || [],
      reasoning: parsed.reasoning || "",
    };
  } catch {
    return { suggestions: [text], reasoning: "" };
  }
}

// ── 6. Solve quiz from screenshots ───────────────────────────────────────────

export async function solveQuiz(
  images: string[],
  provider: APIProvider,
  extractionModel: string
): Promise<QuizResult> {
  const systemPrompt = `You are an expert quiz solver. You will be given screenshots of quiz/exam questions.
Your task is to:
1. Extract ALL questions visible in the screenshots
2. Identify the question type (multiple_choice, true_false, short_answer, essay)
3. For multiple choice questions, identify the correct option (A, B, C, or D)
4. Provide a clear answer and brief explanation for each question

Return ONLY a valid JSON object with this exact structure (no markdown, no code fences):
{
  "subject": "subject or topic name if visible, or null",
  "instructions": "general instructions if visible, or null",
  "totalQuestions": <number>,
  "questions": [
    {
      "questionNumber": <number>,
      "questionType": "multiple_choice" | "true_false" | "short_answer" | "essay",
      "question": "the full question text",
      "options": ["A. option1", "B. option2", "C. option3", "D. option4"] or null,
      "correctOption": "A" or "B" or "C" or "D" or "True" or "False" or null,
      "answer": "the complete answer",
      "explanation": "brief explanation of why this is correct"
    }
  ]
}`;

  const userPrompt = `Please extract and solve ALL quiz questions from these screenshots. Return only the JSON object.`;

  let rawText: string;

  if (provider === "openai") {
    const client = makeOpenAI();
    const content: OpenAI.Responses.ResponseInputMessageContentList = [
      {
        type: "input_text" as const,
        text: userPrompt,
      },
      ...images.map((data) => ({
        type: "input_image" as const,
        image_url: `data:image/png;base64,${data}`,
        detail: "auto" as const,
      })),
    ];

    const response = await client.responses.create({
      model: OPENAI_MODEL,
      instructions: systemPrompt,
      input: [
        {
          role: "user",
          content,
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
      max_output_tokens: 4000,
      temperature: 1,
    });
    rawText = response.output_text ?? "";
    console.log(`[AI Service] OpenAI quiz finished`, {
      responseLength: rawText.length,
    });
  } else if (provider === "gemini") {
    const key = getGeminiKey();
    const parts: GeminiPart[] = [
      { text: `${systemPrompt}\n\n${userPrompt}` },
      ...images.map((data) => ({ inlineData: { mimeType: "image/png", data } })),
    ];
    const res = await axios.post<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${extractionModel || "gemini-2.0-flash"}:generateContent?key=${key}`,
      {
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4000 },
      }
    );
    rawText = res.data.candidates[0].content.parts[0].text;
  } else if (provider === "anthropic") {
    const client = makeAnthropic();
    const response = await client.messages.create({
      model: extractionModel || "claude-3-7-sonnet-20250219",
      max_tokens: 4000,
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${systemPrompt}\n\n${userPrompt}` },
            ...images.map((data) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: "image/png" as const, data },
            })),
          ],
        },
      ],
    });
    rawText = (response.content[0] as { type: "text"; text: string }).text;
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const cleaned = stripJsonFences(rawText);
  const parsed = JSON.parse(cleaned) as QuizResult;

  if (!parsed.questions || !Array.isArray(parsed.questions)) {
    throw new Error("Failed to extract questions. Ensure screenshots contain visible quiz questions.");
  }

  parsed.totalQuestions = parsed.questions.length;
  return parsed;
}
