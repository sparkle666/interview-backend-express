import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const API_URL =
  process.env.API_URL ??
  "https://interview-backend-express.vercel.app/api/ai/quiz";

const TOKEN = process.env.TOKEN ?? "eyJhbGciOiJFUzI1NiIsImtpZCI6ImNjOWM5OWQyLWI2MWItNDE5NS1iZDJmLTdjYzA0ODY3MjZjOCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL3hwZGVrc3RpYnVyZXl6aGtmdHZxLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI0ZTk0MDgzNS1jOGI5LTQ5NGQtYTA1Zi1jMDU4NDM3MzBmYmUiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg0NTk0MTExLCJpYXQiOjE3ODQ1OTA1MTEsImVtYWlsIjoiYWRtaW5AYWRtaW4uY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJlbWFpbCIsInByb3ZpZGVycyI6WyJlbWFpbCJdfSwidXNlcl9tZXRhZGF0YSI6eyJlbWFpbCI6ImFkbWluQGFkbWluLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJmdWxsX25hbWUiOiJBZG1pbiBVc2VyIiwicGhvbmVfdmVyaWZpZWQiOmZhbHNlLCJzdWIiOiI0ZTk0MDgzNS1jOGI5LTQ5NGQtYTA1Zi1jMDU4NDM3MzBmYmUiLCJ0aWVyIjoic3RhcnRlciJ9LCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFhbCI6ImFhbDEiLCJhbXIiOlt7Im1ldGhvZCI6InBhc3N3b3JkIiwidGltZXN0YW1wIjoxNzg0NTkwNTExfV0sInNlc3Npb25faWQiOiJhZjQ5Zjk0Ni03MzAwLTRhY2ItYTA4NS01NGU3YTFmZjkwZDgiLCJpc19hbm9ueW1vdXMiOmZhbHNlfQ.pIbg3r9nKb2QzujWBgOawidOWto5BrEmpts-Ua76zoEtRbzWgDclKUUDuK35z6oJntQ6Kbj2rF3QpGCc_Ks_VQ";

const IMAGE_PATH = "./image.png";

async function main() {
  try {
    // Ensure image exists
    await access(IMAGE_PATH, constants.F_OK);

    // Read image as Base64
    const image = await readFile(IMAGE_PATH, {
      encoding: "base64",
    });

    console.log(`📷 Loaded image: ${path.basename(IMAGE_PATH)}`);

    const start = Date.now();

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        images: [`data:image/png;base64,${image}`],
        provider: "openai",
        extractionModel: "gpt-5.5",

      }),
    });

    const duration = Date.now() - start;

    let result;

    try {
      result = await response.json();
    } catch {
      result = await response.text();
    }

    console.log(`⏱ Request completed in ${duration} ms`);

    if (!response.ok) {
      console.error("\n❌ Request failed");
      console.error("Status:", response.status);
      console.error("Response:");
      console.dir(result, { depth: null });
      process.exit(1);
    }

    console.log("\n✅ Success");
    console.dir(result, { depth: null, colors: true });
  } catch (error) {
    console.error("\n💥 Unexpected error");

    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(error);
    }

    process.exit(1);
  }
}

main();