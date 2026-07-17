// src/types/index.ts

export type APIProvider = "openai" | "gemini" | "anthropic";

export type Tier = "free" | "starter" | "pro" | "unlimited";

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface JWTPayload {
  userId: string;
  email: string;
  tier: Tier;
  iat?: number;
  exp?: number;
}

// ── Request bodies ────────────────────────────────────────────────────────────

export interface ExtractProblemBody {
  /** Base64-encoded PNG screenshots */
  images: string[];
  language: string;
  provider: APIProvider;
  extractionModel: string;
  /** Optional: transcript/conversation context */
  conversationContext?: string;
}

export interface GenerateSolutionBody {
  problemInfo: {
    problem_statement: string;
    constraints?: string;
    example_input?: string;
    example_output?: string;
  };
  language: string;
  provider: APIProvider;
  solutionModel: string;
}

export interface DebugSolutionBody {
  /** Base64-encoded PNG screenshots (code + error screenshots) */
  images: string[];
  problemStatement: string;
  language: string;
  provider: APIProvider;
  debuggingModel: string;
}

export interface TranscribeAudioBody {
  /** Base64-encoded audio */
  audio: string;
  mimeType: string;
  provider: APIProvider;
  speechRecognitionModel?: string;
}

export interface GenerateAnswerSuggestionsBody {
  question: string;
  conversationHistory: string;
  screenshotContext?: string;
  candidateProfile?: {
    name?: string;
    resume?: string;
    jobDescription?: string;
  };
  provider: APIProvider;
  answerModel: string;
}

// ── Response shapes ───────────────────────────────────────────────────────────

export interface ProblemInfo {
  problem_statement: string;
  constraints?: string;
  example_input?: string;
  example_output?: string;
}

export interface SolutionResult {
  code: string;
  thoughts: string[];
  time_complexity: string;
  space_complexity: string;
}

export interface DebugResult {
  code: string;
  debug_analysis: string;
  thoughts: string[];
  time_complexity: string;
  space_complexity: string;
}

export interface UsageInfo {
  used: number;
  limit: number;
  tier: Tier;
  remaining: number;
}
