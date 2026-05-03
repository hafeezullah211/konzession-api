/**
 * SMTP transport compatible with SiteGround and most hosts:
 * - Port 465 → implicit TLS (`secure: true`)
 * - Ports 587 / 2525 → STARTTLS (`requireTLS: true`, SiteGround recommends 587)
 *
 * Configure via SMTP_* environment variables (see `config.ts`).
 */
import nodemailer from "nodemailer";
import type { Config } from "../config.js";

export function createTransport(cfg: Config) {
  if (!cfg.SMTP_HOST || !cfg.SMTP_PORT || !cfg.SMTP_FROM) return null;

  const port = cfg.SMTP_PORT;
  const secure = cfg.SMTP_SECURE ?? port === 465;
  const startTlsPorts = new Set([587, 2525]);
  const requireTLS = !secure && startTlsPorts.has(port);

  return nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port,
    secure,
    requireTLS,
    auth:
      cfg.SMTP_USER && cfg.SMTP_PASSWORD
        ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD }
        : undefined,
    tls: {
      rejectUnauthorized: cfg.SMTP_TLS_REJECT_UNAUTHORIZED !== false,
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Notify listing partner when a buyer submits an inquiry (SMTP required). */
export async function sendSellerInquiryNotification(opts: {
  transport: NonNullable<ReturnType<typeof createTransport>>;
  from: string;
  to: string;
  inquiry: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    whatsapp?: string;
    tradeInfo?: string;
    locationLabel?: string;
    listingSlug?: string;
  };
}) {
  const { transport, from, to, inquiry } = opts;
  const name = `${inquiry.firstName} ${inquiry.lastName}`.trim();
  const lines = [
    "You have a new inquiry on Konzession.",
    "",
    `Contact: ${name}`,
    `Email: ${inquiry.email}`,
    `Phone: ${inquiry.phone}`,
    inquiry.whatsapp ? `WhatsApp: ${inquiry.whatsapp}` : null,
    inquiry.locationLabel ? `Location: ${inquiry.locationLabel}` : null,
    inquiry.listingSlug ? `Listing slug: ${inquiry.listingSlug}` : null,
    inquiry.tradeInfo ? `\nMessage:\n${inquiry.tradeInfo}` : null,
    "",
    "Reply from your Konzession seller workspace under Inquiries.",
  ]
    .filter((x) => x !== null)
    .join("\n");

  await transport.sendMail({
    from,
    to,
    subject: `New Konzession inquiry from ${name}`,
    text: lines,
    html: `<p>You have a new inquiry on Konzession.</p>
<p><strong>Name:</strong> ${escapeHtml(name)}<br/>
<strong>Email:</strong> ${escapeHtml(inquiry.email)}<br/>
<strong>Phone:</strong> ${escapeHtml(inquiry.phone)}${
      inquiry.whatsapp
        ? `<br/><strong>WhatsApp:</strong> ${escapeHtml(inquiry.whatsapp)}`
        : ""
    }${
      inquiry.locationLabel
        ? `<br/><strong>Location:</strong> ${escapeHtml(inquiry.locationLabel)}`
        : ""
    }${
      inquiry.listingSlug
        ? `<br/><strong>Listing slug:</strong> ${escapeHtml(inquiry.listingSlug)}`
        : ""
    }</p>${
      inquiry.tradeInfo
        ? `<p><strong>Message:</strong><br/>${escapeHtml(inquiry.tradeInfo).replace(/\n/g, "<br/>")}</p>`
        : ""
    }<p>Open <strong>Inquiries</strong> in your workspace for the full thread.</p>`,
  });
}

export async function sendPasswordResetEmail(opts: {
  transport: NonNullable<ReturnType<typeof createTransport>>;
  from: string;
  to: string;
  resetUrl: string;
}) {
  const { transport, from, to, resetUrl } = opts;
  await transport.sendMail({
    from,
    to,
    subject: "Reset your Konzession password",
    text: `You requested a password reset.\n\nOpen this link (valid for 1 hour):\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>You requested a password reset.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in one hour.</p><p>If you did not request this, you can ignore this email.</p>`,
  });
}
