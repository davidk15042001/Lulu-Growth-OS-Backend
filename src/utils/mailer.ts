import { env, hasResend } from '../config/env.js';
import { logger } from '../config/logger.js';

type ResendRecipient = { email: string; name?: string };

function parseEmailFrom(from: string): ResendRecipient {
  const match = from.match(/^(.*?)<([^>]+)>$/);
  if (match && match[1] && match[2]) {
    return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
  }
  return { email: from.trim() };
}

export async function sendMail(to: string, subject: string, html: string) {
  if (!hasResend) {
    logger.warn({ to, subject }, 'RESEND_API_KEY not configured; skipping email send');
    return;
  }

  const sender = parseEmailFrom(env.EMAIL_FROM || 'LuluAI <luluai@gmail.com>');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${env.RESEND_API_KEY!}`,
    },
    body: JSON.stringify({
      from: sender.name ? `${sender.name} <${sender.email}>` : sender.email,
      to: [to],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    logger.error({ to, subject, status: response.status, detail }, 'Resend email send failed');
    throw new Error(`Resend email failed (${response.status})`);
  }

  logger.info({ to, subject }, 'Email sent via Resend');
}

export async function sendOtpEmail(to: string, code: string) {
  const html = `<p>Your verification code is:</p><h2>${code}</h2><p>This code expires soon.</p>`;
  await sendMail(to, 'Your Verification Code', html);
}

export async function sendResetEmail(to: string, code: string) {
  const html = `<p>Use this code to reset your password:</p><h2>${code}</h2><p>This code expires soon.</p>`;
  await sendMail(to, 'Password Reset', html);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]!);
}

export async function sendWorkspaceInvitationEmail(
  to: string,
  workspaceName: string,
  invitationUrl: string
) {
  const safeWorkspaceName = escapeHtml(workspaceName);
  const safeUrl = escapeHtml(invitationUrl);
  const html = [
    `<p>You have been invited to join <strong>${safeWorkspaceName}</strong> in Lulu AI.</p>`,
    `<p><a href="${safeUrl}">Accept workspace invitation</a></p>`,
    '<p>This invitation expires in seven days.</p>',
  ].join('');
  await sendMail(to, `Join ${workspaceName} in Lulu AI`, html);
}
