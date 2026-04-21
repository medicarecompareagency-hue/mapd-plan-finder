import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  logger: true,
  debug: true,
});

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  name: string | null
) {
  await transporter.sendMail({
    from: `"MCA Plan Finder" <${process.env.SMTP_USER}>`,
    to,
    subject: "Password Reset - MCA Plan Finder",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="background: #1a3a5c; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 20px;">MCA Plan Finder</h1>
          <p style="color: #93c5fd; margin: 4px 0 0; font-size: 13px;">mcaplanfinder.xyz</p>
        </div>
        <div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 15px; margin: 0 0 16px;">
            Hi ${name || "there"},
          </p>
          <p style="color: #374151; font-size: 15px; margin: 0 0 16px;">
            We received a request to reset your password. Click the button below to set a new password. This link expires in 1 hour.
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: #1a3a5c; color: #ffffff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
              Reset Password
            </a>
          </div>
          <p style="color: #6b7280; font-size: 13px; margin: 0;">
            If you didn't request this, you can safely ignore this email. Your password will remain unchanged.
          </p>
        </div>
        <p style="text-align: center; color: #9ca3af; font-size: 11px; margin: 16px 0 0;">
          Medicare Compare Agency
        </p>
      </div>
    `,
  });
}
