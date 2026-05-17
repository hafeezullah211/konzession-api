/**
 * Email sender via Brevo HTTP API.
 * Uses HTTPS port 443 - works on Railway (which blocks SMTP).
 */
import type { Config } from "../config.js";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const REQUEST_TIMEOUT_MS = 20_000;

type Transport = {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
};

/** RFC-style From header for Brevo and route callers. */
export function formatEmailFrom(cfg: Config): string | null {
  if (!cfg.EMAIL_FROM_ADDRESS) return null;
  const name = cfg.EMAIL_FROM_NAME ?? "Konzession";
  return `${name} <${cfg.EMAIL_FROM_ADDRESS}>`;
}

export function createTransport(cfg: Config): Transport | null {
  if (!cfg.BREVO_API_KEY || !cfg.EMAIL_FROM_ADDRESS) return null;

  return {
    async sendMail(opts) {
      const fromMatch = opts.from.match(/^(.*?)\s*<(.+)>$/);
      const senderName = fromMatch?.[1]?.trim() || cfg.EMAIL_FROM_NAME || "Konzession";
      const senderEmail = fromMatch?.[2]?.trim() || cfg.EMAIL_FROM_ADDRESS!;

      const body = {
        sender: { name: senderName, email: senderEmail },
        to: [{ email: opts.to }],
        subject: opts.subject,
        htmlContent: opts.html,
        textContent: opts.text,
      };

      const res = await fetch(BREVO_ENDPOINT, {
        method: "POST",
        headers: {
          "api-key": cfg.BREVO_API_KEY!,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Brevo API ${res.status}: ${errText || res.statusText}`);
      }

      const data = (await res.json()) as { messageId?: string };
      return { messageId: data.messageId ?? "unknown" };
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

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
      inquiry.whatsapp ? `<br/><strong>WhatsApp:</strong> ${escapeHtml(inquiry.whatsapp)}` : ""
    }${
      inquiry.locationDisplay ? `<br/><strong>Location:</strong> ${escapeHtml(inquiry.locationDisplay)}` : ""
    }${
      inquiry.listingSlug ? `<br/><strong>Listing slug:</strong> ${escapeHtml(inquiry.listingSlug)}` : ""
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
    "If you did not request a password reset you can safely ignore this email.",
    "",
    "— The Konzession team",
  ].join("\n");

  const safeUrl = escapeAttr(resetUrl);
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 0;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
<tr><td style="padding:28px 32px;border-bottom:1px solid #f1f5f9;">
<div style="font-size:18px;font-weight:700;color:#0f172a;">Konzession</div>
</td></tr>
<tr><td style="padding:28px 32px 8px 32px;">
<h1 style="margin:0 0 8px 0;font-size:20px;color:#0f172a;">Reset your password</h1>
<p style="margin:0 0 16px 0;font-size:14px;color:#334155;">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px 0;font-size:14px;color:#334155;">We received a request to reset the password for your Konzession account. Click the button below to choose a new password.</p>
</td></tr>
<tr><td style="padding:0 32px 24px 32px;" align="left">
<a href="${safeUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;">Reset password</a>
</td></tr>
<tr><td style="padding:0 32px 8px 32px;">
<p style="margin:0 0 8px 0;font-size:13px;color:#475569;">This link is valid for <strong>1 hour</strong>.</p>
<p style="margin:0;font-size:12px;color:#64748b;word-break:break-all;">If the button doesn't work, copy this URL into your browser:<br/><a href="${safeUrl}" style="color:#2563eb;">${escapeHtml(resetUrl)}</a></p>
</td></tr>
<tr><td style="padding:16px 32px 28px 32px;border-top:1px solid #f1f5f9;">
<p style="margin:0;font-size:12px;color:#94a3b8;">If you did not request a password reset you can safely ignore this email — your password will not change.</p>
</td></tr>
</table>
<p style="margin:16px 0 0 0;font-size:11px;color:#94a3b8;">© Konzession</p>
</td></tr>
</table>
</body></html>`;

  await transport.sendMail({
    from,
    to,
    subject: "Reset your Konzession password",
    text,
    html,
  });
}
