import { NextResponse } from "next/server";
import crypto from "crypto";

export async function POST(request: Request) {
  try {
    const { prisma } = await import("@/lib/prisma");
    const { sendPasswordResetEmail } = await import("@/lib/email");
    const { email } = await request.json();

    if (!email) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    // Always return success to prevent email enumeration
    const successResponse = NextResponse.json({
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (!user) {
      return successResponse;
    }

    // Invalidate any existing unused tokens for this user
    await prisma.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Generate a secure token
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
      },
    });

    const appUrl =
      process.env.APP_URL ||
      process.env.NEXTAUTH_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
      new URL(request.url).origin;
    const resetUrl = `${appUrl.replace(/\/$/, "")}/reset-password?token=${token}`;

    try {
      await sendPasswordResetEmail(user.email, resetUrl, user.name);
    } catch (emailError: unknown) {
      const err = emailError as Error & { code?: string; command?: string; responseCode?: number; response?: string };
      console.error("=== SMTP ERROR ===");
      console.error("Message:", err.message);
      console.error("Code:", err.code);
      console.error("SMTP Response Code:", err.responseCode);
      console.error("SMTP Response:", err.response);
      console.error("Command:", err.command);
      console.error("Full error:", err);
      console.error("=== END SMTP ERROR ===");
      return NextResponse.json(
        { error: "Failed to send email. Please contact an administrator." },
        { status: 500 }
      );
    }

    return successResponse;
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
