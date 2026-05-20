import { createHash } from "node:crypto";
import { env, csvEnv } from "@/app/lib/env";

function toOpenSshSha256Fingerprint(rawHostKey: Buffer) {
  return `SHA256:${createHash("sha256").update(rawHostKey).digest("base64").replace(/=+$/, "")}`;
}

export async function sshExec(command: string): Promise<string> {
  "use step";

  const { Client } = await import("ssh2");

  const host = env("SSH_HOST");
  const user = env("SSH_USER");
  const port = Number(env("SSH_PORT") ?? "22");

  const rawKey = env("SSH_PRIVATE_KEY");
  const privateKey =
    rawKey?.includes("BEGIN OPENSSH PRIVATE KEY")
      ? rawKey
      : Buffer.from(rawKey ?? "", "base64").toString("utf8");

  const expectedFingerprint = (env("SSH_HOST_KEY_SHA256") ?? "").trim();

  if (!host || !user) {
    throw new Error("SSH not configured (SSH_HOST/SSH_USER).");
  }
  if (!privateKey) {
    throw new Error("SSH private key missing.");
  }

  const allowedPrefixes = csvEnv("SSH_ALLOWED_PREFIXES");
  if (
    allowedPrefixes.length > 0 &&
    !allowedPrefixes.some((p) => command.startsWith(p))
  ) {
    throw new Error(
      `SSH command not allowed by policy. Allowed prefixes: ${allowedPrefixes.join(", ")}`
    );
  }

  return await new Promise((resolve, reject) => {
    const conn = new Client();

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          let output = "";

          stream.on("data", (data: Buffer) => {
            output += data.toString();
          });

          stream.stderr.on("data", (data: Buffer) => {
            output += data.toString();
          });

          stream.on("close", () => {
            conn.end();
            resolve(output);
          });
        });
      })
      .on("error", reject)
      .connect({
        host,
        port,
        username: user,
        privateKey,
        algorithms: {
          serverHostKey: ["ssh-ed25519"],
        },
        hostVerifier: (key: Buffer) => {
          const actual = toOpenSshSha256Fingerprint(key);
          console.log("SSH host fingerprint:", actual);
          return actual === expectedFingerprint;
        },
      });
  });
}
