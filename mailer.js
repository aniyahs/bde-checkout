// mailer.js
import nodemailer from 'nodemailer';

export const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, // bestdayever.gala@gmail.com
    pass: process.env.EMAIL_PASS, // 16-char app password
  },
});

export async function sendSponsorEmail({
  to,
  buyerName,
  tier,
  seats,
  amountTotal,
  coveredFees,
  receiptUrl,
  sponsorCompany,
  eventDateTime = process.env.EVENT_WHEN,
  eventLocation = process.env.EVENT_WHERE,
  guestFormUrl = process.env.GUEST_FORM_URL,
}) {
  const subject = `Thank you for your ${tier || 'General'} Sponsorship — Best Day Ever Gala`;
  const firstName = (buyerName || '').split(' ')[0];

  // tiny helpers so we don’t render “undefined”
  const hasWhen = !!(eventDateTime && String(eventDateTime).trim());
  const hasWhere = !!(eventLocation && String(eventLocation).trim());
  const money = (n) => Number(n).toLocaleString(undefined,{minimumFractionDigits:2});

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#0f172a;">
    <h2 style="margin:0 0 8px;">Thank you${firstName ? `, ${firstName}` : ''}!</h2>
    <p style="margin:0 0 16px;">
      We’re honored to have your support${sponsorCompany ? ` at <strong>${sponsorCompany}</strong>` : ''}.
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:16px 0;">
      <h3 style="margin:0 0 8px;">Sponsorship Summary</h3>
      <p style="margin:6px 0;"><strong>Tier:</strong> ${tier || 'General'}</p>
      ${seats ? `<p style="margin:6px 0;"><strong>Seats:</strong> ${seats}</p>` : ''}
      <p style="margin:6px 0;"><strong>Amount:</strong> $${money(amountTotal)}${coveredFees ? ' <em>(you generously covered processing fees)</em>' : ''}</p>
      ${receiptUrl ? `<p style="margin:6px 0;"><a href="${receiptUrl}">View your Stripe receipt</a></p>` : ''}
    </div>

    ${(hasWhen || hasWhere) ? `
    <div style="border:1px dashed #e5e7eb;border-radius:12px;padding:16px;margin:16px 0;background:#fafafa;">
      <h3 style="margin:0 8px 8px 0;">Event Details</h3>
      ${hasWhen ? `<p style="margin:6px 0;"><strong>When:</strong> ${eventDateTime}</p>` : ''}
      ${hasWhere ? `<p style="margin:6px 0;"><strong>Where:</strong> ${eventLocation}</p>` : ''}
    </div>` : ''}

    ${guestFormUrl ? `
      <div style="border-radius:12px;padding:16px;margin:16px 0;background:#f8fafc;">
        <h3 style="margin:0 0 8px;">Next step: Guest information</h3>
        <p style="margin:6px 0;">Please add your guest names and dietary/accessibility needs so we may prepare your table.</p>
        <p style="margin:12px 0;">
          <a href="${guestFormUrl}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;">Add Guest Details</a>
        </p>
      </div>` : ''}

    <div style="margin:20px 0 0;padding:12px 14px;border-left:4px solid #111827;background:#f9fafb;border-radius:8px;">
      <p style="margin:0;font-size:13px;line-height:1.5;color:#334155;">
        Your ticket purchase may be tax-deductible as a charitable contribution to Best Day Ever Foundation,
        a 501(c)(3) non-profit organization (Tax ID: <strong>33-2892514</strong>).
        Stripe also sends an official receipt, and you can view it any time using the link above.
      </p>
    </div>

    <p style="margin:16px 0 0;color:#475569;font-size:13px;">
      This message was sent from <span style="font-family:monospace">${process.env.EMAIL_USER}</span>.
      For questions, reply to <a href="mailto:${process.env.EMAIL_REPLY_TO}">${process.env.EMAIL_REPLY_TO}</a>.
    </p>
  </div>`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    replyTo: process.env.EMAIL_REPLY_TO,
    to,
    subject,
    html,
  });
}