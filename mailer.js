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

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;">
      <h2>Thank you${firstName ? `, ${firstName}` : ''}!</h2>
      <p>We’re honored to have your support${sponsorCompany ? ` at <strong>${sponsorCompany}</strong>` : ''}.</p>

      <h3>Sponsorship Summary</h3>
      <p><strong>Tier:</strong> ${tier}</p>
      ${seats ? `<p><strong>Seats:</strong> ${seats}</p>` : ''}
      <p><strong>Amount:</strong> $${amountTotal}${coveredFees ? ' (incl. fees)' : ''}</p>
      ${receiptUrl ? `<p><a href="${receiptUrl}">View your Stripe receipt</a></p>` : ''}

      <h3>Event Details</h3>
      <p><strong>When:</strong> ${eventDateTime}</p>
      <p><strong>Where:</strong> ${eventLocation}</p>

      ${guestFormUrl ? `
        <h3>Next Step: Guest Info</h3>
        <p>Please add your guest names and dietary needs here:</p>
        <p><a href="${guestFormUrl}" style="background:#111827;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px;">Add Guest Details</a></p>
      ` : ''}

      <p style="margin-top:20px;font-size:13px;color:#666;">
        This message was sent from <em>${process.env.EMAIL_USER}</em>.  
        For questions, reply to <a href="mailto:${process.env.EMAIL_REPLY_TO}">${process.env.EMAIL_REPLY_TO}</a>.
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,          // shows as “Best Day Ever Foundation <bestdayever.gala@gmail.com>”
    replyTo: process.env.EMAIL_REPLY_TO,   // replies go to foundation’s real inbox
    to,
    subject,
    html,
  });
}