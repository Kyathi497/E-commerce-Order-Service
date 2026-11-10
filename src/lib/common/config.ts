import { z } from "zod";

// Reads and validates env vars once at startup. A missing or malformed value
// stops the process with a list of every problem, not just the first.
export function loadConfig<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}

// Env vars are strings; these turn "true"/"1" and comma lists into real values.
export const envBool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));

export const envList = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback));

export const nodeEnv = z.enum(["development", "test", "production"]).default("development");
