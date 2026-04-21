import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const secretKey = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
if (!secretKey) {
  throw new Error(
    "Missing session secret: set SESSION_SECRET or NEXTAUTH_SECRET in the environment."
  );
}
const encodedKey = new TextEncoder().encode(secretKey);

const publicPaths = ["/login", "/reset-password", "/api/auth/login", "/api/auth/forgot-password", "/api/auth/reset-password"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths, static files, and API routes (except admin)
  if (
    publicPaths.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get("session")?.value;

  // Check if user is authenticated
  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    const { payload } = await jwtVerify(sessionCookie, encodedKey, {
      algorithms: ["HS256"],
    });

    // Protect admin routes - only admin role can access
    if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
      // Allow /admin/import with the old bearer token auth too
      if (pathname.startsWith("/api/admin") && !pathname.startsWith("/api/admin/users")) {
        return NextResponse.next();
      }
      if ((payload as { role?: string }).role !== "admin") {
        return NextResponse.redirect(new URL("/", request.url));
      }
    }

    return NextResponse.next();
  } catch {
    // Invalid session - redirect to login
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("session");
    return response;
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
