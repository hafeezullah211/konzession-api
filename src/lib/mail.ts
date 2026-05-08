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
    /** Single formatted address line (structured fields or legacy label) */
    locationDisplay?: string;
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
    inquiry.locationDisplay ? `Location: ${inquiry.locationDisplay}` : null,
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
      inquiry.locationDisplay
        ? `<br/><strong>Location:</strong> ${escapeHtml(inquiry.locationDisplay)}`
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
  /** Optional display name used to personalise the greeting ("Hi Jane,"). */
  recipientName?: string;
}) {
  const { transport, from, to, resetUrl, recipientName } = opts;
  const greetingName = recipientName?.trim() || to.split("@")[0] || "there";
  const greeting = `Hi ${greetingName},`;

  const text = [
    greeting,
    "",
    "We received a request to reset the password for your Konzession account.",
    "Click the link below to choose a new password. The link is valid for 1 hour:",
    "",
    resetUrl,
    "",
    "If you did not request a password reset you can safely ignore this email — your password will not change.",
    "",
    "— The Konzession team",
  ].join("\n");

  const safeUrl = escapeAttr(resetUrl);
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;color:#111;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="padding:28px 32px;border-bottom:1px solid #f1f5f9;">
                <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#0f172a;">Konzession</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 8px 32px;">
                <h1 style="margin:0 0 8px 0;font-size:20px;line-height:1.3;color:#0f172a;">Reset your password</h1>
                <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#334155;">${escapeHtml(greeting)}</p>
                <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#334155;">
                  We received a request to reset the password for your Konzession account.
                  Click the button below to choose a new password.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;" align="left">
                <a href="${safeUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;">
                  Reset password
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 8px 32px;">
                <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#475569;">
                  This link is valid for <strong>1 hour</strong>. After that you will need to request a new one.
                </p>
                <p style="margin:0 0 16px 0;font-size:12px;line-height:1.6;color:#64748b;word-break:break-all;">
                  If the button does not work, copy and paste this URL into your browser:<br/>
                  <a href="${safeUrl}" style="color:#2563eb;">${escapeHtml(resetUrl)}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px;border-top:1px solid #f1f5f9;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;">
                  If you did not request a password reset you can safely ignore this email — your password will not change.
                </p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0 0;font-size:11px;color:#94a3b8;">© Konzession</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  await transport.sendMail({
    from,
    to,
    subject: "Reset your Konzession password",
    text,
    html,
  });
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
