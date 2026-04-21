import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = "medicarecompareagency@gmail.com";
  const password = "Admin2024!";
  const name = "Admin";
  const role = "admin";

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log(`Admin account already exists: ${email}`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.user.create({
    data: { email, name, passwordHash, role },
  });

  console.log(`Default admin account created: ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
