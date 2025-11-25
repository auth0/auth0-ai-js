import { mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { genkit, SessionData, SessionStore } from "genkit/beta";
import { gpt4o, openAI } from "genkitx-openai";
import path from "path";

export const ai = genkit({
  plugins: [openAI({ apiKey: process.env.OPENAI_API_KEY })],
  model: gpt4o,
});

/**
 * example implementation from genkit
 * https://genkit.dev/docs/chat/
 */
export class JsonSessionStore<S = any> implements SessionStore<S> {
  constructor(private readonly baseDir: string) {
    try {
      mkdirSync(baseDir, { recursive: true });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {}
  }

  async get(sessionId: string): Promise<SessionData<S> | undefined> {
    try {
      const s = await readFile(path.join(this.baseDir, `${sessionId}.json`), {
        encoding: "utf8",
      });
      const data = JSON.parse(s);
      return data;
    } catch {
      return undefined;
    }
  }

  async save(sessionId: string, sessionData: SessionData<S>): Promise<void> {
    const s = JSON.stringify(sessionData);
    await writeFile(path.join(this.baseDir, `${sessionId}.json`), s, {
      encoding: "utf8",
    });
  }
}
