import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
prisma.user.findMany().then(users => {
  console.log("Users in DB: " + users.length);
  users.forEach(u => console.log("- " + u.email + " (role: " + u.role + ") hashStart: " + (u.passwordHash || "").substring(0, 7)));
}).finally(() => prisma.$disconnect());