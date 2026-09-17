// SMTP email, used only to deliver OTPs while no SMS provider is configured.
//
// Deliberately thin: one transport, one send. Everything about *when* an email
// is an acceptable substitute for an SMS lives in `otp-channel.ts`, not here.
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export class EmailError extends Error {
  /** True for a transport blip worth retrying; false for our misconfiguration. */
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "EmailError";
  }
}

export interface EmailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

/** Gmail's submission port. 465 is implicit TLS, which is what we use. */
const DEFAULT_PORT = 465;

function readConfig(): EmailConfig {
  const host = process.env["SMTP_HOST"]?.trim();
  const user = process.env["SMTP_USER"]?.trim();
  const password = process.env["SMTP_PASSWORD"]?.trim();
  const from = process.env["SMTP_FROM"]?.trim() || user;
  const rawPort = process.env["SMTP_PORT"]?.trim();

  const missing = [
    !host && "SMTP_HOST",
    !user && "SMTP_USER",
    !password && "SMTP_PASSWORD",
  ].filter(Boolean);
  if (missing.length || !host || !user || !password || !from) {
    throw new EmailError(`Email is not configured — missing ${missing.join(", ")}`, false);
  }

  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new EmailError(`SMTP_PORT must be a positive integer (got "${rawPort}")`, false);
  }

  return { host, port, user, password, from };
}

/** Whether the SMTP variables are present. Never reports *what* is set. */
export function hasEmailConfig(): boolean {
  try {
    readConfig();
    return true;
  } catch {
    return false;
  }
}

let transport: Transporter | null = null;

/**
 * One transport for the process.
 *
 * Nodemailer pools connections per transport, so rebuilding it per send would
 * open a new TLS session to Gmail every time and hit their connection limits.
 */
function getTransport(config: EmailConfig): Transporter {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 is implicit TLS; anything else is STARTTLS, which nodemailer
    // negotiates when `secure` is false.
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
    pool: true,
    maxConnections: 2,
  });
  return transport;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
}

/**
 * Send one plain-text email.
 *
 * Text only, on purpose: an OTP mail has nothing to lay out, and an HTML body
 * is one more place for a code to be logged by a mail client's preview cache.
 */
export async function sendMail(input: SendMailInput): Promise<void> {
  const config = readConfig();
  try {
    await getTransport(config).sendMail({
      from: config.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
  } catch (error) {
    // Auth and recipient errors are permanent; everything else is worth a retry.
    const code = (error as { responseCode?: number }).responseCode;
    const permanent = code !== undefined && code >= 500 && code < 600;
    throw new EmailError(
      error instanceof Error ? error.message : "Email delivery failed",
      !permanent,
    );
  }
}

/** Closes the pooled connections. Called from the server's shutdown path. */
export async function closeEmailTransport(): Promise<void> {
  transport?.close();
  transport = null;
}
